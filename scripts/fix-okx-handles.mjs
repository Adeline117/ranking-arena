import pg from 'pg';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rows = await db.query(`SELECT id, source, source_trader_id, handle FROM trader_sources WHERE source IN ('okx_futures','okx_web3') AND handle ~ '^\\d+$'`);
console.log(`Found ${rows.rows.length} OKX traders with numeric handles`);

for (const row of rows.rows) {
  try {
    const url = `https://www.okx.com/api/v5/copytrading/public/lead-trader-info?uniqueName=${row.source_trader_id}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    const data = await res.json();
    const nick = data?.data?.[0]?.nickName || data?.data?.[0]?.leadTraderName;
    if (nick && nick !== row.handle) {
      await db.query(`UPDATE trader_sources SET handle=$1 WHERE id=$2`, [nick, row.id]);
      console.log(`✅ ${row.id} (${row.source}): "${row.handle}" → "${nick}"`);
    } else {
      console.log(`⏭️ ${row.id}: no change (data=${JSON.stringify(data).slice(0,200)})`);
    }
  } catch (e) {
    console.error(`❌ ${row.id}: ${e.message}`);
  }
}
await db.end();
