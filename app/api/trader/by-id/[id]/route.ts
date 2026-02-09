/**
 * GET /api/trader/by-id/:id
 *
 * Returns full trader detail: identity + profile + snapshots + timeseries + freshness.
 * The :id param format is "{platform}:{trader_key}" (e.g. "binance_futures:abc123").
 *
 * All data is read from DB only. No synchronous scraping.
 * Target response time: <200ms.
 *
 * Response: TraderDetailResponse
 *   {
 *     identity: { platform, trader_key, display_name, ... },
 *     profile: { bio, copier_count, aum_usd, ... } | null,
 *     snapshots: { "7d": {...} | null, "30d": {...} | null, "90d": {...} | null },
 *     timeseries: [...],
 *     data_freshness: { last_snapshot_at, is_stale, stale_reason, ... }
 *   }
 *
 * Caching: s-maxage=300, stale-while-revalidate=600
 */

import { NextRequest, NextResponse } from 'next/server';
import { LeaderboardService } from '@/lib/services/leaderboard';
import type { Platform, LeaderboardPlatform } from '@/lib/types/leaderboard';
import { LEADERBOARD_PLATFORMS } from '@/lib/types/leaderboard';
import logger from '@/lib/logger'

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    // Parse composite ID: "platform:trader_key"
    const separatorIndex = id.indexOf(':');
    if (separatorIndex === -1) {
      return NextResponse.json(
        { error: 'Invalid trader ID format. Expected: {platform}:{trader_key}' },
        { status: 400 },
      );
    }

    const platform = id.substring(0, separatorIndex) as Platform;
    const traderKey = id.substring(separatorIndex + 1);

    if (!LEADERBOARD_PLATFORMS.includes(platform as LeaderboardPlatform)) {
      return NextResponse.json(
        { error: `Invalid platform: ${platform}` },
        { status: 400 },
      );
    }

    if (!traderKey) {
      return NextResponse.json(
        { error: 'trader_key cannot be empty' },
        { status: 400 },
      );
    }

    const service = new LeaderboardService();
    const result = await service.getTraderDetail(platform, traderKey);

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';

    if (message.includes('not found')) {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    logger.error('[API /trader/by-id/:id] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
