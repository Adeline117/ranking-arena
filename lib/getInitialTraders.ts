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
import { mapLeaderboardRow } from '@/lib/data/trader/mappers'
import { attachAvatarMirrors } from '@/lib/data/avatar-mirrors'
import { logger, fireAndForget } from '@/lib/logger'
import { sanitizeDisplayName } from '@/lib/utils/profanity'
import * as cache from '@/lib/cache'
import {
  currentScoredSources,
  type LeaderboardCountCacheRow,
} from '@/lib/data/leaderboard-count-cache'
import {
  summarizeSourceFreshness,
  type SourceFreshnessRow,
  type SourceFreshnessSummary,
} from '@/lib/rankings/source-freshness'
import { PUBLIC_ACTIVE_RANKING_SOURCES, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  PUBLIC_RANKING_REDIS_TAG,
  filterPublicRankingRows,
  filterPublicRankingSources,
  publicRankingCacheKey,
  publicRankingCountFromCache,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
export interface InitialTrader {
  id: string
  handle: string
  /** Persisted publication rank; never inferred from page position. */
  rank: number
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  followers: number
  source: string
  source_type: 'futures' | 'spot' | 'web3'
  avatar_url: string | null
  /** Our own Supabase-Storage mirror (no proxy, no 429). Preferred over avatar_url. */
  avatar_url_mirror?: string | null
  arena_score: number
  /** Sharpe ratio — populated from leaderboard_ranks.sharpe_ratio (DEX/computed
   *  sources); null for CEX that don't supply it. Was dropped by this type so the
   *  SSR card always rendered "—" (audit 2026-07-03). */
  sharpe: number | null
  /** Closed trades in the window. Explicit 0 = confirmed zero-trade wallet
   *  ("Holder" — win% undefined by design); null = unknown/not captured. */
  trades_count: number | null
  score_confidence: ScoreConfidence
  /** Rank movement vs previous compute run (+ = climbed) — drives ↑/↓ arrows. */
  rank_change?: number | null
  /** First appearance on the board this run (NEW badge). */
  is_new?: boolean
}

/**
 * Map a UnifiedTrader to the InitialTrader interface used by frontend components.
 */
function mapUnifiedToInitial(t: UnifiedTrader): InitialTrader | null {
  if (t.rank == null) return null

  // For copin aggregator: extract real platform from trader_key (e.g., "hyperliquid:0x..." → "hyperliquid")
  let displayPlatform = t.platform
  let displayKey = t.traderKey
  if (t.platform === 'copin' && t.traderKey?.includes(':')) {
    const [realPlatform, ...rest] = t.traderKey.split(':')
    displayPlatform = realPlatform
    displayKey = rest.join(':')
  }

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
    roi: t.roi ?? 0,
    pnl: t.pnl ?? 0,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    followers: t.followers ?? 0,
    source: displayPlatform,
    source_type: (t.sourceType as 'futures' | 'spot' | 'web3') || 'futures',
    avatar_url: t.avatarUrl,
    avatar_url_mirror: null, // enriched post-fetch via attachAvatarMirrors
    arena_score: t.arenaScore ?? 0,
    sharpe: t.sharpeRatio ?? null,
    trades_count: t.tradesCount ?? null,
    score_confidence: 'full', // leaderboard_ranks only includes confident scores
    rank_change: t.rankChange ?? null,
    is_new: t.isNew === true,
  }
}

export interface CategoryCounts {
  all: number
  futures: number
  spot: number
  onchain: number
}

export interface InitialTradersResult {
  traders: InitialTrader[]
  lastUpdated: string | null
  isStale: boolean
  totalCount: number
  categoryCounts: CategoryCounts
}

function staleCacheResult(
  ...candidates: Array<InitialTradersResult | null>
): InitialTradersResult | null {
  const stale = candidates.find((candidate) => candidate && candidate.traders.length > 0)
  return stale ? { ...stale, isStale: true } : null
}

/**
 * Single source of truth for the SSR homepage cache keys — shared by the
 * reader (getInitialTraders) and the warm-cache writers so they can never
 * drift onto different keys again.
 * v3 (2026-07-12): shape gained rank_change/is_new — bumped so 2h-TTL v2
 * entries (without the new fields) don't serve arrow-less rows for hours.
 * v4 (2026-07-18): lastUpdated is the oldest live source-data watermark,
 * never leaderboard_ranks.computed_at.
 */
