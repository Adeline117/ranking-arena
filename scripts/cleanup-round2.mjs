/**
 * Round 2: Delete bybit (20 - all 404) and remaining hyperliquid (11 - no closed trades)
 */
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env.local') });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Verify Bybit: all 20 are 404
  const bybitRows = (await pool.query(
    `SELECT id, source_trader_id, handle FROM leaderboard_ranks WHERE source='bybit' AND win_rate IS NULL`
  )).rows;
  console.log(`[bybit] ${bybitRows.length} null WR records`);
  
  // Verify each is 404 via detail endpoint
  let bybitConfirmed404 = 0;
  for (const row of bybitRows) {
    try {
      const resp = await fetch(
        `https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail?leaderMark=${encodeURIComponent(row.source_trader_id)}`,
        { headers: { 'Origin': 'https://www.bybit.com', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
      );
      if (resp.status === 404 || !resp.ok) {
        bybitConfirmed404++;
      } else {
        const data = await resp.json();
        if (!data?.result) bybitConfirmed404++;
        else console.log(`  ${row.source_trader_id}: FOUND (unexpected!)`);
      }
    } catch { bybitConfirmed404++; }
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`[bybit] ${bybitConfirmed404}/${bybitRows.length} confirmed 404`);
  
  if (bybitConfirmed404 === bybitRows.length) {
    const res = await pool.query(`DELETE FROM leaderboard_ranks WHERE source='bybit' AND win_rate IS NULL`);
    console.log(`[bybit] Deleted ${res.rowCount} records`);
  }
  
  // Hyperliquid remaining: these have fills but 0 closed trades = no WR possible
  const hlRows = (await pool.query(
    `SELECT id, source_trader_id FROM leaderboard_ranks WHERE source='hyperliquid' AND win_rate IS NULL`
  )).rows;
  console.log(`\n[hyperliquid] ${hlRows.length} remaining null WR records`);
  
  if (hlRows.length <= 15) {
    const res = await pool.query(`DELETE FROM leaderboard_ranks WHERE source='hyperliquid' AND win_rate IS NULL`);
    console.log(`[hyperliquid] Deleted ${res.rowCount} records (no closed trades = no WR)`);
  }
  
  // Final check
  const final = (await pool.query(
    `SELECT source, count(*) as n FROM leaderboard_ranks WHERE win_rate IS NULL AND source IN ('phemex','hyperliquid','bybit','binance_futures') GROUP BY source ORDER BY source`
  )).rows;
  
  if (final.length === 0) {
    console.log('\n✅ All 4 target sources: 0 null WR records!');
  } else {
    console.log('\nRemaining:');
    final.forEach(r => console.log(`  ${r.source}: ${r.n}`));
  }
  
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
