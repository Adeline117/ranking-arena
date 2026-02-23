/**
 * Backfill Sharpe/Sortino/Profit Factor for 7D/30D windows.
 *
 * Targets:
 * - trader_snapshots
 * - leaderboard_ranks
 *
 * Usage:
 *   npx tsx scripts/backfill-risk-metrics-7d30d.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

import pg from 'pg'

type MetricTriple = {
  sharpe: number | null
  sortino: number | null
  profitFactor: number | null
}

function clamp(value: number | null, min: number, max: number) {
  if (value == null || Number.isNaN(value)) return null
  return Math.max(min, Math.min(max, value))
}

function computeMetrics(roiSeries: number[]): MetricTriple | null {
  if (roiSeries.length < 6) return null

  const returns: number[] = []
  for (let i = 1; i < roiSeries.length; i += 1) {
    returns.push(roiSeries[i] - roiSeries[i - 1])
  }

  if (returns.length < 5) return null

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)

  const negatives = returns.filter(r => r < 0)
  const downsideVar = negatives.length > 0
    ? negatives.reduce((acc, r) => acc + r * r, 0) / negatives.length
    : 0
  const downsideStd = Math.sqrt(downsideVar)

  const grossProfit = returns.filter(r => r > 0).reduce((acc, r) => acc + r, 0)
  const grossLoss = Math.abs(returns.filter(r => r < 0).reduce((acc, r) => acc + r, 0))

  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : null
  const sortino = downsideStd > 0 ? (mean / downsideStd) * Math.sqrt(365) : null
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.99 : null)

  return {
    sharpe: clamp(sharpe, -99, 99),
    sortino: clamp(sortino, -99, 99),
    profitFactor: clamp(profitFactor, 0, 99.99),
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })

  console.log('=== Backfill risk metrics for 7D/30D ===')

  const { rows } = await pool.query(`
    SELECT source, source_trader_id, period, data_date, roi_pct::float
    FROM trader_equity_curve
    WHERE period IN ('7D','30D')
      AND roi_pct IS NOT NULL
    ORDER BY source, source_trader_id, period, data_date
  `)

  const grouped = new Map<string, number[]>()
  for (const row of rows) {
    const key = `${row.source}|${row.source_trader_id}|${row.period}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(row.roi_pct)
  }

  const updates: Array<{
    source: string
    sourceTraderId: string
    seasonId: string
    sharpe: number | null
    sortino: number | null
    pf: number | null
  }> = []

  for (const [key, series] of grouped) {
    const [source, sourceTraderId, period] = key.split('|')
    const computed = computeMetrics(series)
    if (!computed) continue

    updates.push({
      source,
      sourceTraderId,
      seasonId: period,
      sharpe: computed.sharpe,
      sortino: computed.sortino,
      pf: computed.profitFactor,
    })
  }

  console.log(`Computed metrics for ${updates.length} trader-window pairs`)

  const CHUNK = 500
  let totalSnapshotsUpdated = 0
  let totalRanksUpdated = 0

  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK)

    const values = batch.map((_, idx) => {
      const p = idx * 6
      return `($${p + 1},$${p + 2},$${p + 3},$${p + 4}::numeric,$${p + 5}::numeric,$${p + 6}::numeric)`
    }).join(',')

    const params = batch.flatMap(u => [u.source, u.sourceTraderId, u.seasonId, u.sharpe, u.sortino, u.pf])

    const snapshotResult = await pool.query(`
      UPDATE trader_snapshots ts
      SET
        sharpe_ratio = v.sharpe,
        sortino_ratio = v.sortino,
        profit_factor = v.pf
      FROM (VALUES ${values}) AS v(source, source_trader_id, season_id, sharpe, sortino, pf)
      WHERE ts.source = v.source
        AND ts.source_trader_id = v.source_trader_id
        AND ts.season_id = v.season_id
    `, params)

    totalSnapshotsUpdated += snapshotResult.rowCount || 0

    const rankResult = await pool.query(`
      UPDATE leaderboard_ranks lr
      SET
        sharpe_ratio = v.sharpe,
        sortino_ratio = v.sortino,
        profit_factor = v.pf
      FROM (VALUES ${values}) AS v(source, source_trader_id, season_id, sharpe, sortino, pf)
      WHERE lr.source = v.source
        AND lr.source_trader_id = v.source_trader_id
        AND lr.season_id = v.season_id
    `, params)

    totalRanksUpdated += rankResult.rowCount || 0
  }

  const { rows: coverage } = await pool.query(`
    SELECT
      season_id,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE sharpe_ratio IS NOT NULL) AS sharpe_filled,
      COUNT(*) FILTER (WHERE sortino_ratio IS NOT NULL) AS sortino_filled,
      COUNT(*) FILTER (WHERE profit_factor IS NOT NULL) AS pf_filled
    FROM trader_snapshots
    WHERE season_id IN ('7D','30D')
    GROUP BY season_id
    ORDER BY season_id
  `)

  console.log(`Updated trader_snapshots rows: ${totalSnapshotsUpdated}`)
  console.log(`Updated leaderboard_ranks rows: ${totalRanksUpdated}`)
  console.table(coverage)

  await pool.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
