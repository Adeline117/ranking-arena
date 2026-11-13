/**
 * Server-side function to fetch initial traders for SSR
 * This reduces LCP by eliminating client-side data fetching waterfall
 *
 * Uses the unified data layer (lib/data/unified.ts) as the single source of truth.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { Period } from '@/lib/utils/arena-score'
import type { ScoreConfidence } from '@/lib/utils/arena-score'
import type { UnifiedTrader } from '@/lib/types/unified-trader'
import { getLeaderboard } from '@/lib/data/unified'
import { isInPublicCohort } from '@/lib/rankings/public-cohort'
import { attachAvatarMirrors } from '@/lib/data/avatar-mirrors'
import { logger, fireAndForget } from '@/lib/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import * as cache from '@/lib/cache'
import {
  summarizeSourceFreshness,
  type SourceFreshnessRow,
  type SourceFreshnessSummary,
} from '@/lib/rankings/source-freshness'
import {
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  publicRankingCacheKey,
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
export interface InitialTrader {
  id: string
  handle: string
  /** Persisted publication rank; never inferred from page position. */
  rank: number
  /** Null is an unknown source metric, never a synthetic zero. */
  roi: number | null
  /** Null is an unknown source metric, never a synthetic zero. */
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  followers: number
  source: string
  source_type: 'futures' | 'spot' | 'web3'
  avatar_url: string | null
  /** Existing Supabase-Storage mirror, preferred when it remains direct-safe. */
  avatar_url_mirror?: string | null
  /** Null means the source did not publish a score we can safely present. */
  arena_score: number | null
  /** Sharpe ratio — populated from leaderboard_ranks.sharpe_ratio (DEX/computed
   *  sources); null for CEX that don't supply it. Was dropped by this type so the
   *  SSR card always rendered "—" (audit 2026-07-03). */
  sharpe: number | null
  /** Closed trades in the window. Explicit 0 = confirmed zero-trade wallet
   *  ("Holder" — win% undefined by design); null = unknown/not captured. */
  trades_count: number | null
  /** The source did not provide a confidence level. Keep that uncertainty explicit. */
  score_confidence: ScoreConfidence | null
  /** Rank movement vs previous compute run (+ = climbed) — drives ↑/↓ arrows. */
  rank_change?: number | null
  /** First appearance on the board this run (NEW badge). */
  is_new?: boolean
  /**
   * Display-only fields /api/traders also returns. Carried on the SSR row so
   * the first paint and the client refresh render the same badges/metrics
   * (both go through app/components/ranking/toUiTrader.ts). Optional because
   * Redis payloads written before these existed simply lack them (→ unknown).
   */
  copiers?: number | null
  sharpe_ratio?: number | null
  sortino_ratio?: number | null
  calmar_ratio?: number | null
  profit_factor?: number | null
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  trading_style?: string | null
  avg_holding_hours?: number | null
  trader_type?: string | null
  /**
   * Cache-revalidation evidence copied from the verified cohort view. These
   * columns are public view fields, not derived UI state: retaining them lets
   * a Redis payload be rechecked before it can re-enter a ranking surface.
   */
  source_trader_id: string
  season_id: Period
  score_completeness: 'full'
  metrics_estimated: false
  computed_at: string
  is_outlier: false
}

/**
 * Map a UnifiedTrader to the InitialTrader interface used by frontend components.
 */
