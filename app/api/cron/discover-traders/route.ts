/**
 * GET /api/cron/discover-traders
 *
 * Cron handler: enqueues discovery jobs for all implemented platforms.
 * Discovery jobs fetch the leaderboard and upsert trader identities.
 *
 * Called every 4 hours by Vercel Cron.
 *
 * Security: Protected by CRON_SECRET header.
 */

import { NextRequest, NextResponse } from 'next/server';
import { JobRunner } from '@/lib/services/job-runner';
import { getAvailablePlatforms } from '@/lib/connectors/registry';
import type { Platform } from '@/lib/types/leaderboard';
import { createClient } from '@supabase/supabase-js';
import { recordFetchResult } from '@/lib/utils/pipeline-monitor';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const runner = new JobRunner();
    const platforms = getAvailablePlatforms();
    const results: Array<{ platform: string; job_id: string | null }> = [];

    for (const platform of platforms) {
      const job = await runner.enqueueDiscovery(platform as Platform, 3);
      results.push({ platform, job_id: job?.id || null });
    }

    // Record pipeline metrics
    const enqueuedCount = results.filter((r) => r.job_id).length;
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
      await recordFetchResult(supabase, 'discover_traders', {
        success: true,
        durationMs: Date.now() - Date.now(), // minimal
        recordCount: enqueuedCount,
        metadata: { platforms: results },
      });
    } catch { /* ignore */ }

    return NextResponse.json({
      success: true,
      enqueued: enqueuedCount,
      platforms: results,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('[Cron /discover-traders] Error:', error);

    // Record error metric
    try {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );
      await recordFetchResult(supabase, 'discover_traders', {
        success: false,
        durationMs: 0,
        recordCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch { /* ignore */ }

    return NextResponse.json(
      { error: 'Discovery scheduling failed' },
      { status: 500 },
    );
  }
}
