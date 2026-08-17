/**
 * Public Top Movers API
 *
 * A mover is a ranking over a historical metric delta, not merely a current
 * rank row. `trader_daily_snapshots` currently has no immutable publication
 * receipt proving the prior-day coverage, price basis, or cost basis needed
 * for that ranking. Until a sealed historical cohort exists, this endpoint
 * must not turn those raw snapshots into an authoritative "Top Movers" list.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getOrSetWithLock } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'
import {
  isPublicRankingSourceAllowed,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'

const log = createLogger('api:movers')
const PERIOD = '90D'
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'

interface MoverResponse {
  risers: []
  fallers: []
  period: typeof PERIOD
  snapshotDate: null
  compareDate: null
  ranking_visibility: 'partial' | 'unknown'
  ranking_visibility_reason: string
  ranking_visibility_reasons: [string]
}

interface PublicRankedLeaderboardQueryResult {
  data: unknown[] | null
  error: { message: string } | null
}

type PublicRankedLeaderboardQuery = PromiseLike<PublicRankedLeaderboardQueryResult> & {
  select(columns: string): PublicRankedLeaderboardQuery
  eq(column: string, value: string): PublicRankedLeaderboardQuery
  not(column: string, operator: string, value: null): PublicRankedLeaderboardQuery
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

function publicRankedLeaderboardClient(value: unknown): PublicRankedLeaderboardClient {
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicRankedLeaderboardClient
}

function isPublishedCurrentRank(row: unknown): boolean {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    isPublicRankingSourceAllowed(row.source) &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0
  )
}

function unavailableMovers(visibility: 'partial' | 'unknown', reason: string): MoverResponse {
  return {
    risers: [],
    fallers: [],
    period: PERIOD,
    snapshotDate: null,
    compareDate: null,
    ranking_visibility: visibility,
    ranking_visibility_reason: reason,
    ranking_visibility_reasons: [reason],
  }
}

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const result = await getOrSetWithLock<MoverResponse>(
      // v2 cannot read the retired raw-snapshot payload during a rolling
      // deployment. Every cached response now explicitly carries its trust
      // state rather than looking like a complete empty leaderboard.
      publicRankingCacheKey('api:rankings:movers:v2'),
      () => computeMovers(),
      {
        ttl: 120,
        lockTtl: 15,
        tags: [PUBLIC_RANKING_REDIS_TAG, `season:${PERIOD}`],
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    )

    return NextResponse.json(result, {
      headers: { 'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL },
    })
  } catch (error) {
    log.error('Error determining public movers cohort', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(unavailableMovers('unknown', 'public_cohort_unavailable'), {
      status: 200,
      headers: { 'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL },
    })
  }
}

async function computeMovers(): Promise<MoverResponse> {
  const TIMEOUT_MS = 5000
  return Promise.race([
    computeMoversInner(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('computeMovers timed out after 5s')), TIMEOUT_MS)
    ),
  ])
}

async function computeMoversInner(): Promise<MoverResponse> {
  const supabase = getSupabaseAdmin()

  // Keep a current publication probe on the sealed view. Its security barrier
  // establishes eligibility before this finite query's predicate/order/limit;
  // raw `leaderboard_ranks` is never an alternative source for this endpoint.
  const { data, error } = await publicRankedLeaderboardClient(supabase)
    .from('public_ranked_leaderboard')
    .select('source,rank')
    .eq('season_id', PERIOD)
    .not('rank', 'is', null)
    .order('rank', { ascending: true, nullsFirst: false })
    .limit(1)

  if (error) throw error

  // Do not infer that a raw daily snapshot is valid simply because today's
  // rank is published. A current view row and a historical delta require two
  // independent proofs. The historical publication does not exist yet.
  const hasCurrentPublicCohort =
    Array.isArray(data) && data.length > 0 && data.every(isPublishedCurrentRank)
  return unavailableMovers(
    hasCurrentPublicCohort ? 'partial' : 'unknown',
    hasCurrentPublicCohort ? 'historical_mover_evidence_unavailable' : 'public_cohort_unavailable'
  )
}
