/**
 * Narrow public-ranking reader for trader-profile surfaces.
 *
 * Identity/profile observations can remain visible when a trader has not
 * entered the ranking cohort. Rank, score, ROI/PnL, and ranking-derived
 * counts must come only from the sealed public view. Keep this adapter local
 * to profile consumers while generated Supabase types catch up with the view.
 */

import type { TradingPeriod } from './types'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

export const PUBLIC_PROFILE_RANKING_PERIODS = [
  '7D',
  '30D',
  '90D',
] as const satisfies readonly TradingPeriod[]

export const PUBLIC_PROFILE_RANKING_COLUMNS =
  'season_id,source,source_trader_id,handle,avatar_url,rank,arena_score,arena_score_v3,roi,pnl,win_rate,max_drawdown,trades_count,followers,copiers,profitability_score,risk_control_score,execution_score,score_completeness,metrics_estimated,is_outlier,computed_at,trading_style,style_confidence,avg_holding_hours,sharpe_ratio,sortino_ratio,profit_factor,calmar_ratio,trader_type,source_type,rank_change,is_new'

type PublicRankedLeaderboardQueryResult = {
  data: unknown[] | null
  error: { message: string } | null
}

type PublicRankedLeaderboardQuery = PromiseLike<PublicRankedLeaderboardQueryResult> & {
  select(columns: string): PublicRankedLeaderboardQuery
  eq(column: string, value: string): PublicRankedLeaderboardQuery
  in(column: string, values: readonly string[]): PublicRankedLeaderboardQuery
  not(column: string, operator: string, value: null): PublicRankedLeaderboardQuery
  abortSignal(signal: AbortSignal): PublicRankedLeaderboardQuery
}

type PublicRankedLeaderboardClient = {
  from(relation: 'public_ranked_leaderboard'): PublicRankedLeaderboardQuery
}

export interface PublicProfileRankingScope {
  source: string
  sourceTraderId: string
  periods: readonly TradingPeriod[]
}

export interface PublicProfileRankingRow extends Record<string, unknown> {
  source: string
  source_trader_id: string
  season_id: TradingPeriod
  rank: number
}

export type PublicProfileRankingVisibility = 'verified' | 'partial' | 'unknown'

export interface PublicProfileRankingResult {
  rows: PublicProfileRankingRow[]
  rankingVisibility: PublicProfileRankingVisibility
  rankingVisibilityReason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicRankedLeaderboardClient(value: unknown): PublicRankedLeaderboardClient {
  // The view is intentionally additive during the rolling database deployment,
  // so generated Database types can lag it. Keep this checked escape hatch
  // narrow instead of widening every Supabase caller.
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicRankedLeaderboardClient
}

function uniquePeriods(periods: readonly TradingPeriod[]): TradingPeriod[] | null {
  const result: TradingPeriod[] = []
  for (const period of periods) {
    if (period !== '7D' && period !== '30D' && period !== '90D') return null
    if (!result.includes(period)) result.push(period)
  }
  return result.length > 0 ? result : null
}

function hasExactPublicProfileScope(
  row: unknown,
  source: string,
  sourceTraderId: string,
  periods: readonly TradingPeriod[]
): row is PublicProfileRankingRow {
  return (
    isRecord(row) &&
    row.source === source &&
    row.source_trader_id === sourceTraderId &&
    typeof row.season_id === 'string' &&
    periods.includes(row.season_id as TradingPeriod) &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0
  )
}

/**
 * Re-check a view response (or a future proof-bearing cache envelope) before
 * exposing ranking fields. A single malformed/foreign row fails the whole
 * profile cohort rather than shifting a later period into its place.
 */
export function sanitizePublicProfileRankingRows(
  value: unknown,
  scope: PublicProfileRankingScope
): PublicProfileRankingResult {
  const periods = uniquePeriods(scope.periods)
  if (!periods || !isPublicRankingSourceAllowed(scope.source) || !scope.sourceTraderId) {
    return {
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'source_not_publicly_rankable',
    }
  }

  if (!Array.isArray(value)) {
    return {
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    }
  }

  const safeRows: PublicProfileRankingRow[] = []
  for (const period of periods) {
    const rawPeriodRows = value.filter((row) => isRecord(row) && row.season_id === period)
    const sanitized = sanitizePublicRankingPayload(
      { traders: rawPeriodRows, period },
      { expectedPeriod: period }
    ) as { traders?: unknown[] }
    const rows = Array.isArray(sanitized.traders) ? sanitized.traders : []
    const scopedRows = rows.filter((row) =>
      hasExactPublicProfileScope(row, scope.source, scope.sourceTraderId, periods)
    )

    // A valid view returns at most one persisted rank for one trader/period.
    if (scopedRows.length !== rawPeriodRows.length || scopedRows.length > 1) {
      return {
        rows: [],
        rankingVisibility: 'partial',
        rankingVisibilityReason: 'public_cohort_unverified',
      }
    }
    safeRows.push(...scopedRows)
  }

  // Reject rows outside the requested period set too. Otherwise a proxy/schema
  // bug could make an extra row disappear during per-period sanitization.
  if (safeRows.length !== value.length) {
    return {
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    }
  }

  if (safeRows.length === 0) {
    return {
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_rank_unavailable',
    }
  }

  const rankingVisibility: PublicProfileRankingVisibility =
    safeRows.length === periods.length ? 'verified' : 'partial'
  return {
    rows: safeRows.sort(
      (left, right) => periods.indexOf(left.season_id) - periods.indexOf(right.season_id)
    ),
    rankingVisibility,
    rankingVisibilityReason:
      rankingVisibility === 'verified' ? null : 'public_period_not_published',
  }
}

/**
 * Read one trader's published ranking rows. Errors intentionally collapse to
 * `unknown`: identity/profile data may still render, but no raw rank-derived
 * field is allowed to leak through as a fallback.
 */
export async function fetchPublicProfileRankingRows(
  supabase: unknown,
  scope: PublicProfileRankingScope,
  signal?: AbortSignal
): Promise<PublicProfileRankingResult> {
  const periods = uniquePeriods(scope.periods)
  if (!periods || !isPublicRankingSourceAllowed(scope.source) || !scope.sourceTraderId) {
    return {
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'source_not_publicly_rankable',
    }
  }

  try {
    let query = publicRankedLeaderboardClient(supabase)
      .from('public_ranked_leaderboard')
      .select(PUBLIC_PROFILE_RANKING_COLUMNS)
      .eq('source', scope.source)
      .eq('source_trader_id', scope.sourceTraderId)
      .in('season_id', periods)
      .not('rank', 'is', null)

    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query
    if (error) {
      return {
        rows: [],
        rankingVisibility: 'unknown',
        rankingVisibilityReason: 'public_cohort_unavailable',
      }
    }
    return sanitizePublicProfileRankingRows(data ?? [], { ...scope, periods })
  } catch {
    return {
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
    }
  }
}
