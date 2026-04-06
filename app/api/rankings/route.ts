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
import { tieredGetOrSet } from '@/lib/cache/redis-layer';
import { ApiError } from '@/lib/api/errors';
import { success as apiSuccess, withCache } from '@/lib/api/response';
import { withPublic } from '@/lib/api/middleware'

// In-memory cache for availableSources (TTL 5 minutes)
const sourcesCache = new Map<string, { sources: string[]; ts: number }>();
const SOURCES_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — sources change only on cron runs

function getCachedSources(seasonId: string): string[] | null {
  const entry = sourcesCache.get(seasonId);
  if (entry && Date.now() - entry.ts < SOURCES_CACHE_TTL) return entry.sources;
  return null;
}

function setCachedSources(seasonId: string, sources: string[]) {
  sourcesCache.set(seasonId, { sources, ts: Date.now() });
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

    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10) || 100, 500);
    const offset = parseInt(searchParams.get('offset') || '0', 10) || 0;
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

  const supabase = getSupabaseAdmin();
  const safeLimit = Math.min(limit, 5000);
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

  function buildBaseQuery(opts?: { count?: 'exact' }) {
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
    // Single request — include count
    const result = await buildBaseQuery({ count: 'exact' })
      .range(offset, offset + safeLimit - 1);
    rows = (result.data || []) as Record<string, unknown>[];
    totalCount = result.count;
    error = result.error;
  } else {
    // Chunked fetch: first chunk gets count, rest fetch in parallel
    const firstResult = await buildBaseQuery({ count: 'exact' })
      .range(offset, offset + CHUNK_SIZE - 1);
    if (firstResult.error) {
      error = firstResult.error;
    } else {
      rows = (firstResult.data || []) as Record<string, unknown>[];
      totalCount = firstResult.count;

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

  // Get available sources (with memory cache)
  const seasonIdUpper = seasonId;
  let availableSources: string[];
  const cached = getCachedSources(seasonIdUpper);
  if (cached) {
    availableSources = cached;
  } else {
    const { data: sourceRows } = await supabase
      .from('leaderboard_ranks')
      .select('source')
      .eq('season_id', seasonIdUpper)
      .not('arena_score', 'is', null)
      .limit(200);
    availableSources = [...new Set((sourceRows || []).map((r: { source: string }) => r.source))].sort();
    setCachedSources(seasonIdUpper, availableSources);
  }

  // Freshness check from computed_at
  let latestCapturedAt: number;
  if (paginatedRows.length > 0) {
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
    return {
      platform: row.source as Platform,
      trader_key: traderId,
      display_name: formatDisplayName(row.handle as string | null, traderId),
      avatar_url: (row.avatar_url as string) || null,
      rank: (row.rank as number) ?? offset + idx + 1,
      rank_change: (row.rank_change as number) ?? null,
      is_new: (row.is_new as boolean) ?? false,
      metrics: {
        roi: row.roi != null ? Number(row.roi) : null,
        pnl: row.pnl != null ? Number(row.pnl) : null,
        win_rate: row.win_rate != null ? Number(row.win_rate) : null,
        max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
        trades_count: (row.trades_count as number) ?? null,
        followers: (row.followers as number) ?? null,
        copiers: row.copiers != null ? Number(row.copiers) : null,
        aum: null,
        arena_score: row.arena_score != null ? Number(row.arena_score) : null,
        return_score: row.profitability_score != null ? Number(row.profitability_score) : null,
        drawdown_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
        stability_score: row.execution_score != null ? Number(row.execution_score) : null,
        sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
        sortino_ratio: row.sortino_ratio != null ? Number(row.sortino_ratio) : null,
        calmar_ratio: row.calmar_ratio != null ? Number(row.calmar_ratio) : null,
        profit_factor: row.profit_factor != null ? Number(row.profit_factor) : null,
        platform_rank: (row.rank as number) ?? offset + idx + 1,
      },
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
