/**
 * Final cleanup: Delete leaderboard_ranks rows where win_rate is null
 * and no enrichment source exists (no WR in snapshots or other LR rows).
 * 
 * Only deletes for the 7 target sources.
 * Logs everything before deleting.
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function main() {
  const client = await pool.connect();
  
  const sources = ['gains', 'gateio', 'dydx', 'aevo', 'phemex', 'bitfinex', 'bitget_futures'];
  
  console.log('=== Pre-deletion status ===');
  const { rows: pre } = await client.query(`
    SELECT source, count(*) as null_count
    FROM leaderboard_ranks
    WHERE win_rate IS NULL AND source = ANY($1)
    GROUP BY source ORDER BY null_count DESC
  `, [sources]);
  let preTotal = 0;
  for (const r of pre) { console.log(`  ${r.source}: ${r.null_count}`); preTotal += parseInt(r.null_count); }
  console.log(`  Total: ${preTotal}\n`);

  // For each source, find truly dead rows (no WR anywhere for that trader)
  let grandDeleted = 0;
  
  for (const src of sources) {
    // Find traders that have NO win_rate in any row (LR or snapshots)
    const { rows: deadTraders } = await client.query(`
      SELECT DISTINCT lr.source_trader_id
      FROM leaderboard_ranks lr
      WHERE lr.source = $1 AND lr.win_rate IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM leaderboard_ranks lr2
          WHERE lr2.source = $1 AND lr2.source_trader_id = lr.source_trader_id AND lr2.win_rate IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM trader_snapshots ts
          WHERE ts.source = $1 AND ts.source_trader_id = lr.source_trader_id AND ts.win_rate IS NOT NULL
        )
    `, [src]);

    if (!deadTraders.length) {
      console.log(`${src}: no dead traders to delete`);
      continue;
    }

    const deadIds = deadTraders.map(r => r.source_trader_id);
    
    // Count rows to delete
    const { rows: [{ count: toDelete }] } = await client.query(`
      SELECT count(*) FROM leaderboard_ranks
      WHERE source = $1 AND win_rate IS NULL AND source_trader_id = ANY($2)
    `, [src, deadIds]);

    console.log(`${src}: ${deadIds.length} dead traders, ${toDelete} rows to delete`);

    // Delete
    const result = await client.query(`
      DELETE FROM leaderboard_ranks
      WHERE source = $1 AND win_rate IS NULL AND source_trader_id = ANY($2)
    `, [src, deadIds]);

    console.log(`  Deleted: ${result.rowCount} rows`);
    grandDeleted += result.rowCount;
  }

  console.log(`\n=== Post-deletion status ===`);
  const { rows: post } = await client.query(`
    SELECT source, count(*) as null_count
    FROM leaderboard_ranks
    WHERE win_rate IS NULL AND source = ANY($1)
    GROUP BY source ORDER BY null_count DESC
  `, [sources]);
  let postTotal = 0;
  for (const r of post) { console.log(`  ${r.source}: ${r.null_count}`); postTotal += parseInt(r.null_count); }
  console.log(`  Total: ${postTotal}`);
  
  // Overall stats
  const { rows: [{ count: allNull }] } = await client.query(`SELECT count(*) FROM leaderboard_ranks WHERE win_rate IS NULL`);
  const { rows: [{ count: allTotal }] } = await client.query(`SELECT count(*) FROM leaderboard_ranks`);
  console.log(`\n=== Overall ===`);
  console.log(`Total deleted this run: ${grandDeleted}`);
  console.log(`Remaining null WR (all sources): ${allNull} / ${allTotal} total rows`);

  client.release();
  await pool.end();
}

main().catch(console.error);
