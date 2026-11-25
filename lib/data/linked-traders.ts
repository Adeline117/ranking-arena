/**
 * lib/data/linked-traders.ts
 *
 * Data helpers for multi-account linked traders.
 * Queries canonical `user_linked_traders`, with a legacy-table compatibility
 * fallback only when the canonical relation itself is unavailable.
 * Computes aggregated stats across all linked accounts.
 * Membership is read live. Unlinking an account is a privacy boundary, so this
 * module must not rely on process-local or delete-only caches for correctness.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import * as cache from '@/lib/cache'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import { normalizeDrawdownMagnitude } from '@/lib/utils/format'

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface LinkedTraderAccount {
  id: string
  userId: string
  platform: string
  traderKey: string
  handle: string | null
  label: string | null // custom user label (e.g. "Main Account")
  isPrimary: boolean
  linkedAt: string

  /**
   * Performance/ranking fields are hydrated only from the live sealed public
   * cohort. Membership remains useful while that cohort is unavailable, but
   * it must not carry an older raw leaderboard observation across the public
   * boundary.
   */
  roi: number | null
  pnl: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
  rank: number | null
  rankingVisibility: LinkedTraderRankingVisibility
  rankingVisibilityReason: LinkedTraderRankingVisibilityReason | null
}

export type LinkedTraderRankingVisibility = 'verified' | 'partial' | 'unknown'
export type LinkedTraderRankingVisibilityReason =
  | 'source_not_publicly_rankable'
  | 'public_cohort_unavailable'
  | 'public_rank_unavailable'
  | 'public_cohort_unverified'

export interface AggregatedStats {
  combinedPnl: number | null
  bestRoi: { value: number; platform: string; traderKey: string } | null
  weightedScore: number | null
  totalAccounts: number
  accounts: LinkedTraderAccount[]
}

// ─── Cache keys ────────────────────────────────────────────────────────────────

function linkedCacheKey(userId: string): string {
  return `linked-traders:v2:${userId}`
}

function aggCacheKey(userId: string): string {
  return `linked-traders-agg:v2:${userId}`
}

/**
 * Legacy public-route key retained only for deletion. The aggregate route is
 * no-store and must never write a rank-bearing payload without a fresh public
 * cohort proof, but unlinking also clears values written by older releases.
 */
export function linkedTraderRouteAggregateCacheKey(userId: string): string {
  return `aggregate:v2:user:${userId}`
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roiOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value)
  return parsed != null && parsed >= -10_000 && parsed <= 10_000 ? parsed : null
}

function boundedPercentOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value)
  return parsed != null && parsed >= 0 && parsed <= 100 ? parsed : null
}

function arenaScoreOrNull(value: unknown): number | null {
  const parsed = finiteNumberOrNull(value)
  return parsed != null && parsed > 0 && parsed <= 100 ? parsed : null
}

function positiveRankOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LINKED_RANKING_PERIOD = '90D'
const PUBLIC_LINKED_RANKING_COLUMNS =
  'source,source_trader_id,season_id,rank,arena_score,roi,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

interface PublicLinkedRankedRow extends Record<string, unknown> {
  source: string
  source_trader_id: string
  rank: number
}

interface LinkedPublicRankingCohort {
  /** Raw view rows detect duplicate/malformed identities before matching. */
  rawByIdentity: Map<string, number>
  /** Only rows that passed the full publication-policy sanitizer. */
  verifiedByIdentity: Map<string, PublicLinkedRankedRow[]>
  unavailable: boolean
}

function linkedRankingIdentity(source: string, traderKey: string): string {
  // A structural encoding avoids collisions from source/trader keys that may
  // themselves contain the separators historically used in cache keys.
  return JSON.stringify([source, traderKey])
}

function rowIdentity(row: unknown): string | null {
  if (
    !isRecord(row) ||
    typeof row.source !== 'string' ||
    typeof row.source_trader_id !== 'string' ||
    row.source.length === 0 ||
    row.source_trader_id.length === 0
  ) {
    return null
  }
  return linkedRankingIdentity(row.source, row.source_trader_id)
}