function mapUnifiedToInitial(t: UnifiedTrader): InitialTrader | null {
  if (t.rank == null) return null
  // Never let a legacy aggregator key be relabelled into a public source after
  // the database cohort has selected it. The verified view already enforces
  // this; keeping the guard here makes a malformed proxy/cache response fail
  // closed before the Copin display-only rewrite below can hide its origin.
  if (!isPublicRankingSourceAllowed(t.platform)) return null
  if (t.scoreCompleteness !== 'full' || t.metricsEstimated !== false || t.isOutlier) return null

  const displayPlatform = t.platform
  const displayKey = t.traderKey

  const rawHandle = (t.handle && t.handle.trim()) || displayKey
  // Format 0x addresses nicely: 0x880ac484a174... → 0x880a...a174
  let displayHandle = sanitizeDisplayName(rawHandle)
  if (displayHandle.startsWith('0x') && displayHandle.length > 14) {
    displayHandle = `${displayHandle.slice(0, 6)}...${displayHandle.slice(-4)}`
  }

  return {
    id: displayKey,
    handle: displayHandle,
    rank: t.rank,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers ?? 0,
    source: displayPlatform,
    source_type: (t.sourceType as 'futures' | 'spot' | 'web3') || 'futures',
    avatar_url: t.avatarUrl,
    avatar_url_mirror: null, // enriched post-fetch via attachAvatarMirrors
    arena_score: t.arenaScore,
    sharpe: t.sharpeRatio ?? null,
    trades_count: t.tradesCount ?? null,
    // Do not infer confidence from a rank or from the presence of other fields.
    // An absent source value is unknown, not "full" confidence.
    score_confidence:
      t.scoreConfidence === 'full' ||
      t.scoreConfidence === 'partial' ||
      t.scoreConfidence === 'minimal'
        ? t.scoreConfidence
        : null,
    rank_change: t.rankChange ?? null,
    is_new: t.isNew === true,
    copiers: t.copiers ?? null,
    sharpe_ratio: t.sharpeRatio ?? null,
    sortino_ratio: t.sortinoRatio ?? null,
    calmar_ratio: t.calmarRatio ?? null,
    profit_factor: t.profitFactor ?? null,
    profitability_score: t.profitabilityScore ?? null,
    risk_control_score: t.riskControlScore ?? null,
    execution_score: t.executionScore ?? null,
    trading_style: t.tradingStyle ?? null,
    avg_holding_hours: t.avgHoldingHours ?? null,
    trader_type: t.traderType ?? null,
    // getLeaderboard reads public_ranked_leaderboard, which fixes these
    // values as part of the database eligibility predicate. Preserve the
    // values actually observed at that boundary instead of manufacturing
    // proof constants: a Redis entry must remain independently recheckable
    // by sanitizePublicRankingPayload on every read.
    source_trader_id: t.traderKey,
    season_id: t.period,
    score_completeness: t.scoreCompleteness,
    metrics_estimated: t.metricsEstimated,
    computed_at: t.lastUpdated ?? '',
    is_outlier: t.isOutlier,
  }
}

export interface CategoryCounts {
  /** Unknown until a same-predicate cohort count authority exists. */
  all: number | null
  futures: number | null
  spot: number | null
  onchain: number | null
}

export interface InitialTradersResult {
  traders: InitialTrader[]
  lastUpdated: string | null
  isStale: boolean
  /** Null means no same-predicate exact count authority is available. */
  totalCount: number | null
  /** A total is only displayable as exact when this is true. */
  totalCountIsExact: boolean
  /** Determined by an extra row from public_ranked_leaderboard. */
  hasMore: boolean
  categoryCounts: CategoryCounts
  /** Category badges are hidden unless this is true. */
  categoryCountsAreExact: boolean
  /**
   * Page-scoped upstream watermarks retained only to re-evaluate a Redis
   * payload. The client receives the resulting `lastUpdated`/`isStale`, not
   * this internal proof list.
   */
  sourceFreshness: SourceFreshnessRow[]
  /**
   * Internal cache proof: the SQL limit+1 row that witnessed `hasMore`.
   * Stored with the Redis entry so a cache hit can re-run the same row proof
   * on it before claiming a next page. Never forwarded to the client.
   */
  lookaheadWitness?: InitialTrader | null
}

const UNKNOWN_CATEGORY_COUNTS: CategoryCounts = {
  all: null,
  futures: null,
  spot: null,
  onchain: null,
}

function unknownInitialTradersResult(isStale = true): InitialTradersResult {
  return {
    traders: [],
    lastUpdated: null,
    isStale,
    totalCount: null,
    totalCountIsExact: false,
    hasMore: false,
    categoryCounts: UNKNOWN_CATEGORY_COUNTS,
    categoryCountsAreExact: false,
    sourceFreshness: [],
  }
}

