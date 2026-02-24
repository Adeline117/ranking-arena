import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const DB = process.env.DATABASE_URL || 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres';
const pool = new pg.Pool({ connectionString: DB, max: 5 });
const CHAIN_ID = 42161;
const CONCURRENCY = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, timeout = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return res.json();
  } catch (e) { clearTimeout(timer); return null; }
}

async function processOne(row) {
  const { id, source_trader_id: addr } = row;
  const stats = await fetchJSON(
    `https://backend-global.gains.trade/api/personal-trading-history/${addr}/stats?chainId=${CHAIN_ID}`
  );

  if (!stats || stats.error) return 'failed';

  const winRate = parseFloat(stats.winRate);
  if (isNaN(winRate)) return 'noData';

  const wr = Math.round(winRate * 100) / 100;
  const sets = ['win_rate = $1'];
  const vals = [wr];
  let idx = 2;

  if (stats.totalTrades != null) {
    sets.push(`trades_count = $${idx}`);
    vals.push(parseInt(stats.totalTrades));
    idx++;
  }

  vals.push(id);
  await pool.query(
    `UPDATE leaderboard_ranks SET ${sets.join(', ')} WHERE id = $${idx}`,
    vals
  );
  return 'ok';
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, source_trader_id 
    FROM leaderboard_ranks 
    WHERE source = 'gains' AND win_rate IS NULL
    ORDER BY id
  `);
  console.log(`Total to enrich: ${rows.length}`);

  let updated = 0, failed = 0, noData = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(r => processOne(r)));
    
    for (const r of results) {
      if (r === 'ok') updated++;
      else if (r === 'failed') failed++;
      else if (r === 'noData') noData++;
    }

    if ((i + CONCURRENCY) % 50 < CONCURRENCY || i + CONCURRENCY >= rows.length) {
      console.log(`${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} | updated: ${updated} | noData: ${noData} | failed: ${failed}`);
    }
    
    await sleep(100);
  }

  console.log(`\nDone! Updated: ${updated}, NoData: ${noData}, Failed: ${failed}`);

  const verify = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null, COUNT(*) as total
    FROM leaderboard_ranks WHERE source = 'gains'
  `);
  console.log('Remaining:', verify.rows[0]);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
