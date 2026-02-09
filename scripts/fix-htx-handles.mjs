import pg from 'pg';
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rows = await db.query(`SELECT id, source_trader_id, handle FROM trader_sources WHERE source='htx_futures' AND handle ~ '^\\d+$'`);
console.log(`Found ${rows.rows.length} HTX traders with numeric handles`);

for (const row of rows.rows) {
  try {
    // source_trader_id is base64-encoded user ID
    const url = `https://www.htx.com/rankApi/v1/user/info?uid=${row.source_trader_id}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    const data = await res.json();
    const nick = data?.data?.nickName || data?.data?.userName;
    if (nick && nick !== row.handle) {
      await db.query(`UPDATE trader_sources SET handle=$1 WHERE id=$2`, [nick, row.id]);
      console.log(`✅ ${row.id}: "${row.handle}" → "${nick}"`);
    } else {
      console.log(`⏭️ ${row.id}: no change (data=${JSON.stringify(data).slice(0,300)})`);
    }
  } catch (e) {
    console.error(`❌ ${row.id}: ${e.message}`);
  }
}
await db.end();