function hasPublishedInitialRank(value: unknown): value is InitialTrader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rank = (value as { rank?: unknown }).rank
  return typeof rank === 'number' && Number.isSafeInteger(rank) && rank > 0
}

function isCurrentHomepageCohortRow(value: InitialTrader, nowMs = Date.now()): boolean {
  return isInPublicCohort(value, nowMs)
}

/**
 * Re-prove a cached look-ahead witness with the same checks the visible rows
 * pass: publication proof, upstream source
 * watermark, the shared public-cohort predicate (lib/rankings/public-cohort:
 * score > 0, |roi| ≤ 50 000, 48h), and ordering after the last visible row.
 */
function isValidCachedLookahead(
  witness: unknown,
  visible: readonly InitialTrader[],
  sourceFreshness: readonly SourceFreshnessRow[],
  timeRange: Period
): boolean {
  if (!hasPublishedInitialRank(witness)) return false
  const checked = sanitizePublicRankingPayload(
    { traders: [witness] },
    { expectedPeriod: timeRange }
  )
  if (!Array.isArray(checked.traders) || checked.traders.length !== 1) return false
  // Shared public-cohort predicate (score > 0, |roi| ≤ 50 000, 48h) — the same
  // rule the visible rows pass in sanitizeInitialTradersResult.
  if (!isInPublicCohort(witness)) return false
  const lastVisibleRank = visible.reduce((max, trader) => Math.max(max, trader.rank), 0)
  if (!(witness.rank > lastVisibleRank)) return false
  return !summarizeInitialTraderFreshness({
    watermarkRows: sourceFreshness,
    observedSources: [witness.source],
  }).isStale
}

function sanitizeCachedFreshnessRows(value: unknown): SourceFreshnessRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return []
    const record = row as Record<string, unknown>
    if (typeof record.source !== 'string' || record.source.length === 0) return []
    if (record.source_as_of !== null && typeof record.source_as_of !== 'string') return []
    return [{ source: record.source, source_as_of: record.source_as_of }]
  })
}

/**
 * Redis is an availability cache, never a ranking authority. Re-run the full
 * row proof before serving it and downgrade all count/paging claims whenever
 * any row is removed. The strict proof fields are intentionally retained on
 * InitialTrader for this purpose.
 */
