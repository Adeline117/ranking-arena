/**
 * Personalized trader recommendations.
 *
 * Candidate selection may be cached by the route, but ranking-derived fields
 * are deliberately materialized from the sealed public cohort for every
 * response. A candidate is never ranking authority.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

const logger = createLogger('personal-rec')

const PERSONAL_RECOMMENDATION_PERIOD = '90D'
const MAX_PERSONAL_RECOMMENDATIONS = 50
const PERSONAL_RECOMMENDATION_SELECT =
  'season_id,source,source_trader_id,handle,avatar_url,rank,arena_score,roi,pnl,win_rate,max_drawdown,trades_count,followers,copiers,score_completeness,metrics_estimated,is_outlier,computed_at'

const PERSONAL_RECOMMENDATION_REASONS = [
  'similar_to_follow',
  'preferred_exchange',
  'top_performer',
] as const

export type PersonalRecommendationReason = (typeof PERSONAL_RECOMMENDATION_REASONS)[number]
export type PersonalRecommendationVisibility = 'verified' | 'partial' | 'unknown'

/**
 * This is the only shape that may cross the candidate-cache boundary. It has
 * no score, rank, ROI, PnL, or seed metric: those are all current-cohort data.
 */
export interface PersonalRecommendationCandidate {
  source: string
  source_trader_id: string
  reason: PersonalRecommendationReason
  reference_source?: string
  reference_trader_id?: string
}

export interface PersonalRecommendation {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number
  roi: number
  pnl: number
  /** Null when the ranked row carries no win rate (optional metric). */
  win_rate: number | null
  reason: PersonalRecommendationReason
  reason_detail: string
}

export interface PersonalRecommendationResult {
  recommendations: PersonalRecommendation[]
  rankingVisibility: PersonalRecommendationVisibility
  rankingVisibilityReason: string | null
}

interface FollowedTrader {
  source: string
  source_trader_id: string
  roi: number
}

interface FollowedTraderResult {
  traders: FollowedTrader[]
  hasFollows: boolean
}

interface PublicPersonalRankRow extends Record<string, unknown> {
  source: string
  source_trader_id: string
  season_id: string
  rank: number
  arena_score: number
  roi: number
  pnl: number
  win_rate: number | null
}

interface PublicPersonalCohort {
  rows: PublicPersonalRankRow[]
  rankingVisibility: PersonalRecommendationVisibility
  rankingVisibilityReason: string | null
}

interface ParsedCandidates {
  candidates: PersonalRecommendationCandidate[]
  rejected: boolean
}

function getSupabase() {
  return getSupabaseAdmin()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The sealed public cohort, typed by the generated view row
 * (database.types.ts public.Views.public_ranked_leaderboard).
 *
 * Idle-window rows (no ROI and no PnL in the period) are left out of every
 * read here: such a row is not recommended, and a followed trader in that
 * state is not a seed either (its ROI of 0 would make the "similar ROI" range
 * [0, 0], which matches only other idle rows). A cached candidate that has
 * since gone idle is dropped at materialization like any other stale one.
 */
function publicPersonalCohortQuery(supabase: ReturnType<typeof getSupabase>) {
  return supabase
    .from('public_ranked_leaderboard')
    .select(PERSONAL_RECOMMENDATION_SELECT)
    .eq('season_id', PERSONAL_RECOMMENDATION_PERIOD)
    .not('rank', 'is', null)
    .eq('idle_window', false)
}

type PublicRankedLeaderboardQuery = ReturnType<typeof publicPersonalCohortQuery>
type PublicRankedLeaderboardResult = PromiseLike<{ data: unknown[] | null; error: unknown }>

function isCanonicalPublicSource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim().toLowerCase() &&
    isPublicRankingSourceAllowed(value)
  )
}

function isTraderIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function personalIdentity(source: string, sourceTraderId: string): string {
  return `${source}:${sourceTraderId}`
}

function isPersonalRecommendationReason(value: unknown): value is PersonalRecommendationReason {
  return (
    typeof value === 'string' &&
    (PERSONAL_RECOMMENDATION_REASONS as readonly string[]).includes(value)
  )
}

