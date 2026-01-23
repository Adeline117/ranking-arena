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
      const job = await runner.enqueueDiscovery(platform, 3);
      results.push({ platform, job_id: job?.id || null });
    }

    return NextResponse.json({
      success: true,
      enqueued: results.filter((r) => r.job_id).length,
      platforms: results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron /discover-traders] Error:', error);
    return NextResponse.json(
      { error: 'Discovery scheduling failed' },
      { status: 500 },
    );
  }
}
