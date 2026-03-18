/**
 * GET /api/platforms/health
 *
 * Returns health status for all platforms.
 * Used by frontend to show which platforms are available.
 */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    const { data: health } = await supabase
      .from('platform_health')
      .select('platform, status, last_success_at, error_count, avg_response_ms')
      .order('platform');

    // Get latest data timestamps per platform using RPC or limited query
    const latestByPlatform = new Map<string, string>();

    // Try leaderboard_ranks — fetch only distinct platforms with latest timestamp
    const { data: lbFreshness } = await supabase
      .from('leaderboard_ranks')
      .select('platform, updated_at')
      .order('updated_at', { ascending: false })
      .limit(100);

    for (const row of lbFreshness || []) {
      const key = row.platform;
      if (key && !latestByPlatform.has(key)) {
        latestByPlatform.set(key, row.updated_at);
      }
    }

    // Also check trader_snapshots_v2 for platforms not in leaderboard
    const { data: snapFreshness } = await supabase
      .from('trader_snapshots_v2')
      .select('platform, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    for (const row of snapFreshness || []) {
      const key = row.platform;
      if (key && !latestByPlatform.has(key)) {
        latestByPlatform.set(key, row.created_at);
      }
    }

    return NextResponse.json({
      platforms: health || [],
      freshness: Object.fromEntries(latestByPlatform),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error: unknown) {
    logger.error('[platforms/health] Error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
