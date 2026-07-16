/**
 * Incremental diff — fetch current leaderboard state and find changed rows.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import type { ScoredTrader } from './score-traders'
import { createLogger } from '@/lib/utils/logger'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'

const logger = createLogger('compute-leaderboard')

export interface CurrentRow {
  source_type: string | null
  arena_score: number | null
  arena_score_v3: number | null
  arena_score_v4: number | null
  score_factors: ScoredTrader['score_factors']
  rank: number
  handle: string | null
  avatar_url: string | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  followers: number | null
  copiers: number | null
  trades_count: number | null
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: string | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  calmar_ratio: number | null
  profit_factor: number | null
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  trader_type: string | null
  is_outlier: boolean | null
  metrics_estimated: boolean | null
}

function nullableNumberChanged(next: number | null, current: number | null): boolean {
  if (next == null || current == null) return next !== current
  return !Number.isFinite(next) || !Number.isFinite(current) || Math.abs(next - current) > 1e-9
}

function scoreChanged(next: number | null, current: number | null): boolean {
  if (next == null || current == null) return next !== current
  if (current === 0) return next !== 0
  return Math.abs(next - current) > Math.abs(current) * 0.005
}

function scoreFactorsChanged(
  next: ScoredTrader['score_factors'],
  current: ScoredTrader['score_factors']
): boolean {
  if (next == null || current == null) return next !== current
  return (['roi', 'pnl', 'drawdown', 'sharpe', 'consistency'] as const).some((key) =>
    nullableNumberChanged(next[key], current[key])
  )
}

function servingFieldsChanged(next: ScoredTrader, current: CurrentRow): boolean {
  const expectedSourceType = SOURCE_TYPE_MAP[next.source] || 'futures'
  if (expectedSourceType !== current.source_type) return true
  if (next.handle !== current.handle || next.avatar_url !== current.avatar_url) return true
  if (next.score_completeness !== current.score_completeness) return true
  if (next.trading_style !== current.trading_style) return true
  if (next.trader_type !== current.trader_type) return true
  if (next.metrics_estimated !== current.metrics_estimated) return true
  if ((next.is_outlier === true) !== (current.is_outlier === true)) return true
  if (scoreChanged(next.arena_score, current.arena_score)) return true
  if (scoreChanged(next.arena_score_v4, current.arena_score_v4)) return true
  if (scoreFactorsChanged(next.score_factors, current.score_factors)) return true

  const numericFields: Array<[number | null, number | null]> = [
    [next.arena_score_v3, current.arena_score_v3],
    [next.roi, current.roi],
    [next.pnl, current.pnl],
    [next.win_rate, current.win_rate],
    [next.max_drawdown, current.max_drawdown],
    [next.followers, current.followers],
    [next.copiers, current.copiers],
    [next.trades_count, current.trades_count],
    [next.profitability_score, current.profitability_score],
    [next.risk_control_score, current.risk_control_score],
    [next.execution_score, current.execution_score],
    [next.avg_holding_hours, current.avg_holding_hours],
    [next.style_confidence, current.style_confidence],
    [next.sharpe_ratio, current.sharpe_ratio],
    [next.sortino_ratio, current.sortino_ratio],
    [next.calmar_ratio, current.calmar_ratio],
    [next.profit_factor, current.profit_factor],
  ]
  return numericFields.some(([nextValue, currentValue]) =>
    nullableNumberChanged(nextValue, currentValue)
  )
}

/**
 * Fetch current leaderboard_ranks into a Map for diffing.
 * Paginates in 1000-row pages. Respects deadline.
 */
export async function fetchCurrentScoreMap(
  supabase: SupabaseClient,
  season: Period,
  isOutOfTime: (buffer: number) => boolean
): Promise<Map<string, CurrentRow>> {
  const currentScoreMap = new Map<string, CurrentRow>()
  let offset = 0
  const PAGE = 1000
  const MAX_PAGES = 100
  let pageCount = 0

  while (true) {
    if (++pageCount > MAX_PAGES) {
      logger.warn(`Reached MAX_PAGES (${MAX_PAGES}) for season ${season}, breaking`)
      break
    }
    if (isOutOfTime(45_000)) {
      logger.warn(
        `[${season}] aborting currentScoreMap fetch at page ${pageCount} — time running out`
      )
      break
    }
    const { data: currentScores } = await supabase
      .from('leaderboard_ranks')
      .select(
        'source, source_type, source_trader_id, arena_score, arena_score_v3, arena_score_v4, score_factors, rank, handle, avatar_url, roi, pnl, win_rate, max_drawdown, followers, copiers, trades_count, profitability_score, risk_control_score, execution_score, score_completeness, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trading_style, avg_holding_hours, style_confidence, trader_type, is_outlier, metrics_estimated'
      )
      .eq('season_id', season)
      .range(offset, offset + PAGE - 1)
    if (!currentScores?.length) break
    for (const r of currentScores) {
      currentScoreMap.set(`${r.source}:${r.source_trader_id}`, {
        source_type: r.source_type,
        arena_score: r.arena_score,
        arena_score_v3: r.arena_score_v3,
        arena_score_v4: r.arena_score_v4,
        score_factors: r.score_factors as ScoredTrader['score_factors'],
        rank: r.rank,
        handle: r.handle,
        avatar_url: r.avatar_url,
        roi: r.roi,
        pnl: r.pnl,
        win_rate: r.win_rate,
        max_drawdown: r.max_drawdown,
        followers: r.followers,
        copiers: r.copiers,
        trades_count: r.trades_count,
        profitability_score: r.profitability_score,
        risk_control_score: r.risk_control_score,
        execution_score: r.execution_score,
        score_completeness: r.score_completeness,
        sharpe_ratio: r.sharpe_ratio,
        sortino_ratio: r.sortino_ratio,
        calmar_ratio: r.calmar_ratio,
        profit_factor: r.profit_factor,
        trading_style: r.trading_style,
        avg_holding_hours: r.avg_holding_hours,
        style_confidence: r.style_confidence,
        trader_type: r.trader_type,
        is_outlier: r.is_outlier,
        metrics_estimated: r.metrics_estimated,
      })
    }
    if (currentScores.length < PAGE) break
    offset += PAGE
  }

  return currentScoreMap
}

/**
 * Filter scored traders to only those that changed vs current state.
 * Returns changed traders + rank maps.
 */
export function buildChangedTraders(
  scoredFiltered: ScoredTrader[],
  currentScoreMap: Map<string, CurrentRow>,
  season: Period
): {
  changedTraders: ScoredTrader[]
  rankMap: Map<string, number>
  prevRankMap: Map<string, number>
} {
  const changedTraders = scoredFiltered.filter((t, idx) => {
    const current = currentScoreMap.get(`${t.source}:${t.source_trader_id}`)
    if (current == null) return true
    const newRank = idx + 1
    if (current.rank !== newRank) return true
    return servingFieldsChanged(t, current)
  })

  logger.info(
    `[${season}] Incremental upsert: ${changedTraders.length}/${scoredFiltered.length} changed (${((1 - changedTraders.length / Math.max(1, scoredFiltered.length)) * 100).toFixed(1)}% skipped)`
  )

  // Build rank + prev-rank maps
  const rankMap = new Map<string, number>()
  scoredFiltered.forEach((t, idx) => rankMap.set(`${t.source}:${t.source_trader_id}`, idx + 1))

  const prevRankMap = new Map<string, number>()
  for (const [key, current] of currentScoreMap) {
    if (current.rank != null) prevRankMap.set(key, current.rank)
  }

  return { changedTraders, rankMap, prevRankMap }
}