function incrementMapValue(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

function hasPositivePublishedRank(row: unknown): row is PublicLinkedRankedRow {
  return (
    isRecord(row) &&
    typeof row.source === 'string' &&
    isPublicRankingSourceAllowed(row.source) &&
    typeof row.source_trader_id === 'string' &&
    row.source_trader_id.length > 0 &&
    positiveRankOrNull(row.rank) !== null
  )
}

/**
 * A response from the security-barrier view is still treated as untrusted
 * transport. Keep raw identity multiplicity so a duplicate/filtered row for
 * one linked account cannot silently select a different matching row.
 */
function buildLinkedPublicRankingCohort(
  value: unknown,
  unavailable = false
): LinkedPublicRankingCohort {
  const rawRows = Array.isArray(value) ? value : []
  const rawByIdentity = new Map<string, number>()
  for (const row of rawRows) {
    const identity = rowIdentity(row)
    if (identity) incrementMapValue(rawByIdentity, identity)
  }

  const sanitized = sanitizePublicRankingPayload(
    { traders: rawRows, period: LINKED_RANKING_PERIOD },
    { expectedPeriod: LINKED_RANKING_PERIOD }
  ) as { traders?: unknown[] }
  const verifiedByIdentity = new Map<string, PublicLinkedRankedRow[]>()
  const rows = Array.isArray(sanitized.traders)
    ? sanitized.traders.filter(hasPositivePublishedRank)
    : []
  for (const row of rows) {
    const identity = rowIdentity(row)
    if (identity) appendMapValue(verifiedByIdentity, identity, row)
  }

  return { rawByIdentity, verifiedByIdentity, unavailable }
}

function clearLinkedRankingMetrics(
  account: LinkedTraderAccount,
  rankingVisibility: Exclude<LinkedTraderRankingVisibility, 'verified'>,
  rankingVisibilityReason: LinkedTraderRankingVisibilityReason
): void {
  account.roi = null
  account.pnl = null
  account.arenaScore = null
  account.winRate = null
  account.maxDrawdown = null
  account.rank = null
  account.rankingVisibility = rankingVisibility
  account.rankingVisibilityReason = rankingVisibilityReason
}

function applyVerifiedLinkedRanking(
  account: LinkedTraderAccount,
  cohort: LinkedPublicRankingCohort
): void {
  const identity = linkedRankingIdentity(account.platform, account.traderKey)
  if (cohort.unavailable) {
    clearLinkedRankingMetrics(account, 'unknown', 'public_cohort_unavailable')
    return
  }

  const rawRows = cohort.rawByIdentity.get(identity) ?? 0
  const verifiedRows = cohort.verifiedByIdentity.get(identity) ?? []
  if (rawRows === 0) {
    clearLinkedRankingMetrics(account, 'unknown', 'public_rank_unavailable')
    return
  }
  if (rawRows !== 1 || verifiedRows.length !== 1) {
    clearLinkedRankingMetrics(account, 'partial', 'public_cohort_unverified')
    return
  }

  const row = verifiedRows[0]
  const roi = roiOrNull(row.roi)
  const arenaScore = arenaScoreOrNull(row.arena_score)
  // Win rate and drawdown are optional on a ranked row: null means "not
  // provided". A value that is present must still be valid.
  const winRateProvided = row.win_rate !== null && row.win_rate !== undefined
  const maxDrawdownProvided = row.max_drawdown !== null && row.max_drawdown !== undefined
  const winRate = boundedPercentOrNull(row.win_rate)
  const maxDrawdown = normalizeDrawdownMagnitude(finiteNumberOrNull(row.max_drawdown))
  const rank = positiveRankOrNull(row.rank)
  if (
    roi === null ||
    arenaScore === null ||
    (winRateProvided && winRate === null) ||
    (maxDrawdownProvided && maxDrawdown === null) ||
    rank === null
  ) {
    // The sanitizer should make this unreachable, but do not promote a row if
    // a future policy/type drift weakens one of its assumptions.
    clearLinkedRankingMetrics(account, 'partial', 'public_cohort_unverified')
    return
  }

  account.roi = roi
  // A published rank row proves a performance window, not a settlement
  // currency. Keep cross-account Money unavailable until that separate
  // contract exists.
  account.pnl = null
  account.arenaScore = arenaScore
  account.winRate = winRate
  account.maxDrawdown = maxDrawdown
  account.rank = rank
  account.rankingVisibility = 'verified'
  account.rankingVisibilityReason = null
}

function isMissingRelationCompatibilityError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return false
  const code = (error as Record<string, unknown>).code
  return code === '42P01' || code === 'PGRST205'
}

