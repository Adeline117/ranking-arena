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
    cacheKey: `home-initial-traders-v4:${timeRange}:p${page}`,
    fallbackKey: `home-initial-traders-fallback-v4:${timeRange}:p${page}`,
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
  const result = await fetchLeaderboardFromDB(timeRange, limit, 0)
  if (result.traders.length === 0) return 0
  const { cacheKey, fallbackKey } = homeInitialTradersCacheKeys(timeRange, 0)
  await Promise.all([
    cache.set(cacheKey, result, { ttl: 7200 }),
    cache.set(fallbackKey, result, { ttl: 14400 }),
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
    cached = await cache.get<InitialTradersResult>(cacheKey)
    if (cached && cached.traders && cached.traders.length > 0) {
      return cached
    }
    // Primary cache miss — try fallback (longer TTL, may be stale but better than empty)
    fallbackCached = await cache.get<InitialTradersResult>(fallbackKey)
  } catch (_err) {
    // Redis unavailable — fall through to DB
  }

  // DB fetch with 5s timeout — SSR must never hang
  const TIMEOUT_MS = 5000
  try {
    const result = await Promise.race([
      fetchLeaderboardFromDB(timeRange, limit, page),
      new Promise<InitialTradersResult>((_, reject) =>
        setTimeout(() => reject(new Error('SSR DB timeout')), TIMEOUT_MS)
      ),
    ])

    // Cache successful result — TTL aligned with compute-leaderboard frequency (2h).
    // warm-cache cron refreshes every 30 min, so data is always reasonably fresh.
    // Fallback cache has 4h TTL as safety net for DB outages.
    if (result.traders.length > 0) {
      fireAndForget(
        Promise.all([
          cache.set(cacheKey, result, { ttl: 7200 }),
          cache.set(fallbackKey, result, { ttl: 14400 }),
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
    const stale = cached ?? fallbackCached
    if (stale && stale.traders && stale.traders.length > 0) {
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
 * 1. Try SQL RPC `get_diverse_leaderboard` (returns ~50 rows, ~10KB payload)
 * 2. Fallback to getLeaderboard(2000) + JS-side diversity filter (~400KB) if RPC missing
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

  try {
    // Fetch traders + category counts in parallel
    const [tradersResult, counts, freshnessRows] = await Promise.race([
      Promise.all([
        page === 0
          ? fetchViaDiverseRPC(supabase, timeRange, limit)
          : fetchPaginatedFromDB(supabase, timeRange, limit, page),
        fetchCategoryCounts(supabase, timeRange),
        fetchInitialFreshnessRows(supabase, timeRange),
      ]),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new Error('Query timeout after 5000ms'))
        )
      }),
    ])

    clearTimeout(timer)
    // Prefer our own CDN mirror over the exchange-CDN proxy (no 429 cold-burst).
    // Fail-open: missing mirrors leave avatar_url untouched (origin proxy still works).
    const enrichedTraders = await attachAvatarMirrors(supabase, tradersResult.traders)
    const freshness = summarizeInitialTraderFreshness({
      countRows: freshnessRows.countRows,
      watermarkRows: freshnessRows.watermarkRows,
      observedSources: enrichedTraders.map((trader) => trader.source),
    })
    return {
      ...tradersResult,
      traders: enrichedTraders,
      lastUpdated: freshness.asOf,
      isStale: freshness.isStale,
      totalCount: counts.all,
      categoryCounts: counts,
    }
  } catch (err: unknown) {
    clearTimeout(timer)
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
  }
}

async function fetchInitialFreshnessRows(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period
): Promise<{
  countRows: LeaderboardCountCacheRow[]
  watermarkRows: SourceFreshnessRow[]
}> {
  const [countResult, watermarkResult] = await Promise.all([
    supabase
      .from('leaderboard_count_cache')
      .select('source,total_count,updated_at')
      .eq('season_id', timeRange)
      .like('source', '%_gt0'),
    supabase
      .from('leaderboard_source_freshness')
      .select('source,source_as_of')
      .eq('season_id', timeRange),
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
  const liveSources = currentScoredSources(params.countRows)
  const nowMs = params.nowMs ?? Date.now()
  if (liveSources.length === 0 && params.observedSources.length > 0) {
    const observed = summarizeSourceFreshness(params.watermarkRows, params.observedSources, nowMs)
    return { ...observed, isStale: true }
  }
  return summarizeSourceFreshness(params.watermarkRows, liveSources, nowMs)
}

/**
 * Fetch category counts from leaderboard_ranks using a single aggregation query.
 */
async function fetchCategoryCounts(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period
): Promise<CategoryCounts> {
  const { data, error } = await supabase.rpc('get_leaderboard_category_counts', {
    p_season_id: timeRange,
  })

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
 * Primary path: use the SQL RPC that handles diversity at the DB level.
 * Falls back to the legacy 2000-row JS-side filter if the RPC doesn't exist.
 */
async function fetchViaDiverseRPC(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  // Fetch more rows with per-platform cap, then enforce JS-side category diversity.
  // Without this, DEX platforms (high ROI → high score) dominate all 50 slots.
  // Aligned with API route (0.4) — SSR uses slightly tighter 0.3 to keep diversity
  // but avoids the jarring composition shift when the first API refresh arrives.
  const MAX_PER_PLATFORM = Math.max(5, Math.ceil(limit * 0.3))

  // Try the SQL RPC first — fetch 2x limit to have room for diversity enforcement.
  // 2s timeout: the RPC uses a non-covering index (idx_leaderboard_ranks_diverse)
  // which requires 70K+ heap fetches on bloated tables. If slow, fall back to
  // fetchLeaderboardLegacy which uses the covering index (28ms).
  let data: Record<string, unknown>[] | null = null
  let error: { message: string } | null = null
  try {
    const rpcResult = await Promise.race([
      supabase.rpc('get_diverse_leaderboard', {
        p_season_id: timeRange,
        p_per_platform: MAX_PER_PLATFORM,
        p_total_limit: limit * 2,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Diverse RPC timeout (2s)')), 2_000)
      ),
    ])
    data = rpcResult.data as Record<string, unknown>[] | null
    error = rpcResult.error
  } catch (_err) {
    logger.warn('[getInitialTraders] Diverse RPC slow (>2s), falling back to covering-index query')
    return fetchLeaderboardLegacy(supabase, timeRange, limit)
  }

  if (!error && data && Array.isArray(data) && data.length > 0) {
    const unifiedTraders = data.map((row: Record<string, unknown>) => mapLeaderboardRow(row))

    // Enforce category diversity: CEX futures, DEX, and spot/web3 should each have representation.
    // Without this, DEX traders with 10,000%+ ROI crowd out all CEX traders.
    const CEX_PLATFORMS = new Set([
      'binance_futures',
      'bybit',
      'okx_futures',
      'bitget_futures',
      'mexc',
      'htx_futures',
      'gateio',
      'bingx',
      'coinex',
      'xt',
      'blofin',
      'bitfinex',
      'toobit',
      'bitunix',
      'btcc',
      'etoro',
    ])
    const cexTraders = unifiedTraders.filter((t) => CEX_PLATFORMS.has(t.platform))
    const dexTraders = unifiedTraders.filter((t) => !CEX_PLATFORMS.has(t.platform))

    // Guarantee at least 30% CEX and 30% DEX in the final list
    const minCex = Math.floor(limit * 0.3) // ~15 CEX traders
    const minDex = Math.floor(limit * 0.3) // ~15 DEX traders
    const remaining = limit - minCex - minDex // ~20 slots by score

    const diverseList: typeof unifiedTraders = []
    // Add guaranteed CEX slots (top by score)
    diverseList.push(...cexTraders.slice(0, minCex))
    // Add guaranteed DEX slots (top by score)
    diverseList.push(...dexTraders.slice(0, minDex))
    // Fill remaining slots from ALL traders by score (skip already-added)
    const addedKeys = new Set(diverseList.map((t) => `${t.platform}:${t.traderKey}`))
    const rest = unifiedTraders.filter((t) => !addedKeys.has(`${t.platform}:${t.traderKey}`))
    diverseList.push(...rest.slice(0, remaining))

    // Sort final list by arena score descending
    diverseList.sort((a, b) => (b.arenaScore ?? 0) - (a.arenaScore ?? 0))
    const finalTraders = diverseList.slice(0, limit)

    const initialTraders = finalTraders.map(mapUnifiedToInitial)
    const lastUpdated = initialTraders.length > 0 ? unifiedTraders[0].lastUpdated : null
    return { traders: initialTraders, lastUpdated }
  }

  // Fallback: RPC doesn't exist yet or returned empty — use legacy approach
  if (error) {
    logger.warn(
      '[getInitialTraders] RPC fallback — get_diverse_leaderboard unavailable:',
      error.message
    )
  }

  return fetchLeaderboardLegacy(supabase, timeRange, limit)
}

/**
 * Paginated fetch: simple offset-based pagination for page > 0.
 * Page 0 uses the diverse RPC for better quality. Pages 1+ use straight DB query.
 */
async function fetchPaginatedFromDB(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  timeRange: Period,
  limit: number,
  page: number
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const offset = page * limit
  // Explicit column list (not select('*')) so Postgres can use the
  // idx_leaderboard_ranks_api_default covering index with index-only scan.
  // SELECT * forces heap fetch for the ~10 columns we don't actually read
  // (raw_data, metrics_estimated, internal flags, etc.) adding 30-80ms.
  const SSR_COLS =
    'source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, arena_score, avatar_url, rank, rank_change, is_new, computed_at, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type, is_outlier, season_id'
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select(SSR_COLS)
    .eq('season_id', timeRange)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error || !data) {
    logger.error('[fetchPaginatedFromDB] Error:', error?.message)
    return { traders: [], lastUpdated: null }
  }

  const unifiedTraders = data.map((row: Record<string, unknown>) => mapLeaderboardRow(row))
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
  limit: number
): Promise<{ traders: InitialTrader[]; lastUpdated: string | null }> {
  const { traders: unifiedTraders } = await getLeaderboard(supabase, {
    period: timeRange as '7D' | '30D' | '90D',
    limit: Math.min(limit, 50),
    minScore: 10,
    excludeOutliers: true,
    sortBy: 'arena_score',
  })

  const initialTraders = unifiedTraders.map(mapUnifiedToInitial)
  const lastUpdated = unifiedTraders.length > 0 ? unifiedTraders[0].lastUpdated : null

  return {
    traders: initialTraders,
    lastUpdated,
  }
}
