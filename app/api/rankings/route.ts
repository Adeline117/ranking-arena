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
import { LeaderboardService } from '@/lib/services/leaderboard';
import type { RankingWindow, TradingCategory, Platform, GranularPlatform, RankingsQuery, RankedTraderRow } from '@/lib/types/leaderboard';
import { LEADERBOARD_PLATFORMS, PLATFORM_CATEGORY } from '@/lib/types/leaderboard';
import { getSupabaseAdmin } from '@/lib/supabase/server';

const VALID_WINDOWS: RankingWindow[] = ['7d', '30d', '90d'];
const VALID_CATEGORIES: TradingCategory[] = ['futures', 'spot', 'onchain'];
const VALID_SORT_BY = ['arena_score', 'roi', 'pnl', 'drawdown', 'copiers'] as const;

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

    const platform = searchParams.get('platform') as Platform | null;
    if (platform && !(LEADERBOARD_PLATFORMS as readonly string[]).includes(platform)) {
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
      platform: platform || undefined,
      limit,
      offset,
      sort_by: sortBy,
      sort_dir: sortDir,
      min_pnl: minPnl,
      min_trades: minTrades,
    };

    const service = new LeaderboardService();

    let result;
    try {
      result = await service.getRankings(query);
    } catch (dbError) {
      // Fallback: use Supabase client when direct DB connection fails
      console.warn('[API /rankings] Direct DB failed, using Supabase fallback:', (dbError as Error).message);
      result = await getRankingsFallback(query);
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
      },
    });
  } catch (error) {
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
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const safeLimit = Math.min(limit, 500);

  // Map sort column
  const sortColumnMap: Record<string, string> = {
    arena_score: 'arena_score',
    roi: 'roi_pct',
    pnl: 'pnl_usd',
    drawdown: 'max_drawdown_pct',
    copiers: 'copier_count',
  };
  const sortColumn = sortColumnMap[sort_by] || 'arena_score';

  // Build query
  let dbQuery = supabase
    .from('trader_snapshots_v2')
    .select('id, platform, trader_key, window, as_of_ts, metrics, quality, arena_score, roi_pct, pnl_usd, max_drawdown_pct, win_rate_pct, trades_count, copier_count')
    .eq('window', window)
    .gte('as_of_ts', cutoff)
    .order(sortColumn, { ascending: sort_dir === 'asc', nullsFirst: false })
    .range(offset, offset + safeLimit - 1);

  if (platform) {
    dbQuery = dbQuery.eq('platform', platform);
  } else if (category) {
    const platformsInCategory = Object.entries(PLATFORM_CATEGORY)
      .filter(([, cat]) => cat === category)
      .map(([p]) => p);
    if (platformsInCategory.length > 0) {
      dbQuery = dbQuery.in('platform', platformsInCategory);
    }
  }

  if (min_pnl != null) {
    dbQuery = dbQuery.gte('pnl_usd', min_pnl);
  }
  if (min_trades != null) {
    dbQuery = dbQuery.gte('trades_count', min_trades);
  }

  const { data: rows, error, count } = await dbQuery;

  if (error) {
    throw new Error(`Supabase fallback failed: ${error.message}`);
  }

  // Fetch display names
  const traderKeys = [...new Set((rows || []).map(r => r.trader_key))];
  const platforms = [...new Set((rows || []).map(r => r.platform))];
  const displayNameMap = new Map<string, { display_name: string | null; avatar_url: string | null }>();

  if (traderKeys.length > 0) {
    const { data: sources } = await supabase
      .from('trader_sources_v2')
      .select('platform, trader_key, display_name, avatar_url')
      .in('platform', platforms)
      .in('trader_key', traderKeys);

    if (sources) {
      for (const src of sources) {
        displayNameMap.set(`${src.platform}:${src.trader_key}`, {
          display_name: src.display_name,
          avatar_url: src.avatar_url,
        });
      }
    }
  }

  // Deduplicate by platform:trader_key
  const seen = new Set<string>();
  const deduped = (rows || []).filter(row => {
    const key = `${row.platform}:${row.trader_key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const rankedRows: RankedTraderRow[] = deduped.map((row, idx) => {
    const source = displayNameMap.get(`${row.platform}:${row.trader_key}`);
    return {
      rank: offset + idx + 1,
      platform: row.platform as Platform,
      trader_key: row.trader_key,
      display_name: source?.display_name || null,
      avatar_url: source?.avatar_url || null,
      category: PLATFORM_CATEGORY[row.platform as unknown as GranularPlatform] || 'futures',
      metrics: row.metrics,
      quality: row.quality,
      as_of_ts: row.as_of_ts,
    };
  });

  return {
    data: rankedRows,
    meta: {
      window,
      category: category || 'all' as const,
      platform: platform || 'all' as const,
      total_count: count || deduped.length,
      limit: safeLimit,
      offset,
      cached_at: new Date().toISOString(),
      sort_by,
      sort_dir,
    },
  };
}
