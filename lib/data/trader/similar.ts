/**
 * Similar traders lookup — finds comparable traders from the sealed public
 * cohort. The source/source_trader_id/season_id field names match the ranking
 * projection, but no raw rank table is read here.
 */

import type { TypedSupabaseClient } from '@/lib/supabase/typed-client'
import type { UnifiedTrader } from './types'
import { mapLeaderboardRow } from './mappers'
import { LR } from '@/lib/types/schema-mapping'
import { logger } from '@/lib/logger'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

const PUBLIC_SIMILAR_COLUMNS =
  'source,source_trader_id,handle,avatar_url,arena_score,roi,pnl,win_rate,max_drawdown,followers,rank,season_id,source_type,trader_type,computed_at,score_completeness,metrics_estimated,is_outlier'

/** Recommendation card is best-effort: never hold a profile render longer. */
export const SIMILAR_TRADERS_QUERY_TIMEOUT_MS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasPositiveScopedRank(row: unknown, source: string): row is Record<string, unknown> {
  return (
    isRecord(row) &&
    row.source === source &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0
  )
}

export async function fetchSimilarTraders(
  supabase: TypedSupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null
): Promise<UnifiedTrader[]> {
  if (!isPublicRankingSourceAllowed(platform)) return []
  // A cached recommendation slice would carry rank/ROI/score fields past the
  // current serving-head proof. Query the sealed cohort for every public
  // profile render instead.
  return fetchSimilarTradersUncached(supabase, platform, traderKey, arenaScore, roi)
}

async function fetchSimilarTradersUncached(
  supabase: TypedSupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null
): Promise<UnifiedTrader[]> {
  try {
    let data: Record<string, unknown>[] | null = null

    // The view is the ranking authority. It seals source freshness and complete
    // metrics before this range filter, so a profile's recommendation card
    // cannot promote a raw/partial row merely because it looks similar.
    if (arenaScore != null) {
      const scoreRange = Math.max(arenaScore * 0.25, 10)
      const result = await supabase
        .from('public_ranked_leaderboard')
        .select(PUBLIC_SIMILAR_COLUMNS)
        .eq(LR.source, platform)
        .eq(LR.season_id, '90D')
        .neq(LR.source_trader_id, traderKey)
        .not('rank', 'is', null)
        .not(LR.arena_score, 'is', null)
        .gte(LR.arena_score, arenaScore - scoreRange)
        .lte(LR.arena_score, arenaScore + scoreRange)
        .order(LR.arena_score, { ascending: false })
        .order(LR.rank, { ascending: true, nullsFirst: false })
        .limit(10)
        .abortSignal(AbortSignal.timeout(SIMILAR_TRADERS_QUERY_TIMEOUT_MS))
      if (result.error) logger.warn('[similar-traders] score query error:', result.error.message)
      data = result.data as Record<string, unknown>[] | null
    } else if (roi != null) {
      const roiRange = Math.max(Math.abs(roi) * 0.3, 20)
      const result = await supabase
        .from('public_ranked_leaderboard')
        .select(PUBLIC_SIMILAR_COLUMNS)
        .eq(LR.source, platform)
        .eq(LR.season_id, '90D')
        .neq(LR.source_trader_id, traderKey)
        .not('rank', 'is', null)
        .gte(LR.roi, roi - roiRange)
        .lte(LR.roi, roi + roiRange)
        .order(LR.roi, { ascending: false })
        .order(LR.rank, { ascending: true, nullsFirst: false })
        .limit(10)
        .abortSignal(AbortSignal.timeout(SIMILAR_TRADERS_QUERY_TIMEOUT_MS))
      if (result.error) logger.warn('[similar-traders] roi query error:', result.error.message)
      data = result.data as Record<string, unknown>[] | null
    }

    if (!data || data.length === 0) return []

    const sanitized = sanitizePublicRankingPayload(
      { traders: data, period: '90D' },
      { expectedPeriod: '90D' }
    ) as { traders?: unknown[] }
    const safeRows = Array.isArray(sanitized.traders)
      ? sanitized.traders.filter((row) => hasPositiveScopedRank(row, platform))
      : ([] as Record<string, unknown>[])

    // A row that fails the public-ranking proof is dropped; the rest of the
    // list is still shown. Returning nothing here emptied the whole module for
    // every trader whose neighbours included one unexpected row.
    const dropped = data.length - safeRows.length
    if (dropped > 0) {
      logger.warn('[similar-traders] dropped rows that failed public-ranking proof', {
        platform,
        dropped,
        kept: safeRows.length,
      })
    }

    // Dedupe and map
    const seen = new Set<string>()
    return safeRows
      .filter((row) => {
        if (!isPublicRankingSourceAllowed(row[LR.source])) return false
        const id = String(row[LR.source_trader_id] || '')
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map((row) => mapLeaderboardRow(row))
  } catch (err) {
    logger.warn(
      '[similar-traders] lookup failed:',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}