function hasVerifiedPublicPersonalRank(row: unknown): row is PublicPersonalRankRow {
  return (
    isRecord(row) &&
    isCanonicalPublicSource(row.source) &&
    isTraderIdentity(row.source_trader_id) &&
    row.season_id === PERSONAL_RECOMMENDATION_PERIOD &&
    typeof row.rank === 'number' &&
    Number.isSafeInteger(row.rank) &&
    row.rank > 0 &&
    typeof row.arena_score === 'number' &&
    Number.isFinite(row.arena_score) &&
    row.arena_score > 0 &&
    typeof row.roi === 'number' &&
    Number.isFinite(row.roi) &&
    typeof row.pnl === 'number' &&
    Number.isFinite(row.pnl) &&
    // Optional on a ranked row: null means the source did not provide it.
    (row.win_rate === null ||
      (typeof row.win_rate === 'number' &&
        Number.isFinite(row.win_rate) &&
        row.win_rate >= 0 &&
        row.win_rate <= 100))
  )
}

/**
 * A malformed or filtered view response is not a smaller finite cohort. The
 * whole query becomes partial so a later row cannot silently replace it.
 */
function verifyPublicPersonalCohort(value: unknown): PublicPersonalCohort {
  if (!Array.isArray(value)) {
    return {
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
    }
  }

  const sanitized = sanitizePublicRankingPayload(
    { traders: value, period: PERSONAL_RECOMMENDATION_PERIOD },
    { expectedPeriod: PERSONAL_RECOMMENDATION_PERIOD }
  ) as { traders?: unknown[] }
  const rows = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter(hasVerifiedPublicPersonalRank)
    : []

  if (rows.length !== value.length) {
    return {
      rows: [],
      rankingVisibility: 'partial',
      rankingVisibilityReason: 'public_cohort_unverified',
    }
  }

  return { rows, rankingVisibility: 'verified', rankingVisibilityReason: null }
}

async function readPublicPersonalCohort(
  supabase: ReturnType<typeof getSupabase>,
  buildQuery: (query: PublicRankedLeaderboardQuery) => PublicRankedLeaderboardResult
): Promise<PublicPersonalCohort> {
  try {
    const { data, error } = await buildQuery(publicPersonalCohortQuery(supabase))
    if (error) {
      logger.warn('Personal recommendation cohort query failed', { error })
      return {
        rows: [],
        rankingVisibility: 'unknown',
        rankingVisibilityReason: 'public_cohort_unavailable',
      }
    }

    return verifyPublicPersonalCohort(data)
  } catch (error) {
    logger.warn('Personal recommendation cohort is unavailable', { error })
    return {
      rows: [],
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_cohort_unavailable',
    }
  }
}

function rowsForExpectedScope(
  cohort: PublicPersonalCohort,
  predicate: (row: PublicPersonalRankRow) => boolean
): PublicPersonalRankRow[] {
  if (cohort.rankingVisibility !== 'verified') return []
  // The view predicates should make this redundant. Treat a proxy/schema
  // boundary that returns an out-of-scope row as an invalid cohort, not a
  // source for a near-match recommendation.
  return cohort.rows.every(predicate) ? cohort.rows : []
}

function clampLimit(value: number, fallback = 20): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_PERSONAL_RECOMMENDATIONS, Math.max(1, Math.floor(value)))
}

function parseCandidate(value: unknown): PersonalRecommendationCandidate | null {
  if (!isRecord(value)) return null
  if (
    !isCanonicalPublicSource(value.source) ||
    !isTraderIdentity(value.source_trader_id) ||
    !isPersonalRecommendationReason(value.reason)
  ) {
    return null
  }

  if (value.reason === 'similar_to_follow') {
    if (
      !isCanonicalPublicSource(value.reference_source) ||
      !isTraderIdentity(value.reference_trader_id) ||
      (value.reference_source === value.source &&
        value.reference_trader_id === value.source_trader_id)
    ) {
      return null
    }
    return {
      source: value.source,
      source_trader_id: value.source_trader_id,
      reason: value.reason,
      reference_source: value.reference_source,
      reference_trader_id: value.reference_trader_id,
    }
  }

  return {
    source: value.source,
    source_trader_id: value.source_trader_id,
    reason: value.reason,
  }
}

