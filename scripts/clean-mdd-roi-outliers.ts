/**
 * Clean out-of-bound ROI/MDD values in trader_snapshots.
 *
 * Requires migration function:
 *   public.clean_trader_snapshot_outliers()
 */

import pg from 'pg'
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

  const before = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE roi IS NOT NULL AND (roi > 5000 OR roi < -5000)) AS roi_outliers,
      COUNT(*) FILTER (WHERE max_drawdown IS NOT NULL AND (max_drawdown > 100 OR max_drawdown < 0)) AS mdd_outliers
    FROM trader_snapshots
  `)

  const { rows: cleaned } = await pool.query('SELECT * FROM public.clean_trader_snapshot_outliers()')

  const after = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE roi IS NOT NULL AND (roi > 5000 OR roi < -5000)) AS roi_outliers,
      COUNT(*) FILTER (WHERE max_drawdown IS NOT NULL AND (max_drawdown > 100 OR max_drawdown < 0)) AS mdd_outliers
    FROM trader_snapshots
  `)

  console.log('Before:', before.rows[0])
  console.log('Cleaned:', cleaned[0])
  console.log('After:', after.rows[0])

  await pool.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
