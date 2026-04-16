/**
 * GET /api/rankings
 *
 * Returns ranked traders for a given window, with optional platform/category filters.
 * Reads from leaderboard_ranks (pre-computed by compute-leaderboard cron).
 *
 * Query params:
 *   window: '7d' | '30d' | '90d' (required)
 *   category: 'futures' | 'spot' | 'onchain' (optional)
 *   platform: Platform string (optional, overrides category)
 *   limit: number (default 100, max 500)
 *   offset: number (default 0) — legacy, prefer cursor
 *   cursor: string (optional, format: "score:id" for keyset pagination)
 *   sort_by: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers' | 'win_rate' | 'sharpe_ratio' | 'trades_count'
 *   sort_dir: 'asc' | 'desc'
 *   min_pnl: number (optional)
 *   min_trades: number (optional)
 *
 * Response:
 *   { data:[], meta: { window, category, platform, totalcount, ... } }
 *
 * Caching: s-maxage=60, stale-while-revalidate=300
 */

import type { RankingWindow, TradingCategory, Platform, GranularPlatform, RankingsQuery } from '@/lib/types/leaderboard';
import { GRANULAR_PLATFORMS, PLATFORM_CATEGORY } from '@/lib/types/leaderboard';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import type { TradingPeriod } from '@/lib/types/unified-trader';
import { tieredGetOrSet, tieredGet } from '@/lib/cache/redis-layer';
import { ApiError } from '@/lib/api/errors';
import { success as apiSuccess, withCache } from '@/lib/api/response';
import { withPublic } from '@/lib/api/middleware'
import { parseLimit, parseOffset } from '@/lib/utils/safe-parse'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('rankings-api')

// availableSources cache via Redis (tieredGetOrSet, warm tier).
//
// IMPORTANT: reads from leaderboard_count_cache (one row per source) instead
// of doing `SELECT source FROM leaderboard_ranks LIMIT 200`. The old query
// returned physically-ordered rows, which on a (season_id, source) composite
// index meant all 200 matching rows came from the FIRST source lexicographically
// (e.g. just ['aevo']) — the bug was hidden by per-instance in-memory caching
// (different instances had different partial orderings) until we moved to
// shared Redis in task 17 and everyone saw the same broken cache entry.
//
// leaderboard_count_cache is maintained by refresh_leaderboard_count_cache()
// at the end of compute-leaderboard cron, so it's always fresh.
async function getAvailableSources(
  supabase: ReturnType<typeof import('@/lib/supabase/server').getSupabaseAdmin>,
  seasonId: string,
): Promise<string[]> {
  return tieredGetOrSet<string[]>(
    `rankings:available-sources:${seasonId}`,
    async (): Promise<string[]> => {
      const { data: sourceRows } = await supabase
        .from('leaderboard_count_cache')
        .select('source')
        .eq('season_id', seasonId)
        .gt('total_count', 0)
        .not('source', 'eq', '_all')
        .not('source', 'like', '%_gt0');
      return [
        ...new Set((sourceRows || [])
          .map((r: { source: string }) => r.source)
          .filter((s): s is string => typeof s === 'string' && !!s)),
      ].sort();
    },
    'warm', // 2min memory / 15min Redis — shared across instances
    ['rankings', 'available-sources'],
  );
}

const VALID_WINDOWS: (RankingWindow | 'composite')[] = ['7d', '30d', '90d', 'composite'];
const VALID_CATEGORIES: TradingCategory[] = ['futures', 'spot', 'onchain'];
const VALID_SORT_BY = ['arena_score', 'roi', 'pnl', 'drawdown', 'copiers', 'win_rate', 'sharpe_ratio', 'trades_count'] as const;

// Data quality: ROI values above this threshold are considered anomalous
const ROI_ANOMALY_THRESHOLD = 50000; // 50000% = 500x — only filter extreme data errors, not legitimate high performers

