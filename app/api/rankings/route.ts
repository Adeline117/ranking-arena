/**
 * GET /api/rankings
 *
 * Returns ranked traders for a given window, with optional platform/category filters.
 * Reads from pre-populated trader_snapshots_v2 table only.
 *
 * Query params:
 *   window: '7d' | '30d' | '90d' (required)
 *   category: 'futures' | 'spot' | 'onchain' (optional)
 *   platform: Platform string (optional, overrides category)
 *   limit: number (default 100, max 500)
 *   offset: number (default 0)
 *   sort_by: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers'
 *   sort_dir: 'asc' | 'desc'
 *   min_pnl: number (optional)
 *   min_trades: number (optional)
 *
 * Response:
 *   { data: RankedTraderRow[], meta: { window, category, platform, totalcount, ... } }
 *
 * Caching: s-maxage=60, stale-while-revalidate=300
 */

import { NextRequest, NextResponse } from 'next/server';
import type { RankingWindow, TradingCategory, Platform, GranularPlatform, RankingsQuery, RankedTraderRow } from '@/lib/types/leaderboard';
import { GRANULAR_PLATFORMS, PLATFORM_CATEGORY } from '@/lib/types/leaderboard';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { checkRateLimit, setRateLimitHeaders, getClientIp } from '@/lib/middleware/rate-limit';
import { tieredGetOrSet } from '@/lib/cache/redis-layer';
import logger from '@/lib/logger'

const VALID_WINDOWS: (RankingWindow | 'composite')[] = ['7d', '30d', '90d', 'composite'];
const VALID_CATEGORIES: TradingCategory[] = ['futures', 'spot', 'onchain'];
const VALID_SORT_BY = ['arena_score', 'roi', 'pnl', 'drawdown', 'copiers'] as const;

// Composite window weights
const COMPOSITE_WEIGHTS = { '7D': 0.20, '30D': 0.45, '90D': 0.35 } as const;

// Data quality: ROI values above this threshold are considered anomalous
const ROI_ANOMALY_THRESHOLD = 5000; // 5000% = 50x — anything above is likely data error

export async function GET(request: NextRequest) {
  try {
    // Rate limit check
    const clientIp = getClientIp(request)
    const rateLimit = checkRateLimit(`rankings:${clientIp}`, { limit: 60, windowSec: 60 })
    if (!rateLimit.success) {
      const res = NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        { status: 429 }
      )
      setRateLimitHeaders(res.headers, rateLimit)
      res.headers.set('Retry-After', String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)))
      return res
    }

    const { searchParams } = new URL(request.url);

    // Parse & validate window (required)
    const window = searchParams.get('window') as RankingWindow | 'composite' | null;
    const normalizedWindow = window?.toLowerCase() as RankingWindow | 'composite';
    if (!normalizedWindow || !VALID_WINDOWS.includes(normalizedWindow)) {
      return NextResponse.json(
        { error: 'Invalid or missing window parameter. Must be one of: 7d, 30d, 90d, composite' },
        { status: 400 },
      );
    }

    // Parse optional params
    const category = searchParams.get('category') as TradingCategory | null;
    if (category && !VALID_CATEGORIES.includes(category)) {
      return NextResponse.json(
        { error: 'Invalid category. Must be one of: futures, spot, onchain' },
        { status: 400 },
      );
    }

    const platform = searchParams.get('platform') as GranularPlatform | null;
    if (platform && !(GRANULAR_PLATFORMS as readonly string[]).includes(platform)) {
      return NextResponse.json(
        { error: `Invalid platform: ${platform}` },
        { status: 400 },
      );
    }

    const sortBy = (searchParams.get('sort_by') || 'arena_score') as typeof VALID_SORT_BY[number];
    if (!VALID_SORT_BY.includes(sortBy)) {
      return NextResponse.json(
        { error: `Invalid sort_by. Must be one of: ${VALID_SORT_BY.join(', ')}` },
        { status: 400 },
      );
    }

    const sortDir = (searchParams.get('sort_dir') || 'desc') as 'asc' | 'desc';

    const limit = Math.min(parseInt(searchParams.get('limit') || '2000', 10) || 2000, 10000);
    const offset = parseInt(searchParams.get('offset') || '0', 10) || 0;
    const minPnl = searchParams.get('min_pnl') ? Number(searchParams.get('min_pnl')) : undefined;
    const minTrades = searchParams.get('min_trades') ? Number(searchParams.get('min_trades')) : undefined;

    // Use tiered cache (memory → Redis → DB) for rankings
    const cacheKey = `api:rankings:${normalizedWindow}:${category || 'all'}:${platform || 'all'}:${sortBy}:${sortDir}:${limit}:${offset}:${minPnl || ''}:${minTrades || ''}`

     
    let result: any;

    if (normalizedWindow === 'composite') {
      // Composite: fetch all three windows and merge
      result = await tieredGetOrSet(
        cacheKey,
        () => getCompositeRankings({
          category: category || undefined,
          platform: (platform || undefined) as Platform | undefined,
          limit,
          offset,
          sort_by: sortBy,
          sort_dir: sortDir,
          min_pnl: minPnl,
          min_trades: minTrades,
        }),
        'hot',
        ['rankings']
      );
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
      };
      result = await tieredGetOrSet(
        cacheKey,
        () => getRankingsFallback(query),
        'hot',
        ['rankings']
      );
    }

    const res = NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    });
    setRateLimitHeaders(res.headers, rateLimit);
    return res;
  } catch (error: unknown) {
    logger.error('[API /rankings] Error:', error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: 'Internal server error', detail: msg },
      { status: 500 },
    );
  }
}

