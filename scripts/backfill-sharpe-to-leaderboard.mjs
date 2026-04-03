/**
 * Backfill sharpe_ratio from trader_equity_curve → leaderboard_ranks
 *
 * For traders with null sharpe in leaderboard_ranks that have ≥5 equity curve points,
 * compute sharpe and update directly.
 */

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SHARPE_CAP = 10
const PAGE = 1000

function computeSharpe(points) {
  if (points.length < 5) return null

  // Sort by date
  points.sort((a, b) => a.data_date.localeCompare(b.data_date))

  // Get daily returns from ROI differences
  const dailyReturns = []
  for (let i = 1; i < points.length; i++) {
    dailyReturns.push(points[i].roi_pct - points[i - 1].roi_pct)
  }

  if (dailyReturns.length < 3) return null

  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length
  const stdDev = Math.sqrt(variance)

  if (stdDev === 0) return null

  const raw = (mean / stdDev) * Math.sqrt(365)
  const sharpe = Math.round(raw * 100) / 100

  if (sharpe < -SHARPE_CAP || sharpe > SHARPE_CAP) return null
  return sharpe
}

async function main() {
  console.log('Fetching null-sharpe traders from leaderboard_ranks...')

  // Get all null-sharpe entries
  let allNull = []
  let offset = 0
  while (true) {
    const { data, error } = await supabase
      .from('leaderboard_ranks')
      .select('id, source, source_trader_id')
      .is('sharpe_ratio', null)
      .range(offset, offset + PAGE - 1)

    if (error) { console.error('Fetch error:', error.message); break }
    if (!data || data.length === 0) break
    allNull.push(...data)
    offset += PAGE
    if (data.length < PAGE) break
  }

  console.log(`Found ${allNull.length} null-sharpe entries`)

  // Group by source
  const bySource = new Map()
  for (const row of allNull) {
    const list = bySource.get(row.source) || []
    list.push(row)
    bySource.set(row.source, list)
  }

  let totalUpdated = 0
  let totalSkipped = 0

  for (const [source, rows] of bySource) {
    const traderIds = rows.map(r => r.source_trader_id)

    // Fetch equity curves in chunks
    const curveMap = new Map()
    for (let i = 0; i < traderIds.length; i += 200) {
      const chunk = traderIds.slice(i, i + 200)
      const { data: curves } = await supabase
        .from('trader_equity_curve')
        .select('source_trader_id, data_date, roi_pct')
        .eq('source', source)
        .in('source_trader_id', chunk)
        .gte('data_date', new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0])
        .order('data_date')

      if (curves) {
        for (const pt of curves) {
          const list = curveMap.get(pt.source_trader_id) || []
          list.push(pt)
          curveMap.set(pt.source_trader_id, list)
        }
      }
    }

    // Compute sharpe and batch update
    const updates = []
    for (const row of rows) {
      const points = curveMap.get(row.source_trader_id)
      if (!points || points.length < 5) { totalSkipped++; continue }

      const sharpe = computeSharpe(points)
      if (sharpe == null) { totalSkipped++; continue }

      updates.push({ id: row.id, sharpe_ratio: sharpe })
    }

    // Batch update in chunks of 500
    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500)
      const ids = chunk.map(u => u.id)

      // Update one by one since Supabase doesn't support batch update by different values easily
      for (const u of chunk) {
        const { error } = await supabase
          .from('leaderboard_ranks')
          .update({ sharpe_ratio: u.sharpe_ratio })
          .eq('id', u.id)

        if (error) {
          console.error(`Update error for ${u.id}:`, error.message)
        } else {
          totalUpdated++
        }
      }
    }

    console.log(`${source}: ${updates.length} updated, ${rows.length - updates.length} skipped (no curve data)`)
  }

  console.log(`\nDone! Updated: ${totalUpdated}, Skipped: ${totalSkipped}`)

  // Verify new coverage
  const { data: coverage } = await supabase.rpc('exec_sql', {
    query: "SELECT ROUND(100.0 * COUNT(sharpe_ratio) / COUNT(*), 1) as pct FROM leaderboard_ranks"
  })
  console.log('New overall coverage:', coverage)
}

main().catch(console.error)
