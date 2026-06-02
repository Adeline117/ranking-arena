/**
 * Incremental diff — fetch current leaderboard state and find changed rows.
 * Extracted from computeSeason to reduce route.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Period } from '@/lib/utils/arena-score'
import type { ScoredTrader } from './score-traders'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('compute-leaderboard')

export interface CurrentRow {
  arena_score: number
  rank: number
  handle: string | null
  avatar_url: string | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  calmar_ratio: number | null
  profit_factor: number | null
  trading_style: string | null
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
        'source, source_trader_id, arena_score, rank, handle, avatar_url, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trading_style'
      )
      .eq('season_id', season)
      .range(offset, offset + PAGE - 1)
    if (!currentScores?.length) break
    for (const r of currentScores) {
      currentScoreMap.set(`${r.source}:${r.source_trader_id}`, {
        arena_score: r.arena_score ?? 0,
        rank: r.rank,
        handle: r.handle,
        avatar_url: r.avatar_url,
        sharpe_ratio: r.sharpe_ratio,
        sortino_ratio: r.sortino_ratio,
        calmar_ratio: r.calmar_ratio,
        profit_factor: r.profit_factor,
        trading_style: r.trading_style,
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
    if (t.handle !== current.handle || t.avatar_url !== current.avatar_url) return true
    const newRank = idx + 1
    if (current.rank !== newRank) return true
    if (current.arena_score === 0) return t.arena_score !== 0
    if (t.sharpe_ratio != null && !current.sharpe_ratio) return true
    if (t.sortino_ratio != null && !current.sortino_ratio) return true
    if (t.calmar_ratio != null && !current.calmar_ratio) return true
    if (t.profit_factor != null && !current.profit_factor) return true
    if (t.trading_style != null && !current.trading_style) return true
    return Math.abs(t.arena_score! - current.arena_score) > current.arena_score * 0.005
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