export const GET = withPublic(async ({ request }) => {
    const { searchParams } = new URL(request.url);

    // Parse & validate window (required)
    const window = searchParams.get('window') as RankingWindow | 'composite' | null;
    const normalizedWindow = window?.toLowerCase() as RankingWindow | 'composite';
    if (!normalizedWindow || !VALID_WINDOWS.includes(normalizedWindow)) {
      throw ApiError.validation('Invalid or missing window parameter. Must be one of: 7d, 30d, 90d, composite');
    }

    // Parse optional params
    const category = searchParams.get('category') as TradingCategory | null;
    if (category && !VALID_CATEGORIES.includes(category)) {
      throw ApiError.validation('Invalid category. Must be one of: futures, spot, onchain');
    }

    const platform = searchParams.get('platform') as GranularPlatform | null;
    if (platform && !(GRANULAR_PLATFORMS as readonly string[]).includes(platform)) {
      throw ApiError.validation(`Invalid platform: ${platform}`);
    }

    const sortBy = (searchParams.get('sort_by') || 'arena_score') as typeof VALID_SORT_BY[number];
    if (!VALID_SORT_BY.includes(sortBy)) {
      throw ApiError.validation(`Invalid sort_by. Must be one of: ${VALID_SORT_BY.join(', ')}`);
    }

    const sortDir = (searchParams.get('sort_dir') || 'desc') as 'asc' | 'desc';

    const limit = parseLimit(searchParams.get('limit'), 100, 500);
    const offset = parseOffset(searchParams.get('offset'));
    const cursor = searchParams.get('cursor') || undefined; // format: "score:id" for keyset pagination
    const minPnl = searchParams.get('min_pnl') ? Number(searchParams.get('min_pnl')) : undefined;
    const minTrades = searchParams.get('min_trades') ? Number(searchParams.get('min_trades')) : undefined;
    const traderType = searchParams.get('trader_type') as 'human' | 'bot' | null;

    // Only cache "hot" default queries (no filters, default sort, first page)
    // Filtered/paginated queries skip cache to avoid key explosion (thousands of permutations)
    const isDefaultQuery = sortBy === 'arena_score' && sortDir === 'desc'
      && !platform && !minPnl && !minTrades && !traderType && !cursor && offset === 0
    const cacheKey = isDefaultQuery
      ? `api:rankings:${normalizedWindow}:${category || 'all'}:${limit}`
      : null // skip cache for filtered queries


    let result: unknown;

    try {
      if (normalizedWindow === 'composite') {
        // Try precomputed composite first (written by /api/cron/precompute-composite)
        const precomputedKey = category ? `precomputed:composite:${category}` : 'precomputed:composite:all'
        const { data: precomputed } = await (await import('@/lib/cache/redis-layer')).tieredGet<{
          traders: unknown[]
          totalcount: number
          total_count: number
          as_of: string
          is_stale: boolean
          availableSources: string[]
        }>(precomputedKey, 'hot')

        if (precomputed && !platform && !minPnl && !minTrades && sortBy === 'arena_score' && sortDir === 'desc') {
          // Serve from precomputed cache — slice for pagination
          const traders = precomputed.traders.slice(offset, offset + limit)
          result = {
            ...precomputed,
            traders,
            window: 'COMPOSITE',
          }
        } else {
          // Fall back to real-time compute for filtered/sorted queries
          const compositeFetcher = () => getCompositeRankings({
            category: category || undefined,
            platform: (platform || undefined) as Platform | undefined,
            limit,
            offset,
            sort_by: sortBy,
            sort_dir: sortDir,
            min_pnl: minPnl,
            min_trades: minTrades,
          })
          result = cacheKey
            ? await tieredGetOrSet(cacheKey, compositeFetcher, 'hot', ['rankings'])
            : await compositeFetcher()
        }
      } else {
        const query: RankingsQuery = {
          window: normalizedWindow,
          category: category || undefined,
          platform: (platform || undefined) as Platform | undefined,
          limit,
          offset,
          sort_by: sortBy,
          sort_dir: sortDir,
          min_pnl: minPnl,
          min_trades: minTrades,
          trader_type: traderType || undefined,
        };
        const rankingsFetcher = () => getRankingsFallback(query, cursor)
        result = cacheKey
          ? await tieredGetOrSet(cacheKey, rankingsFetcher, 'hot', ['rankings'])
          : await rankingsFetcher()
      }
    } catch (fetchError) {
      // DB query failed — try to serve last-known-good cached data instead of returning 500.
      // Only attempt fallback for default (cacheable) queries; filtered queries have no cache.
      if (cacheKey) {
        const { data: staleData } = await tieredGet(cacheKey, 'hot')
        if (staleData) {
          logger.warn(`Rankings DB query failed, serving stale cache for ${cacheKey}:`, fetchError instanceof Error ? fetchError.message : String(fetchError))
          result = staleData
        } else {
          // No cache either — re-throw to let the error handler respond
          throw fetchError
        }
      } else {
        throw fetchError
      }
    }

    const response = apiSuccess(result);
    return withCache(response, { maxAge: 60, staleWhileRevalidate: 300 });
}, { name: 'rankings', rateLimit: { requests: 30, window: 60, prefix: 'rankings' } })

