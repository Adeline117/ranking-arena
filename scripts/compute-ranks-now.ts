/**
 * One-time compute: regenerate leaderboard_ranks from trader_snapshots
 * Mirrors compute-leaderboard/route.ts logic but runs locally.
 *
 * Usage: npx tsx scripts/compute-ranks-now.ts
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  calculateArenaScore,
  debouncedConfidence,
  ARENA_CONFIG,
  type Period,
} from '../lib/utils/arena-score'
import {
  ALL_SOURCES,
  SOURCE_TYPE_MAP,
  SOURCE_TRUST_WEIGHT,
} from '../lib/constants/exchanges'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

const SEASONS: Period[] = ['7D', '30D', '90D']
const DATA_FRESHNESS_HOURS_CEX = 24
const DATA_FRESHNESS_HOURS_DEX = 48
const MIN_TRADES_COUNT = 5

const ROI_ANOMALY_THRESHOLDS: Record<Period, number> = {
  '7D': 2000,
  '30D': 5000,
  '90D': 50000,
}

function getFreshnessHours(source: string): number {
  const sourceType = SOURCE_TYPE_MAP[source]
  return sourceType === 'web3' ? DATA_FRESHNESS_HOURS_DEX : DATA_FRESHNESS_HOURS_CEX
}

// Only recompute for specific sources that were missing data
const TARGET_SOURCES = ['bingx', 'bybit_spot', 'lbank', 'weex', 'hyperliquid', 'bybit', 'bitget_spot']

interface TraderRow {
  source: string
  source_trader_id: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  arena_score: number | null
  captured_at: string
  full_confidence_at: string | null
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: string | null
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
}

async function computeSeasonForSources(season: Period): Promise<number> {
  const freshnessISOBySource = (source: string): string => {
    const threshold = new Date()
    threshold.setHours(threshold.getHours() - getFreshnessHours(source))
    return threshold.toISOString()
  }

  const allSnapshots: TraderRow[] = []

  for (const source of TARGET_SOURCES) {
    let page = 0
    const pageSize = 1000
    while (true) {
      const { data, error } = await supabase
        .from('trader_snapshots')
        .select('source, source_trader_id, roi, pnl, win_rate, max_drawdown, trades_count, followers, arena_score, captured_at, full_confidence_at, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence')
        .eq('source', source)
        .eq('season_id', season)
        .gte('captured_at', freshnessISOBySource(source))
        .order('captured_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1)

      if (error || !data?.length) break
      allSnapshots.push(...(data as TraderRow[]))
      if (data.length < pageSize) break
      page++
    }
  }

  // Dedupe
  const traderMap = new Map<string, TraderRow>()
  for (const snap of allSnapshots) {
    const key = `${snap.source}:${snap.source_trader_id}`
    if (!traderMap.has(key)) traderMap.set(key, snap)
  }

  const roiThreshold = ROI_ANOMALY_THRESHOLDS[season]
  const uniqueTraders = Array.from(traderMap.values())
    .filter(t => Math.abs(t.roi ?? 0) <= roiThreshold)
    .filter(t => (t.roi ?? 0) > -90)
    .filter(t => t.trades_count == null || t.trades_count >= MIN_TRADES_COUNT)

  if (!uniqueTraders.length) return 0

  // Fetch handles
  const handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
  const bySource = new Map<string, string[]>()
  for (const t of uniqueTraders) {
    const ids = bySource.get(t.source) || []
    ids.push(t.source_trader_id)
    bySource.set(t.source, ids)
  }

  await Promise.all(
    Array.from(bySource.entries()).map(async ([source, traderIds]) => {
      for (let i = 0; i < traderIds.length; i += 500) {
        const chunk = traderIds.slice(i, i + 500)
        const { data } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, avatar_url')
          .eq('source', source)
          .in('source_trader_id', chunk)
        data?.forEach((s: { source_trader_id: string; handle: string | null; avatar_url: string | null }) => {
          handleMap.set(`${source}:${s.source_trader_id}`, { handle: s.handle, avatar_url: s.avatar_url || null })
        })
      }
    })
  )

  // Score
  const scored = uniqueTraders.map(t => {
    let normalizedWinRate: number | null = null
    if (t.win_rate != null && !isNaN(t.win_rate)) {
      const wr = t.win_rate <= 1 ? t.win_rate * 100 : t.win_rate
      normalizedWinRate = Math.max(0, Math.min(100, wr))
    }

    const scoreResult = calculateArenaScore(
      { roi: t.roi ?? 0, pnl: t.pnl ?? 0, maxDrawdown: t.max_drawdown, winRate: normalizedWinRate },
      season
    )

    const effectiveConfidence = debouncedConfidence(scoreResult.scoreConfidence, t.full_confidence_at)
    const confidenceMultiplier = ARENA_CONFIG.CONFIDENCE_MULTIPLIER[effectiveConfidence]
    const rawSubScores = scoreResult.returnScore + scoreResult.pnlScore + scoreResult.drawdownScore + scoreResult.stabilityScore
    const trustWeight = SOURCE_TRUST_WEIGHT[t.source] ?? 0.5
    const finalScore = Math.round(Math.max(0, Math.min(100, rawSubScores * confidenceMultiplier * trustWeight)) * 100) / 100

    const info = handleMap.get(`${t.source}:${t.source_trader_id}`) || { handle: null, avatar_url: null }

    return {
      source: t.source,
      source_trader_id: t.source_trader_id,
      arena_score: finalScore,
      roi: t.roi ?? 0,
      pnl: t.pnl ?? 0,
      win_rate: normalizedWinRate,
      max_drawdown: t.max_drawdown,
      followers: t.followers ?? 0,
      trades_count: t.trades_count,
      handle: (info.handle?.trim()) || t.source_trader_id,
      avatar_url: info.avatar_url,
      profitability_score: t.profitability_score,
      risk_control_score: t.risk_control_score,
      execution_score: t.execution_score,
      score_completeness: t.score_completeness,
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
    }
  })

  scored.sort((a, b) => {
    const diff = b.arena_score - a.arena_score
    if (Math.abs(diff) > 0.01) return diff
    return a.source_trader_id.localeCompare(b.source_trader_id)
  })

  // We need to merge with existing ranks for other sources.
  // Fetch existing ranks for non-target sources to get proper global ranking.
  // Actually, let's just upsert these source-specific ranks. The global rank will be
  // recalculated by the next cron run. For now, assign rank within these sources.

  // Delete old ranks for these sources+season first
  for (const source of TARGET_SOURCES) {
    await supabase
      .from('leaderboard_ranks')
      .delete()
      .eq('season_id', season)
      .eq('source', source)
  }

  // Upsert
  for (let i = 0; i < scored.length; i += 500) {
    const batch = scored.slice(i, i + 500).map((t, idx) => ({
      season_id: season,
      source: t.source,
      source_type: SOURCE_TYPE_MAP[t.source] || 'futures',
      source_trader_id: t.source_trader_id,
      rank: i + idx + 1, // temporary rank within these sources
      arena_score: t.arena_score,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers,
      trades_count: t.trades_count,
      handle: t.handle,
      avatar_url: t.avatar_url,
      computed_at: new Date().toISOString(),
      profitability_score: t.profitability_score,
      risk_control_score: t.risk_control_score,
      execution_score: t.execution_score,
      score_completeness: t.score_completeness,
      trading_style: t.trading_style,
      avg_holding_hours: t.avg_holding_hours,
      style_confidence: t.style_confidence,
    }))

    const { error } = await supabase
      .from('leaderboard_ranks')
      .upsert(batch, { onConflict: 'season_id,source,source_trader_id' })

    if (error) console.error(`Upsert error ${season} batch ${i}:`, error.message)
  }

  return scored.length
}

async function main() {
  console.log('=== Computing ranks for target sources ===')
  for (const season of SEASONS) {
    const count = await computeSeasonForSources(season)
    console.log(`${season}: ranked ${count} traders from target sources`)
  }
  console.log('\n=== Done ===')
}

main().catch(console.error)
