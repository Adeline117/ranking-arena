/**
 * Hot-trader publication boundary.
 *
 * A "hot" list is a ranking over historical changes. A currently published
 * Arena rank proves only the current score; it does not prove that the prior
 * snapshots used for ROI momentum, follower growth, or trading frequency had
 * complete coverage, trusted prices, and known cost basis. Until that
 * historical cohort has its own immutable publication receipt, do not turn
 * raw snapshots into a public ranking.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

const logger = createLogger('hot-score')

const HOT_TRADER_PERIOD = '90D'
const PUBLIC_RANKED_HOT_PROBE_COLUMNS =
  'source,source_trader_id,rank,arena_score,roi,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

export type HotTraderRankingVisibility = 'partial' | 'unknown'

export interface HotTraderCohortResult {
  traders: []
  ranking_visibility: HotTraderRankingVisibility
  ranking_visibility_reason: string
  ranking_visibility_reasons: [string]
}

interface PublicRankedLeaderboardQueryResult {
  data: unknown[] | null
  error: unknown | null
}

type PublicRankedLeaderboardQuery = PromiseLike<PublicRankedLeaderboardQueryResult> & {
  select(columns: string): PublicRankedLeaderboardQuery
  eq(column: string, value: string): PublicRankedLeaderboardQuery
  not(column: string, operator: string, value: null): PublicRankedLeaderboardQuery
  gt(column: string, value: number): PublicRankedLeaderboardQuery
  or(expression: string): PublicRankedLeaderboardQuery
  order(
    column: string,
    options: { ascending: boolean; nullsFirst: boolean }
  ): PublicRankedLeaderboardQuery
  limit(count: number): PublicRankedLeaderboardQuery
}

type PublicRankedLeaderboardClient = {
  from(relation: 'public_ranked_leaderboard'): PublicRankedLeaderboardQuery
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Local bridge until generated Supabase types include the security-barrier
 * view. This intentionally prevents this public code path from selecting a
 * raw ranking relation.
 */
function publicRankedLeaderboardClient(value: unknown): PublicRankedLeaderboardClient {
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicRankedLeaderboardClient
}

function isCurrentPublicHotProbe(row: unknown): boolean {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    isPublicRankingSourceAllowed(row.source) &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0 &&
    typeof row.arena_score === 'number' &&
    Number.isFinite(row.arena_score) &&
    row.arena_score > 0 &&
    typeof row.roi === 'number' &&
    Number.isFinite(row.roi)
  )
}

/**
 * The database view establishes cohort membership; this repeat validation is
 * defense in depth for schema/client drift. We never return the probe row,
 * but it distinguishes "historical proof missing" from "current cohort
 * unavailable" without trusting raw leaderboard data.
 */
function hasVerifiedCurrentPublicHotCohort(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false

  const sanitized = sanitizePublicRankingPayload(
    { traders: value, period: HOT_TRADER_PERIOD },
    { expectedPeriod: HOT_TRADER_PERIOD }
  ) as { traders?: unknown[] }
  const rows = Array.isArray(sanitized.traders) ? sanitized.traders : []

  return rows.length === value.length && rows.length > 0 && rows.every(isCurrentPublicHotProbe)
}

function unavailableHotTraders(
  visibility: HotTraderRankingVisibility,
  reason: string
): HotTraderCohortResult {
  return {
    traders: [],
    ranking_visibility: visibility,
    ranking_visibility_reason: reason,
    ranking_visibility_reasons: [reason],
  }
}

/**
 * Probe the current sealed cohort, then fail closed. A composite hot score
 * cannot be published until its historical inputs have independent,
 * immutable publication authority.
 */
export async function computeHotTraders(): Promise<HotTraderCohortResult> {
  try {
    const { data, error } = await publicRankedLeaderboardClient(getSupabaseAdmin())
      .from('public_ranked_leaderboard')
      .select(PUBLIC_RANKED_HOT_PROBE_COLUMNS)
      .eq('season_id', HOT_TRADER_PERIOD)
      .not('rank', 'is', null)
      .not('arena_score', 'is', null)
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(1)

    if (error) {
      logger.warn('Current public hot cohort probe failed', { error })
      return unavailableHotTraders('unknown', 'public_cohort_unavailable')
    }

    return hasVerifiedCurrentPublicHotCohort(data)
      ? unavailableHotTraders('partial', 'historical_hot_evidence_unavailable')
      : unavailableHotTraders('unknown', 'public_cohort_unavailable')
  } catch (error) {
    logger.warn('Current public hot cohort is unavailable', { error })
    return unavailableHotTraders('unknown', 'public_cohort_unavailable')
  }
}
