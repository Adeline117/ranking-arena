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
 *   limit: number (default 100, max 2000)
 *   offset: number (default 0) — legacy, prefer cursor
 *   cursor: string (optional, format: "score:id" for keyset pagination)
 *   sort_by: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers'
 *   sort_dir: 'asc' | 'desc'
 *   min_pnl: number (optional)
 *   min_trades: number (optional)
 *
 * Response:
 *   { data:[], meta: { window, category, platform, totalcount, ... } }
 *
 * Caching: s-maxage=60, stale-while-revalidate=300
 */

import { NextResponse } from 'next/server';
import type { RankingWindow, TradingCategory, Platform, GranularPlatform, RankingsQuery } from '@/lib/types/leaderboard';
import { GRANULAR_PLATFORMS, PLATFORM_CATEGORY } from '@/lib/types/leaderboard';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getLeaderboard } from '@/lib/data/unified';
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
const VALID_SORT_BY = ['arena_score', 'roi', 'pnl', 'drawdown', 'copiers'] as const;

// Composite window weights
const COMPOSITE_WEIGHTS = { '7D': 0.20, '30D': 0.45, '90D': 0.35 } as const;

// Data quality: ROI values above this threshold are considered anomalous
const ROI_ANOMALY_THRESHOLD = 5000; // 5000% = 50x — anything above is likely data error

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

    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10) || 100, 2000);
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
}, { name: 'rankings', rateLimit: 'read' })

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
  const safeLimit = Math.min(limit, 2000);
  const seasonId = window.toUpperCase() as TradingPeriod;

  // Map sort_by to unified sortBy parameter
  const sortByMap: Record<string, 'rank' | 'arena_score' | 'roi' | 'pnl'> = {
    arena_score: 'arena_score',
    roi: 'roi',
    pnl: 'pnl',
    drawdown: 'arena_score', // no direct drawdown sort in unified, fall back to arena_score
    copiers: 'arena_score',  // no direct copiers sort in unified, fall back to arena_score
  };
  const unifiedSortBy = sortByMap[sort_by] || 'arena_score';

  // Determine platform filter based on category
  let platformFilter: string | undefined = platform || undefined;
  let platformsInCategory: string[] | undefined;
  if (!platformFilter && category) {
    platformsInCategory = Object.entries(PLATFORM_CATEGORY)
      .filter(([, cat]) => cat === category)
      .map(([p]) => p);
  }

  // Build direct query against leaderboard_ranks for full control over filters
  let dbQuery = supabase
    .from('leaderboard_ranks')
    .select(
      `source_trader_id, handle, source, source_type, roi, pnl, win_rate, max_drawdown,
       trades_count, followers, arena_score, avatar_url, rank, computed_at,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, sharpe_ratio, sortino_ratio, trader_type, is_outlier`,
      { count: 'exact' }
    )
    .eq('season_id', seasonId)
    .not('arena_score', 'is', null)
    .or('is_outlier.is.null,is_outlier.eq.false')

  // Apply ROI anomaly filter
  dbQuery = dbQuery.lte('roi', ROI_ANOMALY_THRESHOLD).gte('roi', -ROI_ANOMALY_THRESHOLD)

  if (platformFilter) {
    dbQuery = dbQuery.eq('source', platformFilter);
  } else if (platformsInCategory && platformsInCategory.length > 0) {
    dbQuery = dbQuery.in('source', platformsInCategory);
  }

  if (min_pnl != null) {
    dbQuery = dbQuery.gte('pnl', min_pnl);
  }
  if (min_trades != null) {
    dbQuery = dbQuery.gte('trades_count', min_trades);
  }

  // Filter by trader type (human/bot)
  if (trader_type === 'bot') {
    dbQuery = dbQuery.or('trader_type.eq.bot,source.eq.web3_bot');
  } else if (trader_type === 'human') {
    dbQuery = dbQuery.neq('source', 'web3_bot').or('trader_type.is.null,trader_type.neq.bot');
  }

  // Sorting
  const sortColumn = unifiedSortBy === 'rank' ? 'rank' : unifiedSortBy;
  const ascending = sort_dir === 'asc';
  dbQuery = dbQuery.order(sortColumn, { ascending, nullsFirst: false });
  dbQuery = dbQuery.range(offset, offset + safeLimit - 1);

  const { data: rows, count: totalCount, error } = await dbQuery;

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
  const traders = paginatedRows.map((row: Record<string, unknown>, idx: number) => {
    return {
      platform: row.source as Platform,
      trader_key: row.source_trader_id as string,
      display_name: (row.handle as string) || null,
      avatar_url: (row.avatar_url as string) || null,
      rank: (row.rank as number) ?? offset + idx + 1,
      metrics: {
        roi: row.roi != null ? Number(row.roi) : null,
        pnl: row.pnl != null ? Number(row.pnl) : null,
        win_rate: row.win_rate != null ? Number(row.win_rate) : null,
        max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
        trades_count: (row.trades_count as number) ?? null,
        followers: (row.followers as number) ?? null,
        copiers: null,
        aum: null,
        arena_score: row.arena_score != null ? Number(row.arena_score) : null,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
        sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
        sortino_ratio: row.sortino_ratio != null ? Number(row.sortino_ratio) : null,
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
 * Composite rankings: weighted average of 7D/30D/90D arena_score
 * Weight: 7D×0.20 + 30D×0.45 + 90D×0.35
 * Now reads from leaderboard_ranks instead of trader_snapshots.
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
  const { category, platform, limit, offset, sort_by, sort_dir, min_pnl, min_trades } = params;
  const supabase = getSupabaseAdmin();

  // Fetch all three windows in parallel from leaderboard_ranks
  const fetchWindow = async (seasonId: string) => {
    let q = supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, handle, avatar_url, computed_at, arena_score, roi, pnl, max_drawdown, win_rate, trades_count, followers, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, sharpe_ratio, trader_type, is_outlier')
      .eq('season_id', seasonId)
      .not('arena_score', 'is', null)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .lte('roi', ROI_ANOMALY_THRESHOLD)
      .gte('roi', -ROI_ANOMALY_THRESHOLD)
      .order('arena_score', { ascending: false, nullsFirst: false })
      .limit(2000);

    if (platform) q = q.eq('source', platform);
    else if (category) {
      const platformsInCategory = Object.entries(PLATFORM_CATEGORY)
        .filter(([, cat]) => cat === category)
        .map(([p]) => p);
      if (platformsInCategory.length > 0) q = q.in('source', platformsInCategory);
    }
    if (min_pnl != null) q = q.gte('pnl', min_pnl);
    if (min_trades != null) q = q.gte('trades_count', min_trades);

    const { data, error } = await q;
    if (error) throw new Error(`Composite fetch ${seasonId} failed: ${error.message}`);
    return data || [];
  };

  const [rows7d, rows30d, rows90d] = await Promise.all([
    fetchWindow('7D'),
    fetchWindow('30D'),
    fetchWindow('90D'),
  ]);

  // Build maps keyed by source:source_trader_id
  type LRRow = typeof rows7d[number];
  type RowMap = Map<string, LRRow>;
  const buildMap = (rows: LRRow[]): RowMap => {
    const m = new Map<string, LRRow>();
    for (const r of rows) {
      const key = `${r.source}:${r.source_trader_id}`;
      if (!m.has(key)) m.set(key, r);
    }
    return m;
  };

  const map7d = buildMap(rows7d);
  const map30d = buildMap(rows30d);
  const map90d = buildMap(rows90d);

  // Union all trader keys
  const allKeys = new Set<string>();
  [map7d, map30d, map90d].forEach(m => m.forEach((_, k) => allKeys.add(k)));

  // Compute weighted scores
  interface CompositeEntry {
    key: string;
    source: string;
    source_trader_id: string;
    compositeScore: number;
    primaryRow: LRRow;
  }

  const entries: CompositeEntry[] = [];
  for (const key of allKeys) {
    const r7 = map7d.get(key);
    const r30 = map30d.get(key);
    const r90 = map90d.get(key);

    const getScore = (r: LRRow | undefined) => {
      if (!r) return null;
      return r.arena_score != null ? Number(r.arena_score) : null;
    };

    const s7 = getScore(r7);
    const s30 = getScore(r30);
    const s90 = getScore(r90);

    // Need at least one score
    if (s7 == null && s30 == null && s90 == null) continue;

    // Weighted average (re-normalize weights for available windows)
    let totalWeight = 0;
    let weightedSum = 0;
    if (s7 != null) { weightedSum += s7 * COMPOSITE_WEIGHTS['7D']; totalWeight += COMPOSITE_WEIGHTS['7D']; }
    if (s30 != null) { weightedSum += s30 * COMPOSITE_WEIGHTS['30D']; totalWeight += COMPOSITE_WEIGHTS['30D']; }
    if (s90 != null) { weightedSum += s90 * COMPOSITE_WEIGHTS['90D']; totalWeight += COMPOSITE_WEIGHTS['90D']; }

    const compositeScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const primaryRow = r90 || r30 || r7!;
    const [source, ...restParts] = key.split(':');
    const source_trader_id = restParts.join(':');

    entries.push({ key, source, source_trader_id, compositeScore, primaryRow });
  }

  // Sort
  const sortFn = (a: CompositeEntry, b: CompositeEntry) => {
    let aVal = a.compositeScore, bVal = b.compositeScore;
    if (sort_by === 'roi') {
      aVal = a.primaryRow.roi != null ? Number(a.primaryRow.roi) : 0;
      bVal = b.primaryRow.roi != null ? Number(b.primaryRow.roi) : 0;
    }
    return sort_dir === 'desc' ? bVal - aVal : aVal - bVal;
  };
  entries.sort(sortFn);

  const total = entries.length;
  const paginated = entries.slice(offset, offset + limit);

  const traders = paginated.map((entry, idx) => {
    const row = entry.primaryRow;
    return {
      platform: entry.source,
      trader_key: entry.source_trader_id,
      display_name: (row.handle as string) || null,
      avatar_url: (row.avatar_url as string) || null,
      rank: offset + idx + 1,
      metrics: {
        roi: row.roi != null ? Number(row.roi) : null,
        pnl: row.pnl != null ? Number(row.pnl) : null,
        win_rate: row.win_rate != null ? Number(row.win_rate) : null,
        max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
        trades_count: row.trades_count ?? null,
        followers: row.followers ?? null,
        copiers: null,
        aum: null,
        arena_score: Math.round(entry.compositeScore * 10) / 10,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
        sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
        sortino_ratio: null,
        platform_rank: offset + idx + 1,
      },
      quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
      updated_at: row.computed_at,
      profitability_score: row.profitability_score != null ? Number(row.profitability_score) : null,
      risk_control_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
      execution_score: row.execution_score != null ? Number(row.execution_score) : null,
      score_completeness: row.score_completeness || null,
      trading_style: row.trading_style || null,
      avg_holding_hours: row.avg_holding_hours != null ? Number(row.avg_holding_hours) : null,
      style_confidence: null,
      is_bot: entry.source === 'web3_bot' || row.trader_type === 'bot',
      trader_type: row.trader_type || (entry.source === 'web3_bot' ? 'bot' : null),
    };
  });

  // Deduplicate 0x addresses (case-insensitive)
  const seenComposite = new Set<string>()
  const dedupedCompositeTraders = traders.filter((t: { trader_key: string; platform: string }) => {
    const key = (t.trader_key.startsWith('0x') ? t.trader_key.toLowerCase() : t.trader_key) + '|' + t.platform
    if (seenComposite.has(key)) return false
    seenComposite.add(key)
    return true
  })

  // Collect all unique sources across all windows for UI filter
  const allSources = new Set<string>();
  [map7d, map30d, map90d].forEach(m => m.forEach(r => allSources.add(r.source)));
  const availableSources = [...allSources].sort();

  // Check freshness
  const latestCaptured = Math.max(
    ...entries.slice(0, 100).map(e => new Date(e.primaryRow.computed_at as string).getTime()).filter(t => t > 0),
    0
  )
  const compositeIsStale = latestCaptured > 0 ? (Date.now() - latestCaptured) > 2 * 3600 * 1000 : true

  return {
    traders: dedupedCompositeTraders,
    window: 'COMPOSITE' as const,
    totalcount: total,
    total_count: total,
    as_of: latestCaptured > 0 ? new Date(latestCaptured).toISOString() : new Date().toISOString(),
    is_stale: compositeIsStale,
    availableSources,
  };
}