/**
 * Fetch rankings via unified data layer (leaderboard_ranks).
 * Returns the same response shape as the legacy getRankingsFallback.
 */
async function getRankingsFallback(rankingsQuery: RankingsQuery, _cursor?: string) {
  const {
    window,
    category,
    platform,
    limit = 100,
    offset = 0,
    sort_by = 'arena_score',
    sort_dir = 'desc',
    min_pnl,
    min_trades,
    trader_type,
  } = rankingsQuery;

  // Use read replica for ranking reads (falls back to primary if no replica configured)
  const { getReadReplica } = await import('@/lib/supabase/read-replica')
  const supabase = getReadReplica();
  // Cap at 1000: limit=5000 triggers 5 parallel chunk queries on a 314k-row
  // table under the CHUNK_SIZE pagination logic, saturating the Supabase
  // connection pool with little user benefit. Nobody actually needs 5000
  // traders in one request — pagination is already cursor-friendly.
  const safeLimit = Math.min(limit, 1000);
  const seasonId = window.toUpperCase() as TradingPeriod;

  // Map sort_by to unified sortBy parameter
  const sortByMap: Record<string, string> = {
    arena_score: 'arena_score',
    roi: 'roi',
    pnl: 'pnl',
    drawdown: 'max_drawdown',
    copiers: 'copiers',
    win_rate: 'win_rate',
    sharpe_ratio: 'sharpe_ratio',
    trades_count: 'trades_count',
  };
  const unifiedSortBy = sortByMap[sort_by] || 'arena_score';

  // Determine platform filter based on category
  const platformFilter: string | undefined = platform || undefined;
  let platformsInCategory: string[] | undefined;
  if (!platformFilter && category) {
    platformsInCategory = Object.entries(PLATFORM_CATEGORY)
      .filter(([, cat]) => cat === category)
      .map(([p]) => p);
  }

  // Sorting
  const sortColumn = unifiedSortBy === 'rank' ? 'rank' : unifiedSortBy;
  const ascending = sort_dir === 'asc';

  // Helper: build base query with all filters applied (reusable for chunked fetches)
  const SELECT_COLS = `source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
       trades_count, followers, copiers, arena_score, avatar_url, rank, rank_change, is_new, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, calmar_ratio, profit_factor, trader_type, is_outlier, metrics_estimated`

  function buildBaseQuery(opts?: { count?: 'exact' | 'planned' | 'estimated' }) {
    let q = supabase
      .from('leaderboard_ranks')
      .select(SELECT_COLS, opts ? { count: opts.count } : undefined)
      .eq('season_id', seasonId)
      .not('arena_score', 'is', null)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .lte('roi', ROI_ANOMALY_THRESHOLD)
      .gte('roi', -ROI_ANOMALY_THRESHOLD)

    if (platformFilter) {
      q = q.eq('source', platformFilter);
    } else if (platformsInCategory && platformsInCategory.length > 0) {
      q = q.in('source', platformsInCategory);
    }

    if (min_pnl != null) {
      q = q.gte('pnl', min_pnl);
    }
    if (min_trades != null) {
      q = q.gte('trades_count', min_trades);
    }

    // Filter by trader type (human/bot)
    if (trader_type === 'bot') {
      q = q.or('trader_type.eq.bot,source.eq.web3_bot');
    } else if (trader_type === 'human') {
      q = q.neq('source', 'web3_bot').or('trader_type.is.null,trader_type.neq.bot');
    }

    q = q.order(sortColumn, { ascending, nullsFirst: false });
    return q;
  }

  // Supabase PostgREST has a max_rows limit (typically 1000) per request.
  // Paginate in 1000-row chunks when safeLimit > 1000 to get complete data.
  const CHUNK_SIZE = 1000;
  let rows: Record<string, unknown>[] = [];
  let totalCount: number | null = null;
  let error: { message: string } | null = null;

  if (safeLimit <= CHUNK_SIZE) {
    // Single request — NO count (exact count takes 25s+ on 314k rows with OR filters)
    // Total count is read from leaderboard_count_cache (maintained by cron)
    // in parallel with the main query to avoid sequential round-trips.
    const cacheCountKey = platformFilter || '_all'
    const [result, countResult] = await Promise.all([
      buildBaseQuery().range(offset, offset + safeLimit - 1),
      supabase
        .from('leaderboard_count_cache')
        .select('total_count')
        .eq('season_id', seasonId)
        .eq('source', cacheCountKey)
        .maybeSingle(),
    ]);
    rows = (result.data || []) as Record<string, unknown>[];
    error = result.error;
    // Use cached total. Fallback to offset + rows.length if cache is empty
    // (first deploy / cron hasn't run yet).
    totalCount = countResult.data?.total_count ?? (offset + rows.length);
  } else {
    // Chunked fetch: first chunk, no count
    const firstResult = await buildBaseQuery()
      .range(offset, offset + CHUNK_SIZE - 1);
    if (firstResult.error) {
      error = firstResult.error;
    } else {
      rows = (firstResult.data || []) as Record<string, unknown>[];
      totalCount = null; // Will be set after all chunks

      // Calculate remaining chunks needed
      const remaining = safeLimit - CHUNK_SIZE;
      if (remaining > 0 && rows.length === CHUNK_SIZE) {
        const chunkCount = Math.ceil(remaining / CHUNK_SIZE);
        const chunkPromises = Array.from({ length: chunkCount }, (_, i) => {
          const chunkOffset = offset + CHUNK_SIZE * (i + 1);
          const chunkEnd = Math.min(chunkOffset + CHUNK_SIZE - 1, offset + safeLimit - 1);
          return buildBaseQuery()
            .range(chunkOffset, chunkEnd);
        });
        const chunkResults = await Promise.all(chunkPromises);
        for (const cr of chunkResults) {
          if (cr.error) {
            error = cr.error;
            break;
          }
          if (cr.data) rows = rows.concat(cr.data as Record<string, unknown>[]);
        }
      }
    }
  }

  if (error) {
    throw new Error(`Leaderboard query failed: ${error.message}`);
  }

  // Deduplicate by source:source_trader_id (case-insensitive for 0x addresses)
  const seenRowKeys = new Set<string>();
  const paginatedRows = (rows || []).filter((r: Record<string, unknown>) => {
    const tid = String(r.source_trader_id || '');
    const normalizedTid = tid.startsWith('0x') ? tid.toLowerCase() : tid;
    const key = `${r.source}:${normalizedTid}`;
    if (seenRowKeys.has(key)) return false;
    seenRowKeys.add(key);
    return true;
  });

  // Fetch available sources + freshness check in PARALLEL (was serial, ~100-200ms saved)
  const seasonIdUpper = seasonId;
  const [availableSources, lastRun] = await Promise.all([
    getAvailableSources(supabase, seasonIdUpper),
    supabase
      .from('pipeline_logs')
      .select('ended_at')
      .like('job_name', 'compute-leaderboard%')
      .eq('status', 'success')
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data),
  ]);

  // Freshness check: use most recent pipeline run, not displayed rows' computed_at.
  let latestCapturedAt: number;
  if (lastRun?.ended_at) {
    latestCapturedAt = new Date(lastRun.ended_at).getTime();
  } else if (paginatedRows.length > 0) {
    latestCapturedAt = Math.max(
      ...paginatedRows.map((r: Record<string, unknown>) => new Date(r.computed_at as string).getTime()).filter(t => t > 0)
    );
  } else {
    latestCapturedAt = Date.now();
  }
  const stalenessMs = Date.now() - latestCapturedAt;
  const isStale = stalenessMs > 3600 * 1000;

  // Transform to response format
  const PLACEHOLDER_NAMES = new Set(['Enter Name', 'enter name', 'Unknown', 'null', 'undefined', ''])
  const formatDisplayName = (handle: string | null, traderId: string): string => {
    if (handle && !PLACEHOLDER_NAMES.has(handle)) return handle
    // Format 0x addresses as "0x1234...5678"
    if (traderId?.startsWith('0x') && traderId.length >= 10) {
      return `${traderId.slice(0, 6)}...${traderId.slice(-4)}`
    }
    // Copin format: "protocol:0xAddr" → show the address part
    if (traderId?.includes(':')) {
      const addr = traderId.split(':')[1]
      if (addr?.startsWith('0x') && addr.length >= 10) return `${addr.slice(0, 6)}...${addr.slice(-4)}`
    }
    return traderId || 'Anonymous'
  }

  const traders = paginatedRows.map((row: Record<string, unknown>, idx: number) => {
    const traderId = row.source_trader_id as string
    // For copin aggregator: extract real platform from trader_key (e.g., "hyperliquid:0x..." → "hyperliquid")
    let displayPlatform = row.source as string
    let displayTraderKey = traderId
    if (displayPlatform === 'copin' && traderId?.includes(':')) {
      const [realPlatform, ...rest] = traderId.split(':')
      displayPlatform = realPlatform
      displayTraderKey = rest.join(':')
    }

    const roi = row.roi != null ? Number(row.roi) : null
    const pnl = row.pnl != null ? Number(row.pnl) : null
    const arenaScore = row.arena_score != null ? Number(row.arena_score) : null

    return {
      platform: displayPlatform as Platform,
      trader_key: displayTraderKey,
      display_name: formatDisplayName(row.handle as string | null, displayTraderKey),
      avatar_url: (row.avatar_url as string) || null,
      // Top-level metrics for frontend compatibility
      roi,
      pnl,
      arena_score: arenaScore,
      win_rate: row.win_rate != null ? Number(row.win_rate) : null,
      max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
      sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
      trades_count: (row.trades_count as number) ?? null,
      followers: (row.followers as number) ?? null,
      copiers: row.copiers != null ? Number(row.copiers) : null,
      rank: (row.rank as number) ?? offset + idx + 1,
      rank_change: (row.rank_change as number) ?? null,
      is_new: (row.is_new as boolean) ?? false,
      // Nested `metrics: { ... }` duplicate removed — all fields are already
      // exposed at the top level and no consumer read from the nested shape
      // (verified by repo-wide grep for `\.metrics\.roi` etc. in app/ and
      // lib/hooks/ — only lib/connectors/* uses that shape internally).
      // Saved ~30-40% response payload size.
      quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
      updated_at: (row.computed_at as string) || null,
      profitability_score: row.profitability_score != null ? Number(row.profitability_score) : null,
      risk_control_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
      execution_score: row.execution_score != null ? Number(row.execution_score) : null,
      score_completeness: (row.score_completeness as string) || null,
      trading_style: (row.trading_style as string) || null,
      avg_holding_hours: row.avg_holding_hours != null ? Number(row.avg_holding_hours) : null,
      style_confidence: null,
      is_bot: row.source === 'web3_bot' || row.trader_type === 'bot',
      trader_type: (row.trader_type as string) || (row.source === 'web3_bot' ? 'bot' : null),
    };
  });

  return {
    traders,
    window: seasonId as '7D' | '30D' | '90D' | 'COMPOSITE',
    // totalCount (camelCase) is what the frontend actually reads
    // (useTraderData.ts:275: `data.totalCount ?? totalCountRef.current`).
    // totalcount + total_count kept for backward compat with tests/older clients.
    totalCount: totalCount || 0,
    totalcount: totalCount || 0,
    total_count: totalCount || 0,
    as_of: new Date(latestCapturedAt).toISOString(),
    is_stale: isStale,
    availableSources,
    next_cursor: null,
  };
}

