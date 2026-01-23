/**
 * GET /api/cron/run-jobs
 *
 * Cron handler: processes pending refresh jobs from the queue.
 * Called periodically (every 1-5 minutes) by Vercel Cron or external scheduler.
 *
 * Query params:
 *   platform: Optional platform filter
 *   max: Max jobs to process (default 10)
 *   prewarm: If "true", also enqueue top trader prewarming
 *
 * Security: Protected by CRON_SECRET header check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { JobRunner, prewarmTopTraders } from '@/lib/services/job-runner';
import type { Platform } from '@/lib/types/leaderboard';

export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const platform = searchParams.get('platform') as Platform | null;
    const maxJobs = parseInt(searchParams.get('max') || '10', 10);
    const shouldPrewarm = searchParams.get('prewarm') === 'true';

    const runner = new JobRunner();

    // Process pending jobs
    const result = await runner.processBatch(maxJobs, platform || undefined);

    // Optionally prewarm top traders
    let prewarmed = 0;
    if (shouldPrewarm) {
      prewarmed = await prewarmTopTraders(runner);
    }

    return NextResponse.json({
      success: true,
      jobs: result,
      prewarmed,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron /run-jobs] Error:', error);
    return NextResponse.json(
      { error: 'Job processing failed', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 },
    );
  }
}
