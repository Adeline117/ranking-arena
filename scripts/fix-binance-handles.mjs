import pg from 'pg';
import { ProxyAgent } from 'undici';

const proxy = new ProxyAgent('http://127.0.0.1:7890');
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rows = await db.query(`SELECT id, source_trader_id, handle FROM trader_sources WHERE source='binance_futures' AND handle ~ '^\\d+$'`);
console.log(`Found ${rows.rows.length} binance traders with numeric handles`);

for (const row of rows.rows) {
  try {
    const url = `https://www.binance.com/bapi/futures/v2/public/future/leaderboard/getOtherLeaderboardBaseInfo?encryptedUid=${row.source_trader_id}`;
    const res = await fetch(url, {
      dispatcher: proxy,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await res.json();
    const nick = data?.data?.nickName;
    if (nick && nick !== row.handle) {
      await db.query(`UPDATE trader_sources SET handle=$1 WHERE id=$2`, [nick, row.id]);
      console.log(`✅ ${row.id}: "${row.handle}" → "${nick}"`);
    } else {
      console.log(`⏭️ ${row.id}: no change (nick=${nick}, code=${data?.code})`);
    }
  } catch (e) {
    console.error(`❌ ${row.id}: ${e.message}`);
  }
}
await db.end();