/**
 * Fallback: fetch rankings via Supabase client when direct DB pool fails.
 * Returns the same response shape as LeaderboardService.getRankings().
 * Queries trader_snapshots table (legacy) which has actual data.
 */
async function getRankingsFallback(rankingsQuery: RankingsQuery) {
  const {
    window,
    category,
    platform,
    limit = 2000,
    offset = 0,
    sort_by = 'arena_score',
    sort_dir = 'desc',
    min_pnl,
    min_trades,
  } = rankingsQuery;

  const supabase = getSupabaseAdmin();
  const safeLimit = Math.min(limit, 10000);

  // Map sort column for trader_snapshots table
  const sortColumnMap: Record<string, string> = {
    arena_score: 'arena_score',
    roi: 'roi',
    pnl: 'pnl',
    drawdown: 'max_drawdown',
    copiers: 'copiers',
  };
  const sortColumn = sortColumnMap[sort_by] || 'arena_score';

  // Map lowercase window to uppercase season_id (e.g., '90d' -> '90D')
  const seasonId = window.toUpperCase();

  // Build query against trader_snapshots (legacy table with actual data)
  // Note: unique constraint on (source, source_trader_id, season_id) guarantees no duplicates
  let dbQuery = supabase
    .from('trader_snapshots')
    .select('id, source, source_trader_id, season_id, captured_at, arena_score, arena_score_v3, roi, pnl, max_drawdown, win_rate, trades_count, followers, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence', { count: 'exact' })
    .eq('season_id', seasonId)
    .not('arena_score', 'is', null)
    .lte('roi', ROI_ANOMALY_THRESHOLD)
    .gte('roi', -ROI_ANOMALY_THRESHOLD)
    .order(sortColumn, { ascending: sort_dir === 'asc', nullsFirst: false })
    .range(offset, offset + safeLimit - 1);

  if (platform) {
    dbQuery = dbQuery.eq('source', platform);
  } else if (category) {
    const platformsInCategory = Object.entries(PLATFORM_CATEGORY)
      .filter(([, cat]) => cat === category)
      .map(([p]) => p);
    if (platformsInCategory.length > 0) {
      dbQuery = dbQuery.in('source', platformsInCategory);
    }
  }

  if (min_pnl != null) {
    dbQuery = dbQuery.gte('pnl', min_pnl);
  }
  if (min_trades != null) {
    dbQuery = dbQuery.gte('trades_count', min_trades);
  }

  const { data: rows, count: totalCount, error } = await dbQuery;

  if (error) {
    throw new Error(`Supabase fallback failed: ${error.message}`);
  }

  const paginatedRows = rows || [];

  // Batch fetch display names from trader_sources (single query)
  const traderKeys = [...new Set(paginatedRows.map(r => r.source_trader_id))];
  const platformKeys = [...new Set(paginatedRows.map(r => r.source))];
  const displayNameMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();

  if (traderKeys.length > 0) {
    const { data: sources } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .in('source', platformKeys)
      .in('source_trader_id', traderKeys);

    if (sources) {
      for (const src of sources) {
        const key = `${src.source}:${src.source_trader_id}`;
        displayNameMap.set(key, {
          display_name: src.handle,
          avatar_url: src.avatar_url,
        });
      }
    }
  }

  const rankedRows = paginatedRows.map((row, idx) => {
    const sourceInfo = displayNameMap.get(`${row.source}:${row.source_trader_id}`);
    const roi = row.roi ? parseFloat(row.roi) : 0;
    const pnl = row.pnl ? parseFloat(row.pnl) : 0;
    const winRate = row.win_rate ? parseFloat(row.win_rate) : null;
    const maxDrawdown = row.max_drawdown ? parseFloat(row.max_drawdown) : null;
    const arenaScore = row.arena_score ? parseFloat(row.arena_score) : null;

    return {
      rank: offset + idx + 1,
      platform: row.source as Platform,
      trader_key: row.source_trader_id,
      display_name: sourceInfo?.display_name || null,
      avatar_url: sourceInfo?.avatar_url || null,
      category: PLATFORM_CATEGORY[row.source as unknown as GranularPlatform] || 'futures',
      metrics: {
        roi,
        pnl,
        win_rate: winRate,
        max_drawdown: maxDrawdown,
        trades_count: row.trades_count ?? null,
        followers: row.followers ?? null,
        copiers: null, // Not available in this table
        aum: null, // Not available in this table
        arena_score: arenaScore,
        return_score: null, // Not available in this table
        drawdown_score: null, // Not available in this table
        stability_score: null, // Not available in this table
        sharpe_ratio: null, // Not available in this table
        sortino_ratio: null, // Not available in this table
        platform_rank: offset + idx + 1,
      },
      quality: { is_complete: true, missing_fields: [], confidence: 1.0, is_interpolated: false },
      as_of_ts: row.captured_at,
    } as unknown as RankedTraderRow;
  });
  // Note: no longer filtering out traders without display_name.
  // The frontend getTraderDisplayName() handles fallback to trader_key.

  // Calculate staleness based on the latest captured_at across the ENTIRE season,
  // not just the paginated rows (which may contain traders not recently re-scraped)
  let latestCapturedAt: number;
  const { data: freshnessRow } = await supabase
    .from('trader_snapshots')
    .select('captured_at')
    .eq('season_id', seasonId)
    .not('arena_score', 'is', null)
    .order('captured_at', { ascending: false })
    .limit(1)
    .single();
  
  if (freshnessRow) {
    latestCapturedAt = new Date(freshnessRow.captured_at).getTime();
  } else if (paginatedRows.length > 0) {
    latestCapturedAt = Math.max(...paginatedRows.map(r => new Date(r.captured_at).getTime()));
  } else {
    latestCapturedAt = Date.now();
  }
  const stalenessMs = Date.now() - latestCapturedAt;
  const isStale = stalenessMs > 3600 * 1000; // > 1 hour

  // Transform to RankingsResponse format expected by frontend
  const traders = rankedRows.map((row, idx) => {
    const rawRow = paginatedRows[idx];
    return {
      platform: row.platform,
      trader_key: row.trader_key,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      rank: row.rank,
      metrics: row.metrics,
      quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
      updated_at: row.as_of_ts,
      // Score breakdown fields
      profitability_score: rawRow?.profitability_score != null ? parseFloat(rawRow.profitability_score) : null,
      risk_control_score: rawRow?.risk_control_score != null ? parseFloat(rawRow.risk_control_score) : null,
      execution_score: rawRow?.execution_score != null ? parseFloat(rawRow.execution_score) : null,
      score_completeness: rawRow?.score_completeness || null,
      // Trading style fields
      trading_style: rawRow?.trading_style || null,
      avg_holding_hours: rawRow?.avg_holding_hours != null ? parseFloat(rawRow.avg_holding_hours) : null,
      style_confidence: rawRow?.style_confidence != null ? parseFloat(rawRow.style_confidence) : null,
    };
  });

  // Collect available sources for UI filter — use RPC or large enough sample
  const { data: allSourceRows } = await supabase
    .rpc('get_distinct_sources', { p_season_id: window.toUpperCase() })
    .limit(100);
  
  // Fallback: if RPC doesn't exist, query with enough limit to cover all sources
  let availableSources: string[];
  if (allSourceRows && allSourceRows.length > 0) {
    availableSources = allSourceRows.map((r: { source: string }) => r.source).sort();
  } else {
    // Fallback: sample from each source by querying without limit on source field
    const { data: fallbackRows } = await supabase
      .from('trader_snapshots')
      .select('source')
      .eq('season_id', window.toUpperCase())
      .not('arena_score', 'is', null)
      .limit(15000);
    availableSources = [...new Set((fallbackRows || []).map((r: { source: string }) => r.source))].sort();
  }

  return {
    traders,
    window: window.toUpperCase() as '7D' | '30D' | '90D' | 'COMPOSITE',
    totalcount: totalCount || 0,
    total_count: totalCount || 0,
    as_of: new Date(latestCapturedAt).toISOString(),
    is_stale: isStale,
    availableSources,
  };
}