// ─── Data Fetching ──────────────────────────────────────────────────────────────

/**
 * Fetch all linked trader accounts for a user, with their latest snapshot stats.
 * Tries `user_linked_traders` first. A successful empty canonical read is
 * authoritative: falling back then could resurrect a retired row after unlink.
 */
export async function getLinkedTraders(
  supabase: SupabaseClient,
  userId: string
): Promise<LinkedTraderAccount[]> {
  let links: LinkedTraderAccount[] = []

  // Strategy 1: user_linked_traders table (Phase 1)
  // Columns: trader_id (not trader_key), source (not platform), verified_at (not linked_at)
  const { data: ult, error: ultError } = await supabase
    .from('user_linked_traders')
    .select('id, user_id, source, trader_id, label, is_primary, verified_at')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .order('verified_at', { ascending: true })

  if (ultError && !isMissingRelationCompatibilityError(ultError)) {
    throw new Error(`linked trader lookup failed: ${ultError.message || 'unknown error'}`)
  }

  if (!ultError) {
    if (!ult || ult.length === 0) return []

    links = ult.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      userId: String(row.user_id),
      platform: String(row.source),
      traderKey: String(row.trader_id),
      handle: null, // not stored in user_linked_traders
      label: row.label as string | null,
      isPrimary: Boolean(row.is_primary),
      linkedAt: String(row.verified_at),
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_rank_unavailable',
    }))
  } else {
    // Compatibility fallback only for deployments where the canonical table
    // is genuinely unavailable. `trader_links` is retired and read-only.
    const { data: tl, error: tlError } = await supabase
      .from('trader_links')
      .select('id, user_id, trader_id, source, handle, verified_at, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })

    if (tlError) {
      throw new Error(`linked trader lookup failed: ${tlError.message || 'unknown error'}`)
    }
    if (!tl || tl.length === 0) {
      return []
    }

    links = tl.map((row: Record<string, unknown>, i: number) => ({
      id: String(row.id),
      userId: String(row.user_id),
      platform: String(row.source),
      traderKey: String(row.trader_id),
      handle: row.handle as string | null,
      label: null,
      isPrimary: i === 0,
      linkedAt: String(row.verified_at || row.created_at),
      roi: null,
      pnl: null,
      arenaScore: null,
      winRate: null,
      maxDrawdown: null,
      rank: null,
      rankingVisibility: 'unknown',
      rankingVisibilityReason: 'public_rank_unavailable',
    }))
  }

  if (links.length === 0) return []

  // Enrich from the sealed public cohort, grouped by platform to preserve the
  // exact source + key pair. Never substitute the retained raw rank table:
  // this response is public and every ranking metric needs a current proof.
  const byPlatform = new Map<string, string[]>()
  for (const link of links) {
    if (!isPublicRankingSourceAllowed(link.platform)) {
      clearLinkedRankingMetrics(link, 'partial', 'source_not_publicly_rankable')
      continue
    }
    const keys = byPlatform.get(link.platform) || []
    keys.push(link.traderKey)
    byPlatform.set(link.platform, keys)
  }

  const cohorts = new Map<string, LinkedPublicRankingCohort>()
  await Promise.all(
    [...byPlatform.entries()].map(async ([platform, traderKeys]) => {
      try {
        const { data, error } = await supabase
          .from('public_ranked_leaderboard')
          .select(PUBLIC_LINKED_RANKING_COLUMNS)
          .eq('source', platform)
          .in('source_trader_id', [...new Set(traderKeys)])
          .eq('season_id', LINKED_RANKING_PERIOD)
          .not('rank', 'is', null)
        if (error || !Array.isArray(data)) {
          if (error) {
            logger.warn(
              `[getLinkedTraders] public cohort query failed for ${platform}:`,
              error.message
            )
          }
          cohorts.set(platform, buildLinkedPublicRankingCohort([], true))
          return
        }
        cohorts.set(platform, buildLinkedPublicRankingCohort(data))
      } catch (error) {
        logger.warn(
          `[getLinkedTraders] public cohort query failed for ${platform}:`,
          error instanceof Error ? error.message : String(error)
        )
        cohorts.set(platform, buildLinkedPublicRankingCohort([], true))
      }
    })
  )

  // A failed cohort query is not a failed membership query. Preserve the
  // account relationship and make its ranking metrics explicit unknown.
  for (const link of links) {
    if (!isPublicRankingSourceAllowed(link.platform)) continue
    const cohort = cohorts.get(link.platform)
    if (!cohort) {
      clearLinkedRankingMetrics(link, 'unknown', 'public_cohort_unavailable')
      continue
    }
    applyVerifiedLinkedRanking(link, cohort)
  }

  return links
}

