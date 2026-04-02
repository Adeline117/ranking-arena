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

    // Get latest data timestamps per platform from pipeline_logs (fast, indexed)
    const latestByPlatform = new Map<string, string>();

    // Use pipeline_logs for freshness — small table, always indexed
    const { data: pipelineLogs } = await supabase
      .from('pipeline_logs')
      .select('job_name, ended_at')
      .eq('status', 'success')
      .order('ended_at', { ascending: false })
      .limit(200);

    for (const row of pipelineLogs || []) {
      // Extract platform from job_name like "fetch-binance_futures" or "enrich-okx"
      const match = row.job_name?.match(/(?:fetch|enrich)-(.+)/);
      if (match) {
        const platform = match[1];
        if (!latestByPlatform.has(platform)) {
          latestByPlatform.set(platform, row.ended_at);
        }
      }
    }

    // Fallback: use leaderboard_ranks (already indexed on platform + season_id)
    if (latestByPlatform.size === 0) {
      const { data: lbFreshness } = await supabase
        .from('leaderboard_ranks')
        .select('platform, updated_at')
        .eq('season_id', '90D')
        .order('updated_at', { ascending: false })
        .limit(100);

      for (const row of lbFreshness || []) {
        const key = row.platform;
        if (key && !latestByPlatform.has(key)) {
          latestByPlatform.set(key, row.updated_at);
        }
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
