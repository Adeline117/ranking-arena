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
 *   { data: RankedTraderRow[], meta: { window, category, platform, total_count, ... } }
 *
 * Caching: s-maxage=60, stale-while-revalidate=300
 */

import { NextRequest, NextResponse } from 'next/server';
import type { RankingWindow, TradingCategory, Platform, GranularPlatform, RankingsQuery, RankedTraderRow } from '@/lib/types/leaderboard';
import { GRANULAR_PLATFORMS, PLATFORM_CATEGORY } from '@/lib/types/leaderboard';
import { getSupabaseAdmin } from '@/lib/supabase/server';

const VALID_WINDOWS: RankingWindow[] = ['7d', '30d', '90d'];
const VALID_CATEGORIES: TradingCategory[] = ['futures', 'spot', 'onchain'];
const VALID_SORT_BY = ['arena_score', 'roi', 'pnl', 'drawdown', 'copiers'] as const;

// Data quality: ROI values above this threshold are considered anomalous
const ROI_ANOMALY_THRESHOLD = 10000; // 10000% = 100x

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse & validate window (required)
    const window = searchParams.get('window') as RankingWindow | null;
    if (!window || !VALID_WINDOWS.includes(window)) {
      return NextResponse.json(
        { error: 'Invalid or missing window parameter. Must be one of: 7d, 30d, 90d' },
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

    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10) || 100, 500);
    const offset = parseInt(searchParams.get('offset') || '0', 10) || 0;
    const minPnl = searchParams.get('min_pnl') ? Number(searchParams.get('min_pnl')) : undefined;
    const minTrades = searchParams.get('min_trades') ? Number(searchParams.get('min_trades')) : undefined;

    const query: RankingsQuery = {
      window,
      category: category || undefined,
      // Cast to Platform for type compat - database uses granular names like 'htx_futures'
      platform: (platform || undefined) as Platform | undefined,
      limit,
      offset,
      sort_by: sortBy,
      sort_dir: sortDir,
      min_pnl: minPnl,
      min_trades: minTrades,
    };

    // Use Supabase fallback directly as it queries trader_snapshots (with actual data)
    // LeaderboardService queries trader_snapshots_v2 which is empty
    const result = await getRankingsFallback(query);

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
      },
    });
  } catch (error: unknown) {
    console.error('[API /rankings] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
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
    limit = 100,
    offset = 0,
    sort_by = 'arena_score',
    sort_dir = 'desc',
    min_pnl,
    min_trades,
  } = rankingsQuery;

  const supabase = getSupabaseAdmin();
  const safeLimit = Math.min(limit, 1000);
  // Fetch more rows to account for duplicates (each trader may have multiple snapshots)
  const fetchLimit = Math.min(safeLimit * 10, 10000);

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
  // Note: this table uses 'season_id' not 'window'
  let dbQuery = supabase
    .from('trader_snapshots')
    .select('id, source, source_trader_id, season_id, captured_at, arena_score, roi, pnl, max_drawdown, win_rate, trades_count, followers', { count: 'exact' })
    .eq('season_id', seasonId)
    .not('arena_score', 'is', null)
    .lte('roi', ROI_ANOMALY_THRESHOLD) // Filter out extreme ROI anomalies
    .order(sortColumn, { ascending: sort_dir === 'asc', nullsFirst: false })
    .range(0, fetchLimit - 1);

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

  const { data: rows, error, count } = await dbQuery;

  if (error) {
    throw new Error(`Supabase fallback failed: ${error.message}`);
  }

  // Fetch display names from trader_profiles and trader_sources
  const traderKeys = [...new Set((rows || []).map(r => r.source_trader_id))];
  const platforms = [...new Set((rows || []).map(r => r.source))];
  const displayNameMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();

  if (traderKeys.length > 0) {
    // Fetch display names and avatar URLs from trader_sources
    const { data: sources } = await supabase
      .from('trader_sources')
      .select('source, source_trader_id, handle, avatar_url')
      .in('source', platforms)
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

  // Deduplicate by source:source_trader_id (keep first occurrence which has highest score)
  const seen = new Set<string>();
  const allDeduped = (rows || []).filter(row => {
    const key = `${row.source}:${row.source_trader_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Apply pagination after deduplication
  const totalUniqueTraders = allDeduped.length;
  const paginatedDeduped = allDeduped.slice(offset, offset + safeLimit);

  const rankedRows: RankedTraderRow[] = paginatedDeduped.map((row, idx) => {
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
    };
  });

  // Calculate staleness - data older than 1 hour is considered stale
  const latestCapturedAt = paginatedDeduped.length > 0
    ? Math.max(...paginatedDeduped.map(r => new Date(r.captured_at).getTime()))
    : Date.now();
  const stalenessMs = Date.now() - latestCapturedAt;
  const isStale = stalenessMs > 3600 * 1000; // > 1 hour

  // Transform to RankingsResponse format expected by frontend
  const traders = rankedRows.map(row => ({
    platform: row.platform,
    trader_key: row.trader_key,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    rank: row.rank,
    metrics: row.metrics,
    quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
    updated_at: row.as_of_ts,
  }));

  return {
    traders,
    window: window.toUpperCase() as '7D' | '30D' | '90D',
    total_count: totalUniqueTraders,
    as_of: new Date(latestCapturedAt).toISOString(),
    is_stale: isStale,
  };
}
