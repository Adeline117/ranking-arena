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
import logger from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const plog = await PipelineLogger.start('discover-traders');
  try {
    const runner = new JobRunner();
    const platforms = getAvailablePlatforms();
    const results: Array<{ platform: string; job_id: string | null }> = [];

    for (const platform of platforms) {
      try {
        const job = await runner.enqueueDiscovery(platform as Platform, 3);
        results.push({ platform, job_id: job?.id || null });
      } catch (err) {
        logger.warn(`[discover-traders] Failed to enqueue ${platform}: ${err instanceof Error ? err.message : String(err)}`)
        results.push({ platform, job_id: null });
      }
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

    await plog.success(enqueuedCount, { platforms: results });
    return NextResponse.json({
      success: true,
      enqueued: enqueuedCount,
      platforms: results,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    await plog.error(error instanceof Error ? error : new Error(String(error)));
    logger.error('[Cron /discover-traders] Error:', error);

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
