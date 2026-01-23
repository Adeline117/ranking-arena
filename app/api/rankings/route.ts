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
import type { RankingWindow, TradingCategory, Platform, RankingsQuery } from '@/lib/types/leaderboard';
import { LEADERBOARD_PLATFORMS } from '@/lib/types/leaderboard';

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
    if (platform && !LEADERBOARD_PLATFORMS.includes(platform)) {
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
    const result = await service.getRankings(query);

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
