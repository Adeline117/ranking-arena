/**
 * Phase 3 v2: Self-backfill + batch updates via direct SQL through DATABASE_URL
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function main() {
  const client = await pool.connect();
  
  const sources = ['gains', 'gateio', 'dydx', 'aevo', 'phemex', 'bitfinex', 'bitget_futures'];
  let grandTotal = 0;

  for (const src of sources) {
    // Single SQL: update null WR rows from same-trader rows that have WR
    const result = await client.query(`
      UPDATE leaderboard_ranks lr
      SET 
        win_rate = COALESCE(lr.win_rate, ref.win_rate),
        trades_count = COALESCE(lr.trades_count, ref.trades_count),
        max_drawdown = COALESCE(lr.max_drawdown, ref.max_drawdown)
      FROM (
        SELECT DISTINCT ON (source_trader_id)
          source_trader_id, win_rate, trades_count, max_drawdown
        FROM leaderboard_ranks
        WHERE source = $1 AND win_rate IS NOT NULL
        ORDER BY source_trader_id, season_id
      ) ref
      WHERE lr.source = $1
        AND lr.win_rate IS NULL
        AND lr.source_trader_id = ref.source_trader_id
    `, [src]);
    
    console.log(`${src}: self-backfilled ${result.rowCount} rows`);
    grandTotal += result.rowCount;
  }

  // Also backfill from trader_snapshots
  console.log('\n--- Backfill from trader_snapshots ---');
  for (const src of sources) {
    const result = await client.query(`
      UPDATE leaderboard_ranks lr
      SET 
        win_rate = COALESCE(lr.win_rate, ts.win_rate),
        trades_count = COALESCE(lr.trades_count, ts.trades_count),
        max_drawdown = COALESCE(lr.max_drawdown, ts.max_drawdown)
      FROM (
        SELECT DISTINCT ON (source_trader_id)
          source, source_trader_id, win_rate, trades_count, max_drawdown
        FROM trader_snapshots
        WHERE source = $1 AND win_rate IS NOT NULL
        ORDER BY source_trader_id, captured_at DESC
      ) ts
      WHERE lr.source = $1
        AND lr.win_rate IS NULL
        AND lr.source_trader_id = ts.source_trader_id
    `, [src]);
    
    if (result.rowCount > 0) {
      console.log(`${src}: snapshot-backfilled ${result.rowCount} rows`);
      grandTotal += result.rowCount;
    }
  }

  // Final count
  const { rows } = await client.query(`
    SELECT source, COUNT(*) as null_count
    FROM leaderboard_ranks
    WHERE win_rate IS NULL
    AND source IN ('gains','gateio','dydx','aevo','phemex','bitfinex','bitget_futures')
    GROUP BY source
    ORDER BY null_count DESC
  `);
  
  console.log('\n--- Remaining null WR after all backfills ---');
  let remaining = 0;
  for (const r of rows) {
    console.log(`${r.source}: ${r.null_count}`);
    remaining += parseInt(r.null_count);
  }
  console.log(`Total remaining: ${remaining}`);
  console.log(`Total backfilled this run: ${grandTotal}`);

  client.release();
  await pool.end();
}

main().catch(console.error);
