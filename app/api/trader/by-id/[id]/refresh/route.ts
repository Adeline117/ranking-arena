/**
 * POST /api/trader/by-id/:id/refresh
 *
 * Enqueues a background refresh job for this trader.
 * Does NOT trigger synchronous scraping. Returns immediately with job status.
 *
 * The :id param format is "{platform}:{trader_key}".
 *
 * Request body (optional):
 *   { priority?: 1-5 } // 1=highest, default 2 for user-triggered
 *
 * Response: RefreshResponse
 *   {
 *     job_id: "uuid",
 *     status: "pending" | "running",
 *     estimated_wait_seconds: 30,
 *     message: "Refresh job enqueued. Data will be updated shortly."
 *   }
 *
 * Rate limit: 1 refresh per trader per 5 minutes (via idempotency key).
 */

import { NextRequest, NextResponse } from 'next/server';
import { JobRunner } from '@/lib/services/job-runner';
import type { Platform, LeaderboardPlatform, RefreshResponse } from '@/lib/types/leaderboard';
import { LEADERBOARD_PLATFORMS } from '@/lib/types/leaderboard';
import { checkRateLimit, RateLimitPresets, requireAuth } from '@/lib/api'
import logger from '@/lib/logger'

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  // Rate limit: prevent abuse of refresh endpoint (writes to DB + triggers exchange API calls)
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  // Authentication required: unauthenticated users must not be able to trigger background jobs
  try {
    await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const { id } = await params;

    // Parse composite ID
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

    // Parse optional priority from body
    let priority = 2; // User-triggered = high priority
    try {
      const body = await request.json();
      if (body.priority && body.priority >= 1 && body.priority <= 5) {
        priority = body.priority;
      }
    } catch {
      // No body or invalid JSON – use default priority
    }

    const runner = new JobRunner();
    const job = await runner.enqueueFullRefresh(platform, traderKey, priority);

    if (!job) {
      return NextResponse.json(
        { error: 'Failed to enqueue refresh job' },
        { status: 500 },
      );
    }

    // Estimate wait time based on queue position
    const estimatedWait = job.status === 'running' ? 10 : 30;

    const response: RefreshResponse = {
      job_id: job.id,
      status: job.status as RefreshResponse['status'],
      estimated_wait_seconds: estimatedWait,
      message:
        job.status === 'running'
          ? 'Refresh is already in progress.'
          : 'Refresh job enqueued. Data will be updated shortly.',
    };

    return NextResponse.json(response, { status: 202 });
  } catch (error: unknown) {
    logger.error('[API /trader/by-id/:id/refresh] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