/**
 * Composite rankings: weighted average of 7D/30D/90D arena_score_v3
 * Weight: 7D×0.20 + 30D×0.45 + 90D×0.35
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

  // Fetch all three windows in parallel
  const fetchWindow = async (seasonId: string) => {
    let q = supabase
      .from('trader_snapshots')
      .select('source, source_trader_id, captured_at, arena_score, arena_score_v3, roi, pnl, max_drawdown, win_rate, trades_count, followers, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, avg_holding_hours, style_confidence')
      .eq('season_id', seasonId)
      .not('arena_score', 'is', null)
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
  type RowMap = Map<string, typeof rows7d[number]>;
  const buildMap = (rows: typeof rows7d): RowMap => {
    const m = new Map<string, typeof rows7d[number]>();
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
    // Use 90D row as primary (most complete), fall back to 30D, 7D
    primaryRow: typeof rows7d[number];
  }

  const entries: CompositeEntry[] = [];
  for (const key of allKeys) {
    const r7 = map7d.get(key);
    const r30 = map30d.get(key);
    const r90 = map90d.get(key);

    const getScore = (r: typeof rows7d[number] | undefined) => {
      if (!r) return null;
      const v3 = r.arena_score_v3 != null ? parseFloat(r.arena_score_v3 as string) : null;
      if (v3 != null) return v3;
      return r.arena_score != null ? parseFloat(r.arena_score as string) : null;
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
    const [source, source_trader_id] = key.split(':');

    entries.push({ key, source, source_trader_id, compositeScore, primaryRow });
  }

  // Sort
  const sortFn = (a: CompositeEntry, b: CompositeEntry) => {
    let aVal = a.compositeScore, bVal = b.compositeScore;
    if (sort_by === 'roi') {
      aVal = a.primaryRow.roi ? parseFloat(a.primaryRow.roi as string) : 0;
      bVal = b.primaryRow.roi ? parseFloat(b.primaryRow.roi as string) : 0;
    }
    return sort_dir === 'desc' ? bVal - aVal : aVal - bVal;
  };
  entries.sort(sortFn);

  const total = entries.length;
  const paginated = entries.slice(offset, offset + limit);

  // Fetch display names
  const traderKeys = [...new Set(paginated.map(e => e.source_trader_id))];
  const sources = [...new Set(paginated.map(e => e.source))];
  const displayNameMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();

  if (traderKeys.length > 0) {
    const { data: srcData } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .in('source', sources)
      .in('source_trader_id', traderKeys);
    if (srcData) {
      for (const s of srcData) {
        displayNameMap.set(`${s.source}:${s.source_trader_id}`, { display_name: s.handle, avatar_url: s.avatar_url });
      }
    }
  }

  const traders = paginated.map((entry, idx) => {
    const info = displayNameMap.get(entry.key);
    const row = entry.primaryRow;
    return {
      platform: entry.source,
      trader_key: entry.source_trader_id,
      display_name: info?.display_name || null,
      avatar_url: info?.avatar_url || null,
      rank: offset + idx + 1,
      metrics: {
        roi: row.roi ? parseFloat(row.roi as string) : 0,
        pnl: row.pnl ? parseFloat(row.pnl as string) : 0,
        win_rate: row.win_rate ? parseFloat(row.win_rate as string) : null,
        max_drawdown: row.max_drawdown ? parseFloat(row.max_drawdown as string) : null,
        trades_count: row.trades_count ?? null,
        followers: row.followers ?? null,
        copiers: null,
        aum: null,
        arena_score: Math.round(entry.compositeScore * 10) / 10,
        return_score: null,
        drawdown_score: null,
        stability_score: null,
        sharpe_ratio: null,
        sortino_ratio: null,
        platform_rank: offset + idx + 1,
      },
      quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
      updated_at: row.captured_at,
      profitability_score: row.profitability_score != null ? parseFloat(row.profitability_score as string) : null,
      risk_control_score: row.risk_control_score != null ? parseFloat(row.risk_control_score as string) : null,
      execution_score: row.execution_score != null ? parseFloat(row.execution_score as string) : null,
      score_completeness: row.score_completeness || null,
      trading_style: row.trading_style || null,
      avg_holding_hours: row.avg_holding_hours != null ? parseFloat(row.avg_holding_hours as string) : null,
      style_confidence: row.style_confidence != null ? parseFloat(row.style_confidence as string) : null,
    };
  });

  // Note: no longer filtering out traders without display_name.
  // The frontend getTraderDisplayName() handles fallback to trader_key.

  // Collect all unique sources across all windows for UI filter
  const allSources = new Set<string>();
  [map7d, map30d, map90d].forEach(m => m.forEach(r => allSources.add(r.source)));
  const availableSources = [...allSources].sort();

  return {
    traders,
    window: 'COMPOSITE' as const,
    totalcount: total,
    total_count: total,
    as_of: new Date().toISOString(),
    is_stale: false,
    availableSources,
  };
}