function sanitizeInitialTradersResult(
  payload: InitialTradersResult | null,
  timeRange: Period,
  options: { fromCache?: boolean } = {}
): InitialTradersResult | null {
  if (payload === null) return null

  const sanitized = sanitizePublicRankingPayload(payload, { expectedPeriod: timeRange })
  const originalTraders = Array.isArray(payload.traders) ? payload.traders : []
  const proofValidTraders = Array.isArray(sanitized.traders)
    ? sanitized.traders
        .filter(hasPublishedInitialRank)
        .filter((trader) => isCurrentHomepageCohortRow(trader))
    : []
  const sourceFreshness = sanitizeCachedFreshnessRows(payload.sourceFreshness)
  const freshness = summarizeInitialTraderFreshness({
    watermarkRows: sourceFreshness,
    observedSources: proofValidTraders.map((trader) => trader.source),
  })
  // A cached source watermark can cross the hard serving boundary while the
  // Redis entry remains alive. `computed_at` is not a substitute for upstream
  // capture time: if any displayed source is missing, invalid, stale, or too
  // far in the future, none of its cached rows may retain a public rank.
  const filteredTraders = freshness.isStale ? [] : proofValidTraders
  const removed = filteredTraders.length !== originalTraders.length
  const totalCountIsExact =
    !removed &&
    sanitized.totalCountIsExact === true &&
    typeof sanitized.totalCount === 'number' &&
    Number.isSafeInteger(sanitized.totalCount) &&
    sanitized.totalCount >= 0

  const { lookaheadWitness: _unverifiedWitness, ...sanitizedRest } = sanitized
  return {
    ...sanitizedRest,
    traders: filteredTraders,
    // A Redis entry retains only the visible page, not the SQL look-ahead row
    // that originally witnessed `hasMore`. Even when every visible row still
    // passes revalidation, that omitted witness might have become partial,
    // stale, or otherwise ineligible meanwhile. Do not turn a cached boolean
    // into a navigation claim without rechecking the extra row too.
    //
    // Fresh DB results retain their in-request, view-filtered look-ahead
    // witness. A future cache format may preserve and revalidate that witness
    // explicitly; until then cache hits fail closed for next-page navigation.
    //
    // Cache entries now carry that witness (`lookaheadWitness`) and a cache
    // hit claims a next page only when it passes the same row proof again.
    // Entries without a witness (older format) still fail closed.
    hasMore:
      removed || freshness.isStale
        ? false
        : options.fromCache
          ? sanitized.hasMore === true &&
            isValidCachedLookahead(
              payload.lookaheadWitness,
              filteredTraders,
              sourceFreshness,
              timeRange
            )
          : sanitized.hasMore === true,
    // Keep the witness (when well-formed) so a fresh result can be cached
    // with it; omitted otherwise. page.tsx never forwards it to the client.
    lookaheadWitness: hasPublishedInitialRank(payload.lookaheadWitness)
      ? payload.lookaheadWitness
      : undefined,
    totalCount: totalCountIsExact ? sanitized.totalCount : null,
    totalCountIsExact,
    categoryCounts: UNKNOWN_CATEGORY_COUNTS,
    categoryCountsAreExact: false,
    sourceFreshness,
    lastUpdated: freshness.asOf,
    isStale: removed || freshness.isStale || sanitized.isStale === true,
  }
}

function staleCacheResult(
  ...candidates: Array<InitialTradersResult | null>
): InitialTradersResult | null {
  const stale = candidates.find(
    (candidate) => candidate && Array.isArray(candidate.traders) && candidate.traders.length > 0
  )
  return stale ? { ...stale, isStale: true } : null
}

function normalizeInitialPageLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 50) : 20
}

function normalizeInitialPage(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Single source of truth for the SSR homepage cache keys — shared by the
 * reader (getInitialTraders) and the warm-cache writers so they can never
 * drift onto different keys again.
 * v3 (2026-07-12): shape gained rank_change/is_new — bumped so 2h-TTL v2
 * entries (without the new fields) don't serve arrow-less rows for hours.
 * v4 (2026-07-18): lastUpdated is the oldest live source-data watermark,
 * never leaderboard_ranks.computed_at.
 * v5 (2026-08-16): nullable ROI/PnL/score/confidence are preserved end-to-end.
 * v6 (2026-08-16): rows now originate in public_ranked_leaderboard and retain
 * proof fields for cache revalidation; old source-only cache entries cannot
 * participate in ranking pagination.
 * v7 (2026-08-16): includes page-scoped source-watermark proof and normalized
 * page size; cached rows are rechecked against the homepage's 6-hour cohort
 * window rather than the generic 48-hour publication ceiling.
 */
export function homeInitialTradersCacheKeys(timeRange: Period, page: number, limit = 50) {
  const safePage = normalizeInitialPage(page)
  const safeLimit = normalizeInitialPageLimit(limit)
  return {
    cacheKey: publicRankingCacheKey(
      `home-initial-traders-v7:${timeRange}:n${safeLimit}:p${safePage}`
    ),
    fallbackKey: publicRankingCacheKey(
      `home-initial-traders-fallback-v7:${timeRange}:n${safeLimit}:p${safePage}`
    ),
  }
}

/**
 * Force-refresh the SSR homepage cache (warm-cache cron + compute-leaderboard
 * post-processing). Both callers previously ran fetchLeaderboardFromDB and
 * DROPPED the result — cache.set only lived inside getInitialTraders, so the
 * "warm" was a no-op DB query and the log line lied. Returns rows cached.
 */
export async function refreshHomeInitialTradersCache(
  timeRange: Period = '90D',
  limit = 50
): Promise<number> {
  const writeFence = await cache.readSharedCacheWriteFence(PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY)
  if (!writeFence) throw new Error('SSR homepage cache write fence was not available')
  const safeLimit = normalizeInitialPageLimit(limit)
  const result = await fetchLeaderboardFromDB(timeRange, safeLimit, 0)
  if (result.traders.length === 0) return 0
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, 0, safeLimit)
  const writes = await Promise.all([
    cache.set(cacheKey, result, {
      ttl: PUBLIC_RANKING_PRIMARY_CACHE_TTL_SECONDS,
      tags: [PUBLIC_RANKING_REDIS_TAG, `season:${timeRange}`],
      skipMemory: true,
      writeFence,
    }),
    cache.set(fallbackKey, result, {
      ttl: 14400,
      tags: [PUBLIC_RANKING_REDIS_TAG, `season:${timeRange}`],
      skipMemory: true,
      writeFence,
    }),
  ])
  if (writes.some((written) => !written)) {
    throw new Error('SSR homepage Redis cache write was not confirmed')
  }
  return result.traders.length
}