function parseCandidates(value: unknown, limit: number): ParsedCandidates {
  if (!Array.isArray(value)) return { candidates: [], rejected: value !== undefined }

  const candidates: PersonalRecommendationCandidate[] = []
  const seen = new Set<string>()
  let rejected = false
  for (const rawCandidate of value) {
    const candidate = parseCandidate(rawCandidate)
    if (!candidate) {
      rejected = true
      continue
    }

    const identity = personalIdentity(candidate.source, candidate.source_trader_id)
    if (seen.has(identity)) {
      rejected = true
      continue
    }
    seen.add(identity)
    candidates.push(candidate)
    if (candidates.length >= limit) break
  }
  return { candidates, rejected }
}

/**
 * Public helper for cache callers. It creates a new, metric-free object, so
 * obsolete cache entries cannot make a score or ROI available to consumers.
 */
export function sanitizePersonalRecommendationCandidates(
  value: unknown,
  limit = MAX_PERSONAL_RECOMMENDATIONS
): PersonalRecommendationCandidate[] {
  return parseCandidates(value, clampLimit(limit, MAX_PERSONAL_RECOMMENDATIONS)).candidates
}

async function getUserFollowedTraders(
  supabase: ReturnType<typeof getSupabase>,
  userId: string
): Promise<FollowedTraderResult> {
  try {
    const { data: follows, error } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .limit(50)

    if (error) {
      logger.warn('Personal recommendation follows query failed', { error })
      return { traders: [], hasFollows: true }
    }

    if (!Array.isArray(follows)) {
      logger.warn('Personal recommendation follows response is malformed')
      return { traders: [], hasFollows: true }
    }
    const rawFollows = follows
    if (rawFollows.length === 0) return { traders: [], hasFollows: false }

    const followingIds = [
      ...new Set(
        rawFollows
          .map((follow) => (isRecord(follow) ? follow.following_id : null))
          .filter(isTraderIdentity)
      ),
    ]
    if (followingIds.length === 0) return { traders: [], hasFollows: true }

    const cohort = await readPublicPersonalCohort(supabase, (query) =>
      query.in('source_trader_id', followingIds).limit(50)
    )
    const rows = rowsForExpectedScope(cohort, (row) => followingIds.includes(row.source_trader_id))
    if (rows.length === 0) return { traders: [], hasFollows: true }
    return {
      traders: rows.map((row) => ({
        source: row.source,
        source_trader_id: row.source_trader_id,
        roi: row.roi,
      })),
      hasFollows: true,
    }
  } catch (error) {
    logger.warn('Personal recommendation followed traders failed', { error })
    return { traders: [], hasFollows: true }
  }
}

async function findSimilarTraders(
  supabase: ReturnType<typeof getSupabase>,
  baseTrader: FollowedTrader,
  limit: number
): Promise<PublicPersonalRankRow[]> {
  const firstBound = baseTrader.roi * 0.7
  const secondBound = baseTrader.roi * 1.3
  const roiMin = Math.min(firstBound, secondBound)
  const roiMax = Math.max(firstBound, secondBound)

  const cohort = await readPublicPersonalCohort(supabase, (query) =>
    query
      .eq('source', baseTrader.source)
      .gte('roi', roiMin)
      .lte('roi', roiMax)
      .neq('source_trader_id', baseTrader.source_trader_id)
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('arena_score', { ascending: false, nullsFirst: false })
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(limit)
  )

  return rowsForExpectedScope(
    cohort,
    (row) =>
      row.source === baseTrader.source && row.source_trader_id !== baseTrader.source_trader_id
  )
}

async function getTopFromExchanges(
  supabase: ReturnType<typeof getSupabase>,
  exchanges: readonly string[],
  limit: number
): Promise<PublicPersonalRankRow[]> {
  if (exchanges.length === 0) return []

  const cohort = await readPublicPersonalCohort(supabase, (query) =>
    query
      .in('source', exchanges)
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('arena_score', { ascending: false, nullsFirst: false })
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(limit)
  )
  return rowsForExpectedScope(cohort, (row) => exchanges.includes(row.source))
}

