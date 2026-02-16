#!/usr/bin/env node
/**
 * Compute sharpe/sortino/PF from trader_equity_curve pnl_usd data
 * For sources where roi_pct is null but pnl_usd exists (e.g., Hyperliquid).
 * 
 * Method: Use cumulative PnL changes as proxy for returns.
 * sharpe = mean(daily_pnl_changes) / std(daily_pnl_changes) * sqrt(365)
 */

import 'dotenv/config'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })

async function main() {
  console.time('total')
  
  // Get traders in LR without sharpe
  const traders = await pool.query(`
    SELECT DISTINCT lr.source, lr.source_trader_id 
    FROM leaderboard_ranks lr
    WHERE lr.sharpe_ratio IS NULL
  `)
  console.log(`${traders.rows.length} traders without sharpe in LR`)

  // Load all pnl_usd curves (for traders where roi_pct is mostly null)
  console.log('Loading pnl_usd curves...')
  const allCurves = await pool.query(`
    SELECT source, source_trader_id, 
           COALESCE(roi_pct::float, NULL) as roi_pct,
           COALESCE(pnl_usd::float, NULL) as pnl_usd
    FROM trader_equity_curve
    ORDER BY source, source_trader_id, data_date ASC
  `)
  console.log(`Loaded ${allCurves.rows.length} curve points`)

  // Build curve maps
  const roiMap = new Map()
  const pnlMap = new Map()
  for (const row of allCurves.rows) {
    const key = `${row.source}|${row.source_trader_id}`
    if (row.roi_pct !== null) {
      if (!roiMap.has(key)) roiMap.set(key, [])
      roiMap.get(key).push(row.roi_pct)
    }
    if (row.pnl_usd !== null) {
      if (!pnlMap.has(key)) pnlMap.set(key, [])
      pnlMap.get(key).push(row.pnl_usd)
    }
  }

  const updates = []
  let skippedNoData = 0
  let skippedFewPoints = 0

  for (const { source, source_trader_id } of traders.rows) {
    const key = `${source}|${source_trader_id}`
    
    let returns = null
    
    // Prefer roi_pct if available
    const roiPoints = roiMap.get(key)
    if (roiPoints && roiPoints.length >= 5) {
      returns = []
      for (let i = 1; i < roiPoints.length; i++) {
        const base = 100 + roiPoints[i - 1]
        if (base === 0) continue
        returns.push((roiPoints[i] - roiPoints[i - 1]) / Math.abs(base))
      }
    }
    
    // Fallback to pnl_usd
    if (!returns || returns.length < 4) {
      const pnlPoints = pnlMap.get(key)
      if (pnlPoints && pnlPoints.length >= 5) {
        returns = []
        for (let i = 1; i < pnlPoints.length; i++) {
          // Use absolute PnL change normalized by max(abs(prev_pnl), 100)
          // 100 as floor to avoid division by near-zero
          const base = Math.max(Math.abs(pnlPoints[i - 1]), 100)
          returns.push((pnlPoints[i] - pnlPoints[i - 1]) / base)
        }
      }
    }
    
    if (!returns) { skippedNoData++; continue }
    if (returns.length < 4) { skippedFewPoints++; continue }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length
    const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : null

    const downsideVar = returns.filter(r => r < 0).reduce((a, r) => a + r ** 2, 0) / returns.length
    const sortino = Math.sqrt(downsideVar) > 0 ? (mean / Math.sqrt(downsideVar)) * Math.sqrt(365) : null

    const posSum = returns.filter(r => r > 0).reduce((a, b) => a + b, 0)
    const negSum = Math.abs(returns.filter(r => r < 0).reduce((a, b) => a + b, 0))
    const pf = negSum > 0 ? posSum / negSum : (posSum > 0 ? 999.99 : null)

    const clamp = (v, lo, hi) => v === null ? null : Math.max(lo, Math.min(hi, parseFloat(v.toFixed(4))))
    
    if (clamp(sharpe, -50, 50) !== null) {
      updates.push([clamp(sharpe, -50, 50), clamp(sortino, -50, 50), clamp(pf, 0, 999.99), source, source_trader_id])
    } else {
      skippedFewPoints++
    }
  }

  console.log(`Computed ${updates.length} metrics`)
  console.log(`Skipped: ${skippedNoData} no data, ${skippedFewPoints} too few points`)

  // Batch update
  let totalUpdated = 0
  for (let i = 0; i < updates.length; i++) {
    const [s, so, pf, src, stid] = updates[i]
    const res = await pool.query(
      `UPDATE leaderboard_ranks SET sharpe_ratio=$1, sortino_ratio=$2, profit_factor=$3 WHERE source=$4 AND source_trader_id=$5 AND sharpe_ratio IS NULL`,
      [s, so, pf, src, stid]
    )
    totalUpdated += res.rowCount
    if (i % 500 === 0) process.stdout.write(`${i}/${updates.length} `)
  }

  console.log(`\nRows updated: ${totalUpdated}`)

  const v = await pool.query(`
    SELECT COUNT(*) total, COUNT(sharpe_ratio) has_sharpe
    FROM leaderboard_ranks
  `)
  console.log('Verification:', v.rows[0])
  console.timeEnd('total')
  await pool.end()
}

main().catch(e => { console.error(e); process.exit(1) })