/**
 * Upper bound on how long the homepage can keep showing rows that the database
 * has since withdrawn WITHOUT a publication (source quarantine by migration,
 * serving-head/season fence invalidation): those paths do not advance the
 * shared write fence, so only cache age bounds them. Matches /api/traders'
 * 300s cohort cache and the homepage ISR revalidate window.
 */
export const PUBLIC_RANKING_PRIMARY_CACHE_TTL_SECONDS = 300

export async function getInitialTraders(
  timeRange: Period = '90D',
  limit: number = 20,
  page: number = 0
): Promise<InitialTradersResult> {
  // During Vercel build, Supabase queries hang (iad1 build server -> timeout).
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return unknownInitialTradersResult()
  }

  // Try Redis cache first — fresh hit returns immediately.
  // Two-tier cache strategy:
  //   1. Primary cache (2h TTL) — normal serving
  //   2. Fallback cache (4h TTL) — safety net when DB is down/slow
  const safeLimit = normalizeInitialPageLimit(limit)
  const safePage = normalizeInitialPage(page)
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, safePage, safeLimit)

  // ONE Redis round trip: the publication write fence plus both cache tiers
  // from a single atomic MGET snapshot (previously fence SET NX + GET, primary
  // GET, fallback GET ran sequentially). The fence is captured no later than
  // the entries and before any database query; if a publication advances this
  // generation while the request is in flight, its eventual fire-and-forget
  // writes are rejected atomically by Redis.
  const snapshot = await cache.readSharedCacheWriteFenceWithEntries<InitialTradersResult>(
    PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
    [cacheKey, fallbackKey]
  )
  const writeFence = snapshot.fence
  let cached: InitialTradersResult | null = null
  let fallbackCached: InitialTradersResult | null = null
  if (writeFence !== null) {
    try {
      cached = snapshot.entries[0] ?? null
      if (cached && cached.traders && cached.traders.length > 0) {
        const safeCached = sanitizeInitialTradersResult(cached, timeRange, { fromCache: true })
        if (safeCached && safeCached.traders.length > 0) return safeCached
        cached = safeCached
      }
      // Primary cache miss — keep the fallback for a DB failure only. Serving
      // it before trying the DB let a DB-level withdrawal (source quarantine,
      // season fence) stay on the homepage for the fallback's full TTL, since
      // such withdrawals do not advance the publication write fence.
      fallbackCached = snapshot.entries[1] ?? null
      if (fallbackCached) {
        fallbackCached = sanitizeInitialTradersResult(fallbackCached, timeRange, {
          fromCache: true,
        })
      }
    } catch (_err) {
      // Malformed cache payload — fall through to DB
    }
  }

  // fetchLeaderboardFromDB owns the single 5s timeout and aborts the actual
  // Supabase requests. Do not race it with a second timer here: that used to
  // abandon still-running PostgREST requests whenever the outer race won.
  try {
    const result =
      sanitizeInitialTradersResult(
        await fetchLeaderboardFromDB(timeRange, safeLimit, safePage),
        timeRange
      ) ?? unknownInitialTradersResult()

    // Defensive fallback for DB errors/timeouts that are normalized to an
    // empty result by fetchLeaderboardFromDB. In normal serving, a non-empty
    // fallback already returned above without starting the DB request.
    if (result.traders.length === 0) {
      return staleCacheResult(cached, fallbackCached) ?? result
    }

    // Cache successful result. The primary TTL bounds how long a DB-level
    // withdrawal can stay visible (see PUBLIC_RANKING_PRIMARY_CACHE_TTL_SECONDS).
    // Fallback cache has 4h TTL as a safety net used ONLY when the DB fails.
    if (result.traders.length > 0) {
      fireAndForget(
        Promise.all([
          cache.set(cacheKey, result, {
            ttl: PUBLIC_RANKING_PRIMARY_CACHE_TTL_SECONDS,
            tags: [PUBLIC_RANKING_REDIS_TAG, `season:${timeRange}`],
            skipMemory: true,
            writeFence,
          }),
          cache.set(fallbackKey, result, {
            ttl: 14400,
            tags: [PUBLIC_RANKING_REDIS_TAG, `season:${timeRange}`],
            skipMemory: true,
            writeFence,
          }),
        ]),
        'cache-set-initial-traders'
      )
    }
    return result
  } catch (err) {
    logger.warn(
      `[getInitialTraders] DB fetch failed/timed out: ${err instanceof Error ? err.message : err}`
    )
    // Availability fallback during compute-leaderboard contention. Only rows
    // whose cached publication proof *and upstream source watermark* still
    // pass were retained above; an expired/unknown source never wins merely
    // because it is more visually convenient than an empty ranking state.
    const stale = staleCacheResult(
      sanitizeInitialTradersResult(cached, timeRange, { fromCache: true }),
      sanitizeInitialTradersResult(fallbackCached, timeRange, { fromCache: true })
    )
    if (stale) {
      logger.info(
        `[getInitialTraders] Serving STALE cache after DB timeout (page=${safePage}, traders=${stale.traders.length})`
      )
      return stale
    }
    // No cache either — Phase 2 client will fetch from API on hydration.
    return unknownInitialTradersResult()
  }
}

