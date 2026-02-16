import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const DELAY = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, timeout = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch { clearTimeout(timer); return null; }
}

async function main() {
  const client = await pool.connect();
  
  const { rows } = await client.query(`
    SELECT DISTINCT source_trader_id 
    FROM trader_snapshots 
    WHERE source = 'aevo' 
      AND (win_rate IS NULL OR trades_count IS NULL OR max_drawdown IS NULL)
  `);
  console.log(`Aevo addresses needing enrichment: ${rows.length}`);
  
  let updated = 0, failed = 0, noData = 0;

  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].source_trader_id;
    
    const stats = await fetchJSON(`https://api.aevo.xyz/statistics?account=${encodeURIComponent(id)}`);
    
    if (!stats) { failed++; await sleep(DELAY); continue; }

    const updateFields = {};
    
    // Check what fields are available
    if (stats.winRate != null) {
      const wr = parseFloat(stats.winRate);
      if (!isNaN(wr)) updateFields.win_rate = Math.round(wr * 10000) / 100;
    }
    if (stats.totalTrades != null) {
      updateFields.trades_count = parseInt(stats.totalTrades);
    }
    // MDD might not be available from this endpoint
    if (stats.maxDrawdown != null) {
      updateFields.max_drawdown = parseFloat(stats.maxDrawdown);
    }

    if (Object.keys(updateFields).length === 0) { noData++; await sleep(DELAY); continue; }

    const sets = [];
    const vals = [];
    let idx = 1;
    for (const [k, v] of Object.entries(updateFields)) {
      sets.push(`${k} = $${idx}`);
      vals.push(v);
      idx++;
    }
    vals.push(id);
    
    const result = await client.query(
      `UPDATE trader_snapshots SET ${sets.join(', ')} WHERE source = 'aevo' AND source_trader_id = $${idx}`,
      vals
    );
    updated += result.rowCount;

    if ((i + 1) % 20 === 0) console.log(`${i + 1}/${rows.length} | updated: ${updated} | noData: ${noData} | failed: ${failed}`);
    await sleep(DELAY);
  }

  console.log(`\nDone! Updated: ${updated}, NoData: ${noData}, Failed: ${failed}`);

  const verify = await client.query(`
    SELECT 
      COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null,
      COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null,
      COUNT(*) FILTER (WHERE trades_count IS NULL) as tc_null,
      COUNT(*) as total
    FROM trader_snapshots WHERE source = 'aevo'
  `);
  console.log('Remaining gaps:', verify.rows[0]);

  client.release();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
