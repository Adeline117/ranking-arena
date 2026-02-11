#!/usr/bin/env node
/**
 * Compute and update arena_score for all bot_snapshots
 */
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function percentileRank(value, arr) {
  const below = arr.filter(v => v < value).length
  return arr.length ? (below / arr.length) * 100 : 50
}
function clamp(v) { return Math.max(0, Math.min(100, v)) }

async function main() {
  for (const season of ['7D', '30D', '90D']) {
    const { data: snapshots } = await supabase
      .from('bot_snapshots')
      .select('id, bot_id, total_volume, unique_users, tvl, apy, roi, max_drawdown, sharpe_ratio')
      .eq('season_id', season)

    // Get launch dates
    const botIds = [...new Set(snapshots.map(s => s.bot_id))]
    const { data: sources } = await supabase.from('bot_sources').select('id, launch_date').in('id', botIds)
    const launchMap = Object.fromEntries((sources || []).map(s => [s.id, s.launch_date]))

    const volumes = snapshots.map(s => s.total_volume ?? 0).sort((a, b) => a - b)
    const users = snapshots.map(s => s.unique_users ?? 0).sort((a, b) => a - b)
    const tvls = snapshots.map(s => s.tvl ?? 0).sort((a, b) => a - b)
    const rois = snapshots.map(s => s.roi ?? s.apy ?? 0).sort((a, b) => a - b)

    for (const snap of snapshots) {
      const volumeScore = percentileRank(snap.total_volume ?? 0, volumes)
      const perfValue = snap.roi ?? snap.apy ?? 0
      const performanceScore = percentileRank(perfValue, rois)
      let riskScore = 50
      if (snap.max_drawdown != null) riskScore = clamp(100 - snap.max_drawdown * 2)
      if (snap.sharpe_ratio != null) {
        const ss = clamp(snap.sharpe_ratio * 50)
        riskScore = snap.max_drawdown != null ? riskScore * 0.6 + ss * 0.4 : ss
      }
      const userScore = percentileRank(snap.unique_users ?? 0, users)
      const tvlScore = percentileRank(snap.tvl ?? 0, tvls)
      const adoptionScore = userScore * 0.5 + tvlScore * 0.5
      let longevityScore = 30
      const ld = launchMap[snap.bot_id]
      if (ld) {
        const months = (Date.now() - new Date(ld).getTime()) / (30 * 24 * 60 * 60 * 1000)
        longevityScore = clamp(10 + months * 3.5)
      }
      const score = Math.round((0.25 * volumeScore + 0.30 * performanceScore + 0.20 * riskScore + 0.15 * adoptionScore + 0.10 * longevityScore) * 10) / 10

      await supabase.from('bot_snapshots').update({ arena_score: clamp(score) }).eq('id', snap.id)
    }
    console.log(`${season}: scored ${snapshots.length} bots`)
  }
}
main().catch(console.error)