/**
 * Compute aggregated stats across all linked accounts for a user.
 *
 * Cross-source PnL is intentionally unavailable until every account carries
 * an attested settlement currency. A public ranking-window value must never
 * be summed or used as a cross-currency score weight by itself.
 *
 * Aggregate numerics remain unavailable until every intended account is bound
 * to the same complete, fresh publication contract. A complete-looking subset
 * must not masquerade as an aggregate.
 * - total_accounts: count
 */
export async function getAggregatedStats(
  supabase: SupabaseClient,
  userId: string
): Promise<AggregatedStats | null> {
  const accounts = await getLinkedTraders(supabase, userId)
  if (accounts.length === 0) return null

  const result: AggregatedStats = {
    combinedPnl: null,
    bestRoi: null,
    weightedScore: null,
    totalAccounts: accounts.length,
    accounts,
  }

  return result
}

/**
 * Look up a user_id from a trader's platform + traderKey.
 * Used to check if a trader profile page belongs to a user with linked accounts.
 */
export async function findUserByTrader(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string
): Promise<string | null> {
  // Try user_linked_traders first
  // Columns: source (not platform), trader_id (not trader_key)
  const { data: ult, error: ultError } = await supabase
    .from('user_linked_traders')
    .select('user_id')
    .eq('source', platform)
    .eq('trader_id', traderKey)
    .limit(1)
    .maybeSingle()
  if (ultError && !isMissingRelationCompatibilityError(ultError)) {
    throw new Error(`linked trader owner lookup failed: ${ultError.message || 'unknown error'}`)
  }
  if (ultError)
    logger.warn('[findUserByTrader] user_linked_traders query error (drift?):', ultError.message)

  if (ult?.user_id) return String(ult.user_id)

  // A successful canonical miss is authoritative. Falling through to the
  // retired table could re-publish an account that has since been unlinked.
  if (!ultError) return null

  // Compatibility fallback only when the canonical relation is unavailable.
  const { data: tl, error: tlError } = await supabase
    .from('trader_links')
    .select('user_id')
    .eq('source', platform)
    .eq('trader_id', traderKey)
    .limit(1)
    .maybeSingle()
  if (tlError) {
    throw new Error(
      `legacy linked trader owner lookup failed: ${tlError.message || 'unknown error'}`
    )
  }

  if (tl?.user_id) return String(tl.user_id)

  return null
}

/**
 * Invalidate cache for a user's linked traders.
 * Call this when a user links/unlinks an account.
 */
export async function invalidateLinkedTraderCache(userId: string): Promise<void> {
  try {
    await Promise.all([
      cache.del(`linked-traders:${userId}`),
      cache.del(linkedCacheKey(userId)),
      cache.del(`linked-traders-agg:${userId}`),
      cache.del(aggCacheKey(userId)),
      cache.del(`aggregate:user:${userId}`),
      cache.del(linkedTraderRouteAggregateCacheKey(userId)),
    ])
  } catch (err) {
    logger.warn('[linked-traders] Cache invalidation failed:', err)
  }
}