async function getTopPerformersFallback(
  supabase: ReturnType<typeof getSupabase>,
  limit: number
): Promise<PersonalRecommendationCandidate[]> {
  const cohort = await readPublicPersonalCohort(supabase, (query) =>
    query
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('arena_score', { ascending: false, nullsFirst: false })
      .order('rank', { ascending: true, nullsFirst: false })
      .limit(limit)
  )
  if (cohort.rankingVisibility !== 'verified') return []

  return cohort.rows.map((row) => ({
    source: row.source,
    source_trader_id: row.source_trader_id,
    reason: 'top_performer' as const,
  }))
}

/**
 * Build metric-free recommendation candidates. The route may cache the return
 * value, but it must call materializePersonalRecommendations before replying.
 */
export async function getPersonalRecommendationCandidates(
  userId: string,
  limit = 20
): Promise<PersonalRecommendationCandidate[]> {
  const cappedLimit = clampLimit(limit)
  const supabase = getSupabase()
  const followed = await getUserFollowedTraders(supabase, userId)

  if (!followed.hasFollows) {
    return getTopPerformersFallback(supabase, cappedLimit)
  }
  // A user who does have follows but whose seed rows cannot be verified must
  // not receive a fabricated personalization fallback. The route represents
  // this empty candidate set as explicit unknown/partial state.
  if (followed.traders.length === 0) return []

  const followedTraders = followed.traders

  const followedSet = new Set(
    followedTraders.map((trader) => personalIdentity(trader.source, trader.source_trader_id))
  )
  const candidates: PersonalRecommendationCandidate[] = []

  for (const trader of followedTraders.slice(0, 10)) {
    const similar = await findSimilarTraders(supabase, trader, 5)
    for (const current of similar) {
      const identity = personalIdentity(current.source, current.source_trader_id)
      if (followedSet.has(identity)) continue
      followedSet.add(identity)
      candidates.push({
        source: current.source,
        source_trader_id: current.source_trader_id,
        reason: 'similar_to_follow',
        reference_source: trader.source,
        reference_trader_id: trader.source_trader_id,
      })
      if (candidates.length >= cappedLimit) break
    }
    if (candidates.length >= cappedLimit) break
  }

  if (candidates.length < cappedLimit) {
    const preferredExchanges = [...new Set(followedTraders.map((trader) => trader.source))].slice(
      0,
      5
    )
    const topFromPreferred = await getTopFromExchanges(
      supabase,
      preferredExchanges,
      (cappedLimit - candidates.length) * 2
    )
    for (const current of topFromPreferred) {
      const identity = personalIdentity(current.source, current.source_trader_id)
      if (followedSet.has(identity)) continue
      followedSet.add(identity)
      candidates.push({
        source: current.source,
        source_trader_id: current.source_trader_id,
        reason: 'preferred_exchange',
      })
      if (candidates.length >= cappedLimit) break
    }
  }

  // If a source-specific lookup cannot supply a recommendation, a current
  // top cohort is still safer than returning a raw/partial profile observation.
  if (candidates.length === 0) return getTopPerformersFallback(supabase, cappedLimit)

  return sanitizePersonalRecommendationCandidates(candidates, cappedLimit)
}

function recommendationReasonDetail(
  candidate: PersonalRecommendationCandidate,
  current: PublicPersonalRankRow
): string {
  if (candidate.reason === 'similar_to_follow') {
    return `Similar to ${candidate.reference_trader_id} on ${candidate.reference_source}`
  }
  if (candidate.reason === 'preferred_exchange') return `Top on ${current.source}`
  return `Top arena score on ${current.source}`
}

function materializeRecommendation(
  candidate: PersonalRecommendationCandidate,
  current: PublicPersonalRankRow
): PersonalRecommendation {
  return {
    source: current.source,
    source_trader_id: current.source_trader_id,
    handle: typeof current.handle === 'string' ? current.handle : null,
    avatar_url: typeof current.avatar_url === 'string' ? current.avatar_url : null,
    arena_score: current.arena_score,
    roi: current.roi,
    pnl: current.pnl,
    win_rate: current.win_rate,
    reason: candidate.reason,
    reason_detail: recommendationReasonDetail(candidate, current),
  }
}

function unavailablePersonalRecommendations(
  rankingVisibility: PersonalRecommendationVisibility,
  rankingVisibilityReason: string
): PersonalRecommendationResult {
  return { recommendations: [], rankingVisibility, rankingVisibilityReason }
}