/**
 * Direct Supabase fetch -- used by cron to populate cache and as fallback.
 * Exported so the cron refresh route can call it without triggering cache reads.
 *
 * The underlying reader is the security-barrier public cohort view. It applies
 * every publication predicate before its `limit + 1` range, so a partial,
 * stale, estimated, or quarantined row can never consume a homepage slot.
 *
 * There is deliberately no total/category-count lookup here: the historic
 * count cache has a weaker predicate than the cohort view. Until a dedicated
 * same-predicate count authority exists, the UI gets `hasMore` only.
 */
export async function fetchLeaderboardFromDB(
  timeRange: Period = '90D',
  limit: number = 20,
  page: number = 0
): Promise<InitialTradersResult> {
  const supabase = getSupabaseAdmin()
  const safeLimit = normalizeInitialPageLimit(limit)
  const safePage = normalizeInitialPage(page)

  // Keep a single deadline across the public cohort query, avatar enrichment,
  // and the page's own source-watermark rows. Do not race abandoned requests.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  const { signal } = controller

  try {
    const pageResult = await fetchInitialLeaderboardPage(
      supabase,
      timeRange,
      safeLimit,
      safePage,
      signal
    )
    if (signal.aborted) throw signal.reason

    // Prefer our own CDN mirror over the exchange-CDN proxy (no 429 cold-burst).
    // Missing mirrors do not change ranking eligibility, so this enrichment is
    // availability-only and leaves the verified cohort rows otherwise intact.
    // Include the look-ahead witness's source so its watermark is cached
    // alongside the page and a cache hit can re-check it.
    const observedSources = [
      ...pageResult.traders.map((trader) => trader.source),
      ...(pageResult.lookahead ? [pageResult.lookahead.source] : []),
    ]
    const [enrichedTraders, watermarkRows] = await Promise.all([
      attachAvatarMirrors(supabase, pageResult.traders, signal),
      fetchInitialFreshnessRows(supabase, timeRange, observedSources, signal),
    ])
    if (signal.aborted) throw signal.reason

    const freshness = summarizeInitialTraderFreshness({
      watermarkRows,
      observedSources: enrichedTraders.map((trader) => trader.source),
    })

    return (
      sanitizeInitialTradersResult(
        {
          traders: enrichedTraders,
          lastUpdated: freshness.asOf,
          isStale: freshness.isStale,
          // The view currently has no same-predicate count authority. Even a
          // terminal page is not a safe substitute: a defensive mapping reject
          // would make its offset arithmetic diverge from the rendered cohort.
          totalCount: null,
          totalCountIsExact: false,
          hasMore: pageResult.hasMore,
          lookaheadWitness: pageResult.lookahead,
          categoryCounts: UNKNOWN_CATEGORY_COUNTS,
          categoryCountsAreExact: false,
          sourceFreshness: watermarkRows,
        },
        timeRange
      ) ?? unknownInitialTradersResult()
    )
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('timeout'))
    if (isTimeout) {
      logger.warn(
        `[getInitialTraders] Timed out after 5s (page=${page}) -- returning empty (ISR will fill on next request)`
      )
    } else {
      logger.error('[getInitialTraders] Error:', err)
    }
    return unknownInitialTradersResult()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchInitialLeaderboardPage(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number,
  page: number,
  signal: AbortSignal
): Promise<{ traders: InitialTrader[]; hasMore: boolean; lookahead: InitialTrader | null }> {
  const result = await getLeaderboard(supabase, {
    period: timeRange,
    limit,
    offset: page * limit,
    // No page-specific score floor: getLeaderboard applies the shared public
    // cohort predicate (lib/rankings/public-cohort.ts), identical to
    // /api/traders, which takes over after hydration and serves every later
    // page — so server page N and client page N are the same row range.
    sortBy: 'arena_score',
    signal,
  })
  if (result.error) throw new Error(result.error)

  const traders = result.traders
    .map(mapUnifiedToInitial)
    .filter((trader): trader is InitialTrader => trader !== null)
  if (traders.length !== result.traders.length) {
    throw new Error('public cohort response failed local proof revalidation')
  }
  // The witness is kept only as cache proof; an unmappable witness simply
  // means a later cache hit cannot re-prove `hasMore` (fails closed).
  const lookahead =
    result.hasMore && result.lookahead ? mapUnifiedToInitial(result.lookahead) : null
  return { traders, hasMore: result.hasMore, lookahead }
}

async function fetchInitialFreshnessRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  observedSources: readonly string[],
  signal: AbortSignal
): Promise<SourceFreshnessRow[]> {
  const sources = [...new Set(observedSources.filter((source) => source.length > 0))]
  if (sources.length === 0) return []

  const { data, error } = await supabase
    .from('leaderboard_source_freshness')
    .select('source,source_as_of')
    .eq('season_id', timeRange)
    .in('source', sources)
    .abortSignal(signal)
  if (error) {
    throw new Error(`source freshness query failed: ${error.message}`)
  }
  return (data || []) as SourceFreshnessRow[]
}

/**
 * Source freshness describes only the rows actually rendered by this finite
 * homepage page. We intentionally do not borrow the old count-cache source
 * set because that cache has a weaker membership predicate than the verified
 * public cohort view.
 */
export function summarizeInitialTraderFreshness(params: {
  watermarkRows: readonly SourceFreshnessRow[]
  observedSources: readonly string[]
  nowMs?: number
}): SourceFreshnessSummary {
  const sources = [
    ...new Set(
      params.observedSources.filter(
        (source) => source.length > 0 && isPublicRankingSourceAllowed(source)
      )
    ),
  ]
  return summarizeSourceFreshness(params.watermarkRows, sources, params.nowMs)
}