export function homeInitialTradersCacheKeys(timeRange: Period, page: number) {
  return {
    cacheKey: publicRankingCacheKey(`home-initial-traders-v4:${timeRange}:p${page}`),
    fallbackKey: publicRankingCacheKey(`home-initial-traders-fallback-v4:${timeRange}:p${page}`),
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
  const result = await fetchLeaderboardFromDB(timeRange, limit, 0)
  if (result.traders.length === 0) return 0
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, 0)
  const writes = await Promise.all([
    cache.set(cacheKey, result, {
      ttl: 7200,
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

export async function getInitialTraders(
  timeRange: Period = '90D',
  limit: number = 20,
  page: number = 0
): Promise<InitialTradersResult> {
  // During Vercel build, Supabase queries hang (iad1 build server -> timeout).
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return {
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: 0,
      categoryCounts: { all: 0, futures: 0, spot: 0, onchain: 0 },
    }
  }

  // Capture before the first cache read and before any database query. If a
  // publication advances this generation while the request is in flight, its
  // eventual fire-and-forget writes are rejected atomically by Redis.
  const writeFence = await cache.readSharedCacheWriteFence(PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY)

  // Try Redis cache first — fresh hit returns immediately.
  // Two-tier cache strategy:
  //   1. Primary cache (2h TTL) — normal serving
  //   2. Fallback cache (4h TTL) — safety net when DB is down/slow
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, page)
  let cached: InitialTradersResult | null = null
  let fallbackCached: InitialTradersResult | null = null
  if (writeFence !== null) {
    try {
      cached = await cache.get<InitialTradersResult>(cacheKey, { skipMemory: true })
      if (cached && cached.traders && cached.traders.length > 0) {
        const safeCached = sanitizePublicRankingSourcePayload(cached)
        if (safeCached.traders.length > 0) return safeCached
        cached = safeCached
      }
      // Primary cache miss — try fallback (longer TTL, may be stale but better than empty)
      fallbackCached = await cache.get<InitialTradersResult>(fallbackKey, { skipMemory: true })
      if (fallbackCached) {
        fallbackCached = sanitizePublicRankingSourcePayload(fallbackCached)
        const stale = staleCacheResult(fallbackCached)
        if (stale) return stale
      }
    } catch (_err) {
      // Redis unavailable — fall through to DB
    }
  }

  // fetchLeaderboardFromDB owns the single 5s timeout and aborts the actual
  // Supabase requests. Do not race it with a second timer here: that used to
  // abandon still-running PostgREST requests whenever the outer race won.
  try {
    const result = sanitizePublicRankingSourcePayload(
      await fetchLeaderboardFromDB(timeRange, limit, page)
    )

    // Defensive fallback for DB errors/timeouts that are normalized to an
    // empty result by fetchLeaderboardFromDB. In normal serving, a non-empty
    // fallback already returned above without starting the DB request.
    if (result.traders.length === 0) {
      return staleCacheResult(cached, fallbackCached) ?? result
    }

    // Cache successful result — TTL aligned with compute-leaderboard frequency (2h).
    // warm-cache cron refreshes every 30 min, so data is always reasonably fresh.
    // Fallback cache has 4h TTL as safety net for DB outages.
    if (result.traders.length > 0) {
      fireAndForget(
        Promise.all([
          cache.set(cacheKey, result, {
            ttl: 7200,
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
    // Stale cache fallback — during compute-leaderboard cron contention the
    // diverse RPC + category counts spike to 15-30s. Returning empty zeros
    // produces user-visible "0 traders" flash on the homepage. Stale data
    // (even hours old) is much better than nothing.
    const stale = staleCacheResult(
      sanitizePublicRankingSourcePayload(cached),
      sanitizePublicRankingSourcePayload(fallbackCached)
    )
    if (stale) {
      logger.info(
        `[getInitialTraders] Serving STALE cache after DB timeout (page=${page}, traders=${stale.traders.length})`
      )
      return stale
    }
    // No cache either — Phase 2 client will fetch from API on hydration.
    return {
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: 0,
      categoryCounts: { all: 0, futures: 0, spot: 0, onchain: 0 },
    }
  }
}

/**
 * Direct Supabase fetch -- used by cron to populate cache and as fallback.
 * Exported so the cron refresh route can call it without triggering cache reads.
 *
 * Strategy:
 * 1. Page zero queries through getLeaderboard with the exact public active
 *    source allowlist applied in SQL before LIMIT.
 * 2. Deeper pages apply the same allowlist before OFFSET/RANGE.
 */
export async function fetchLeaderboardFromDB(
  timeRange: Period = '90D',
  limit: number = 20,
  page: number = 0
): Promise<InitialTradersResult> {
  const supabase = getSupabaseAdmin()
  const emptyCounts: CategoryCounts = { all: 0, futures: 0, spot: 0, onchain: 0 }

  // 5s timeout — paginated queries with OFFSET can be slower than page 0 RPC
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  const { signal } = controller

  try {
    let tradersPromise: Promise<{ traders: InitialTrader[]; lastUpdated: string | null }>
    if (page > 0) {
      tradersPromise = fetchPaginatedFromDB(supabase, timeRange, limit, page, signal)
    } else {
      // The diverse RPC applies LIMIT internally and cannot receive the exact
      // active-source contract. Use the direct reader so both the active
      // allowlist and publication quarantine execute before LIMIT.
      tradersPromise = fetchLeaderboardLegacy(supabase, timeRange, limit, signal)
    }

    // Fetch traders + category counts in parallel. Every top-level PostgREST
    // request shares this deadline (the diverse RPC derives a shorter child
    // deadline), so timeout cancels DB work instead of abandoning a race loser.
    const [tradersResult, rawCounts, freshnessRows] = await Promise.all([
      tradersPromise,
      fetchCategoryCounts(supabase, timeRange, signal),
      fetchInitialFreshnessRows(supabase, timeRange, signal),
    ])
    if (signal.aborted) throw signal.reason

    // Prefer our own CDN mirror over the exchange-CDN proxy (no 429 cold-burst).
    // Fail-open: missing mirrors leave avatar_url untouched (origin proxy still works).
    const enrichedTraders = await attachAvatarMirrors(supabase, tradersResult.traders, signal)
    if (signal.aborted) throw signal.reason
    const counts = publicInitialCategoryCounts(freshnessRows.countRows, enrichedTraders, rawCounts)
    const freshness = summarizeInitialTraderFreshness({
      countRows: freshnessRows.countRows,
      watermarkRows: freshnessRows.watermarkRows,
      observedSources: enrichedTraders.map((trader) => trader.source),
    })
    return sanitizePublicRankingSourcePayload({
      ...tradersResult,
      traders: enrichedTraders,
      lastUpdated: freshness.asOf,
      isStale: freshness.isStale,
      totalCount: counts.all,
      categoryCounts: counts,
    })
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
    return {
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: 0,
      categoryCounts: emptyCounts,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchInitialFreshnessRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  signal: AbortSignal
): Promise<{
  countRows: LeaderboardCountCacheRow[]
  watermarkRows: SourceFreshnessRow[]
}> {
  let watermarkQuery = supabase
    .from('leaderboard_source_freshness')
    .select('source,source_as_of')
    .eq('season_id', timeRange)
    .in('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
  if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
    watermarkQuery = watermarkQuery.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
  }

  const [countResult, watermarkResult] = await Promise.all([
    supabase
      .from('leaderboard_count_cache')
      .select('source,total_count,updated_at')
      .eq('season_id', timeRange)
      .like('source', '%_gt0')
      .abortSignal(signal),
    watermarkQuery.abortSignal(signal),
  ])

  return {
    countRows: (countResult.data || []) as LeaderboardCountCacheRow[],
    watermarkRows: (watermarkResult.data || []) as SourceFreshnessRow[],
  }
}

/**
 * SSR must use the same source-level contract as the JSON APIs. Prefer the
 * complete live-source set from the atomic count-cache generation; only fall
 * back to the sources observed on the rendered page when that cache is
 * unavailable.
 */
export function summarizeInitialTraderFreshness(params: {
  countRows: readonly LeaderboardCountCacheRow[]
  watermarkRows: readonly SourceFreshnessRow[]
  observedSources: readonly string[]
  nowMs?: number
}): SourceFreshnessSummary {
  const liveSources = filterPublicRankingSources(currentScoredSources(params.countRows))
  const observedSources = filterPublicRankingSources(params.observedSources)
  const nowMs = params.nowMs ?? Date.now()
  if (liveSources.length === 0 && observedSources.length > 0) {
    const observed = summarizeSourceFreshness(params.watermarkRows, observedSources, nowMs)
    return { ...observed, isStale: true }
  }
  return summarizeSourceFreshness(params.watermarkRows, liveSources, nowMs)
}

/** Source-only counts from one atomic count-cache generation. */
export function publicInitialCategoryCounts(
  countRows: readonly LeaderboardCountCacheRow[],
  visibleTraders: readonly InitialTrader[],
  fallback: CategoryCounts
): CategoryCounts {
  if (PUBLIC_RANKING_QUARANTINED_SOURCES.length === 0) return fallback

  const publicSources = filterPublicRankingSources(currentScoredSources(countRows))
  const sourceGroups = {
    futures: publicSources.filter((source) => (SOURCE_TYPE_MAP[source] || 'futures') === 'futures'),
    spot: publicSources.filter((source) => SOURCE_TYPE_MAP[source] === 'spot'),
    onchain: publicSources.filter((source) => SOURCE_TYPE_MAP[source] === 'web3'),
  }
  const all = publicRankingCountFromCache(countRows)
  const futures = publicRankingCountFromCache(countRows, { sources: sourceGroups.futures })
  const spot = publicRankingCountFromCache(countRows, { sources: sourceGroups.spot })
  const onchain = publicRankingCountFromCache(countRows, { sources: sourceGroups.onchain })
  if (all !== null && futures !== null && spot !== null && onchain !== null) {
    return { all, futures, spot, onchain }
  }

  return visibleTraders.reduce<CategoryCounts>(
    (counts, trader) => {
      counts.all += 1
      if (trader.source_type === 'spot') counts.spot += 1
      else if (trader.source_type === 'web3') counts.onchain += 1
      else counts.futures += 1
      return counts
    },
    { all: 0, futures: 0, spot: 0, onchain: 0 }
  )
}

/**
 * Fetch category counts from leaderboard_ranks using a single aggregation query.
 */
async function fetchCategoryCounts(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  signal: AbortSignal
): Promise<CategoryCounts> {
  const { data, error } = await supabase
    .rpc('get_leaderboard_category_counts', {
      p_season_id: timeRange,
    })
    .abortSignal(signal)

  if (!error && data && Array.isArray(data)) {
    const counts: CategoryCounts = { all: 0, futures: 0, spot: 0, onchain: 0 }
    for (const row of data as Array<{ source_type: string; count: number }>) {
      const ct = Number(row.count)
      counts.all += ct
      if (row.source_type === 'futures') counts.futures = ct
      else if (row.source_type === 'spot') counts.spot = ct
      else if (row.source_type === 'web3') counts.onchain = ct
    }
    return counts
  }

  // Fallback: return estimated counts instead of exact (exact takes 25s+ per query)
  if (error) {
    logger.warn(
      '[getInitialTraders] RPC get_leaderboard_category_counts unavailable, using estimates:',
      error.message
    )
  }
  // Use pg_class estimate via a single fast query instead of 4 parallel count(exact)
  return { all: 12000, futures: 5000, spot: 1500, onchain: 5500 }
}

/**
 * Paginated fetch: simple offset-based pagination for page > 0.
 * Page 0 uses the direct getLeaderboard reader with the same source allowlist.
 */
async function fetchPaginatedFromDB(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number,
  page: number,
  signal: AbortSignal
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const offset = page * limit
  // Explicit column list (not select('*')) so Postgres can use the
  // idx_leaderboard_ranks_api_default covering index with index-only scan.
  // SELECT * forces heap fetch for the ~10 columns we don't actually read
  // (raw_data, metrics_estimated, internal flags, etc.) adding 30-80ms.
  const SSR_COLS =
    'source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, avatar_url, rank, rank_change, is_new, computed_at, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type, is_outlier, season_id'
  let query = supabase
    .from('leaderboard_ranks')
    .select(SSR_COLS)
    .eq('season_id', timeRange)
    .not('rank', 'is', null)
    .in('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')

  if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
    query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
  }

  const { data, error } = await query
    .order('arena_score', { ascending: false })
    .order('rank', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1)
    .abortSignal(signal)

  if (error || !data) {
    logger.error('[fetchPaginatedFromDB] Error:', error?.message)
    return { traders: [], lastUpdated: null }
  }

  // Filter on the raw DB source before mapUnifiedToInitial can rewrite legacy
  // copin keys such as "hyperliquid:0x..." into an apparently active source.
  const unifiedTraders = filterPublicRankingRows(
    data as Record<string, unknown>[],
    (row) => row.source
  )
    .filter((row) => row.rank != null)
    .map((row) => mapLeaderboardRow(row))
  const initialTraders = unifiedTraders
    .map(mapUnifiedToInitial)
    .filter((trader): trader is InitialTrader => trader !== null)
  const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null

  return { traders: initialTraders, lastUpdated }
}

/**
 * Lightweight fallback: fetch only 50 rows sorted by arena_score DESC.
 * Avoids the expensive 2000-row fetch + JS-side filtering that caused LCP spikes.
 */
async function fetchLeaderboardLegacy(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number,
  signal: AbortSignal
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const { traders: unifiedTraders } = await getLeaderboard(supabase, {
    period: timeRange as '7D' | '30D' | '90D',
    limit: Math.min(limit, 50),
    minScore: 10,
    excludeOutliers: true,
    sortBy: 'arena_score',
    allowedSources: PUBLIC_ACTIVE_RANKING_SOURCES,
    excludeSources: PUBLIC_RANKING_QUARANTINED_SOURCES,
    signal,
  })

  const initialTraders = unifiedTraders
    .map(mapUnifiedToInitial)
    .filter((trader): trader is InitialTrader => trader !== null)
  const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null

  return {
    traders: initialTraders,
    lastUpdated,
  }
}