/**
 * Composite rankings: uses 90D arena_score directly.
 *
 * compute-leaderboard already computes a weighted composite score
 * (90D x 0.70 + 30D x 0.25 + 7D x 0.05) and stores it as arena_score in 90D.
 * So instead of fetching 3 seasons and merging in JS, we just query 90D.
 * This reduces DB load from 3 queries to 1 and eliminates in-memory merge.
 */
async function getCompositeRankings(params: {
  category?: TradingCategory;
  platform?: Platform;
  limit: number;
  offset: number;
  sort_by: string;
  sort_dir: 'asc' | 'desc';
  min_pnl?: number;
  min_trades?: number;
}) {
  // Composite = 90D (which already contains the weighted composite arena_score)
  // Delegate to getRankingsFallback with window='90d' and relabel as COMPOSITE
  const result = await getRankingsFallback({
    window: '90d' as RankingWindow,
    category: params.category,
    platform: params.platform,
    limit: params.limit,
    offset: params.offset,
    sort_by: params.sort_by as 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers' | 'win_rate' | 'sharpe_ratio' | 'trades_count',
    sort_dir: params.sort_dir,
    min_pnl: params.min_pnl,
    min_trades: params.min_trades,
  })

  return {
    ...result,
    window: 'COMPOSITE' as const,
  }
}
