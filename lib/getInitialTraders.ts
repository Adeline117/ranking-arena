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
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  PUBLIC_RANKING_QUARANTINED_SOURCES,
  filterPublicRankingRows,
  filterPublicRankingSources,
  publicRankingCacheKey,
  publicRankingCountFromCache,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import {
  readSealedRankingAuthorityGeneration,
  type SealedRankingGenerationRead,
} from '@/lib/rankings/read-sealed-ranking-generation'
import type { SealedLeaderboardPublicationProofSet } from '@/lib/rankings/read-publication-proofs'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
export interface InitialTrader {
  id: string
  handle: string
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
function mapUnifiedToInitial(t: UnifiedTrader): InitialTrader {
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
 * v5 (2026-07-29): only proof-fenced cohorts may populate the dedicated
 * sealed-ranking-cache@1 envelope; generic legacy values are rejected.
 * v6 (2026-07-29): proof and row membership come from the dynamic registry
 * authority instead of the historical TypeScript source registry.
 */
export function homeInitialTradersCacheKeys(timeRange: Period, page: number) {
  return {
    cacheKey: publicRankingCacheKey(`home-initial-traders-sealed-v6:${timeRange}:p${page}`),
    fallbackKey: publicRankingCacheKey(
      `home-initial-traders-sealed-fallback-v6:${timeRange}:p${page}`
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
  const sealedRead = await fetchSealedLeaderboardFromDB(timeRange, limit, 0)
  const result = sealedRead.value
  if (result.traders.length === 0) return 0
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, 0)
  const cacheEntry = createSealedRankingCacheEntry(sealedRead)
  await Promise.all([
    cache.set(cacheKey, cacheEntry, { ttl: 7200 }),
    cache.set(fallbackKey, cacheEntry, { ttl: 14400 }),
  ])
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

  // Try Redis cache first — fresh hit returns immediately.
  // Two-tier cache strategy:
  //   1. Primary cache (2h TTL) — normal serving
  //   2. Fallback cache (4h TTL) — safety net when DB is down/slow
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, page)
  let cached: InitialTradersResult | null = null
  let fallbackCached: InitialTradersResult | null = null
  try {
    const cachedEntry = parseSealedRankingCacheEntry<InitialTradersResult>(
      await cache.get<unknown>(cacheKey),
      timeRange
    )
    cached = cachedEntry?.value ?? null
    if (cached?.traders && cached.traders.length > 0) {
      const safeCached = sanitizePublicRankingSourcePayload(cached)
      if (safeCached.traders.length > 0) return safeCached
      cached = safeCached
    }
    // Primary cache miss — try fallback (longer TTL, may be stale but better than empty)
    const fallbackEntry = parseSealedRankingCacheEntry<InitialTradersResult>(
      await cache.get<unknown>(fallbackKey),
      timeRange
    )
    fallbackCached = fallbackEntry?.value ?? null
    if (fallbackCached) {
      fallbackCached = sanitizePublicRankingSourcePayload(fallbackCached)
      const stale = staleCacheResult(fallbackCached)
      if (stale) return stale
    }
  } catch (_err) {
    // Redis unavailable — fall through to DB
  }

  // fetchLeaderboardFromDB owns the single 5s timeout and aborts the actual
  // Supabase requests. Do not race it with a second timer here: that used to
  // abandon still-running PostgREST requests whenever the outer race won.
  try {
    const sealedRead = await fetchSealedLeaderboardFromDB(timeRange, limit, page)
    const result = sanitizePublicRankingSourcePayload(sealedRead.value)

    // Defensive fallback for an authorized but unexpectedly empty result. In
    // normal serving, a non-empty last-good fallback already returned above
    // without starting the DB request.
    if (result.traders.length === 0) {
      return staleCacheResult(cached, fallbackCached) ?? result
    }

    // Cache successful result — TTL aligned with compute-leaderboard frequency (2h).
    // warm-cache cron refreshes every 30 min, so data is always reasonably fresh.
    // Fallback cache has 4h TTL as safety net for DB outages.
    if (result.traders.length > 0) {
      const cacheEntry = createSealedRankingCacheEntry({ ...sealedRead, value: result })
      fireAndForget(
        Promise.all([
          cache.set(cacheKey, cacheEntry, { ttl: 7200 }),
          cache.set(fallbackKey, cacheEntry, { ttl: 14400 }),
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
  try {
    return (await fetchSealedLeaderboardFromDB(timeRange, limit, page)).value
  } catch {
    return {
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: 0,
      categoryCounts: { all: 0, futures: 0, spot: 0, onchain: 0 },
    }
  }
}

async function fetchSealedLeaderboardFromDB(
  timeRange: Period,
  limit: number,
  page: number
): Promise<SealedRankingGenerationRead<InitialTradersResult>> {
  const supabase = getSupabaseAdmin()

  // 5s timeout — paginated queries with OFFSET can be slower than page 0 RPC
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  const { signal } = controller

  try {
    return await readSealedRankingAuthorityGeneration(
      supabase,
      timeRange,
      async (publication) => {
        const authoritySources = publication.proofs.map((proof) => proof.source)
        let tradersPromise: Promise<{ traders: InitialTrader[]; lastUpdated: string | null }>
        if (page > 0) {
          tradersPromise = fetchPaginatedFromDB(
            supabase,
            timeRange,
            limit,
            page,
            publication.scoreCohortId,
            authoritySources,
            signal
          )
        } else {
          // The diverse RPC applies LIMIT internally and cannot receive the exact
          // active-source contract. Use the direct reader so both the active
          // allowlist and publication quarantine execute before LIMIT.
          tradersPromise = fetchLeaderboardLegacy(
            supabase,
            timeRange,
            limit,
            publication.scoreCohortId,
            authoritySources,
            signal
          )
        }

        const tradersResult = await tradersPromise
        if (signal.aborted) throw signal.reason

        // Prefer our own CDN mirror over the exchange-CDN proxy (no 429 cold-burst).
        // Fail-open: missing mirrors leave avatar_url untouched (origin proxy still works).
        const enrichedTraders = await attachAvatarMirrors(supabase, tradersResult.traders, signal)
        if (signal.aborted) throw signal.reason
        const counts = categoryCountsFromPublication(publication)
        const publishedWatermarks = publication.proofs
          .filter((proof) => proof.published_rank_count > 0)
          .map((proof) => proof.source_as_of)
        const lastUpdated =
          publishedWatermarks.length > 0
            ? publishedWatermarks.reduce((oldest, timestamp) =>
                timestamp < oldest ? timestamp : oldest
              )
            : null
        return sanitizePublicRankingSourcePayload({
          ...tradersResult,
          traders: enrichedTraders,
          lastUpdated,
          // The strict proof reader already rejects any stale source.
          isStale: false,
          totalCount: counts.all,
          categoryCounts: counts,
        })
      },
      { timeoutMs: 4_500, signal }
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
    throw err
  } finally {
    clearTimeout(timer)
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

/** Exact public totals carried by the same sealed proof set as the rank rows. */
export function categoryCountsFromPublication(
  publication: SealedLeaderboardPublicationProofSet
): CategoryCounts {
  return publication.proofs.reduce<CategoryCounts>(
    (counts, proof) => {
      counts.all += proof.published_rank_count
      const sourceType = SOURCE_TYPE_MAP[proof.source] || 'futures'
      if (sourceType === 'spot') counts.spot += proof.published_rank_count
      else if (sourceType === 'web3') counts.onchain += proof.published_rank_count
      else counts.futures += proof.published_rank_count
      return counts
    },
    { all: 0, futures: 0, spot: 0, onchain: 0 }
  )
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
  scoreCohortId: string,
  authoritySources: readonly string[],
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
    .filter('rank_publication_id', 'eq', scoreCohortId)
    .in('source', [...authoritySources])
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')

  if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
    query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
  }

  const { data, error } = await query
    .order('arena_score', { ascending: false })
    .range(offset, offset + limit - 1)
    .abortSignal(signal)

  if (error || !data) {
    throw new Error(
      `[fetchPaginatedFromDB] cohort-bound leaderboard query failed: ${error?.message ?? 'null result'}`
    )
  }

  // Filter on the raw DB source before mapUnifiedToInitial can rewrite legacy
  // copin keys such as "hyperliquid:0x..." into an apparently active source.
  const unifiedTraders = filterPublicRankingRows(
    data as Record<string, unknown>[],
    (row) => row.source
  ).map((row) => mapLeaderboardRow(row))
  const initialTraders = unifiedTraders.map(mapUnifiedToInitial)
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
  scoreCohortId: string,
  authoritySources: readonly string[],
  signal: AbortSignal
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const { traders: unifiedTraders } = await getLeaderboard(supabase, {
    period: timeRange as '7D' | '30D' | '90D',
    limit: Math.min(limit, 50),
    minScore: 10,
    excludeOutliers: true,
    sortBy: 'arena_score',
    scoreCohortId,
    allowedSources: authoritySources,
    excludeSources: PUBLIC_RANKING_QUARANTINED_SOURCES,
    signal,
  })

  const initialTraders = unifiedTraders.map(mapUnifiedToInitial)
  const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null

  return {
    traders: initialTraders,
    lastUpdated,
  }
}