/**
 * Materialize only the current verified rows for cached candidates. Any stale,
 * unverified, or malformed candidate is omitted; it is never a zero-valued
 * substitute and never leaks cached ranking fields.
 */
export async function materializePersonalRecommendations(
  cachedCandidates: unknown,
  limit = 20
): Promise<PersonalRecommendationResult> {
  const cappedLimit = clampLimit(limit)
  const parsed = parseCandidates(cachedCandidates, MAX_PERSONAL_RECOMMENDATIONS)
  if (parsed.candidates.length === 0) {
    return unavailablePersonalRecommendations(
      parsed.rejected ? 'partial' : 'unknown',
      parsed.rejected ? 'cached_candidate_unverified' : 'public_rank_unavailable'
    )
  }

  const identitiesBySource = new Map<string, Set<string>>()
  const addCurrentIdentity = (source: string, sourceTraderId: string) => {
    const ids = identitiesBySource.get(source) ?? new Set<string>()
    ids.add(sourceTraderId)
    identitiesBySource.set(source, ids)
  }
  for (const candidate of parsed.candidates) {
    addCurrentIdentity(candidate.source, candidate.source_trader_id)
    if (candidate.reason === 'similar_to_follow') {
      addCurrentIdentity(candidate.reference_source!, candidate.reference_trader_id!)
    }
  }

  // Query one source at a time. A cross-product `in(source)` plus
  // `in(source_trader_id)` query can truncate away the exact pair we need.
  // Every source-local response still gets the complete sanitizer pass.
  const cohorts = await Promise.all(
    [...identitiesBySource.entries()].map(async ([source, ids]) => ({
      source,
      ids,
      cohort: await readPublicPersonalCohort(getSupabase(), (query) =>
        query
          .eq('source', source)
          .in('source_trader_id', [...ids])
          .limit(ids.size)
      ),
    }))
  )
  const currentByIdentity = new Map<string, PublicPersonalRankRow>()
  for (const { source, ids, cohort } of cohorts) {
    if (cohort.rankingVisibility !== 'verified') {
      return unavailablePersonalRecommendations(
        cohort.rankingVisibility,
        cohort.rankingVisibilityReason ?? 'public_cohort_unavailable'
      )
    }
    for (const row of cohort.rows) {
      if (row.source !== source || !ids.has(row.source_trader_id)) {
        return unavailablePersonalRecommendations('partial', 'public_cohort_unverified')
      }
      const identity = personalIdentity(row.source, row.source_trader_id)
      if (currentByIdentity.has(identity)) {
        return unavailablePersonalRecommendations('partial', 'public_cohort_unverified')
      }
      currentByIdentity.set(identity, row)
    }
  }

  const recommendations: PersonalRecommendation[] = []
  let staleCandidate = parsed.rejected
  for (const candidate of parsed.candidates) {
    if (recommendations.length >= cappedLimit) break
    const identity = personalIdentity(candidate.source, candidate.source_trader_id)
    const current = currentByIdentity.get(identity)
    if (!current) {
      staleCandidate = true
      continue
    }
    if (candidate.reason === 'similar_to_follow') {
      const referenceIdentity = personalIdentity(
        candidate.reference_source!,
        candidate.reference_trader_id!
      )
      if (!currentByIdentity.has(referenceIdentity)) {
        staleCandidate = true
        continue
      }
    }
    recommendations.push(materializeRecommendation(candidate, current))
  }

  if (recommendations.length === 0) {
    return unavailablePersonalRecommendations(
      staleCandidate ? 'partial' : 'unknown',
      staleCandidate ? 'cached_candidate_unverified' : 'public_rank_unavailable'
    )
  }

  return {
    recommendations,
    rankingVisibility: staleCandidate ? 'partial' : 'verified',
    rankingVisibilityReason: staleCandidate ? 'cached_candidate_unverified' : null,
  }
}

/**
 * Compatibility helper for direct callers. API routes should cache only
 * getPersonalRecommendationCandidates and always materialize before return.
 */
export async function getPersonalRecommendations(
  userId: string,
  limit = 20
): Promise<PersonalRecommendation[]> {
  const candidates = await getPersonalRecommendationCandidates(userId, limit)
  return (await materializePersonalRecommendations(candidates, limit)).recommendations
}
