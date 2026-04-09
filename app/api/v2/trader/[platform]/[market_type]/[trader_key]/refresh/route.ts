/**
 * POST /api/v2/trader/:platform/:market_type/:trader_key/refresh
 *
 * Request a refresh of trader data.
 * Creates a job in the queue - does NOT fetch synchronously.
 *
 * Response:
 *   - job_id: string
 *   - status: 'pending' | 'already_queued'
 *   - estimated_wait_seconds: number | null
 *   - message: string
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { LeaderboardPlatform, MarketType, Window, RefreshResponse } from '@/lib/types/leaderboard'
import { LEADERBOARD_PLATFORMS } from '@/lib/types/leaderboard'
import { createRefreshJob } from '@/lib/jobs/processor'
import { checkRateLimit, RateLimitPresets, requireAuth } from '@/lib/api'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface RouteParams {
  params: Promise<{
    platform: string
    market_type: string
    trader_key: string
  }>
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
  const { platform, market_type, trader_key } = await params

  // Validate platform
  if (!LEADERBOARD_PLATFORMS.includes(platform as LeaderboardPlatform)) {
    return NextResponse.json(
      { error: `Invalid platform: ${platform}` },
      { status: 400 }
    )
  }

  // Rate limit: max 1 refresh per trader per 2 minutes
  const supabase = getSupabaseAdmin()

  // Check for existing recent job
  const twoMinutesAgo = new Date(Date.now() - 120000).toISOString()
  const { data: existingJobs } = await supabase
    .from('refresh_jobs')
    .select('id, status, created_at')
    .eq('platform', platform)
    .eq('market_type', market_type)
    .eq('trader_key', trader_key)
    .in('status', ['pending', 'running'])
    .gte('created_at', twoMinutesAgo)
    .limit(1)

  if (existingJobs && existingJobs.length > 0) {
    const response: RefreshResponse = {
      job_id: existingJobs[0].id,
      status: 'pending',
      estimated_wait_seconds: 30,
      message: 'Refresh already queued. Please wait for completion.',
    }
    return NextResponse.json(response, { status: 200 })
  }

  // Check queue depth for backpressure
  // Estimated — this is a backpressure threshold (>1000 → reject) and
  // estimated_wait minute display, neither of which needs an exact tally.
  const { count: queueDepth } = await supabase
    .from('refresh_jobs')
    .select('id', { count: 'estimated', head: true })
    .eq('status', 'pending')

  const estimatedWait = queueDepth ? Math.min(queueDepth * 5, 300) : 30  // 5s per job, max 5min

  if ((queueDepth || 0) > 1000) {
    return NextResponse.json(
      {
        error: 'System busy. Please try again later.',
        queue_depth: queueDepth,
        estimated_wait_seconds: estimatedWait,
      },
      { status: 429 }
    )
  }

  // Create refresh jobs for all windows
  const windows: Window[] = ['7d', '30d', '90d']
  const jobIds: string[] = []

  for (const window of windows) {
    const id = await createRefreshJob({
      jobType: 'SNAPSHOT_REFRESH',
      platform: platform as LeaderboardPlatform,
      marketType: market_type as MarketType,
      traderKey: trader_key,
      window,
      priority: 10, // USER_TRIGGERED = highest priority
    })
    if (id) jobIds.push(id)
  }

  // Also create profile enrich job
  await createRefreshJob({
    jobType: 'PROFILE_ENRICH',
    platform: platform as LeaderboardPlatform,
    marketType: market_type as MarketType,
    traderKey: trader_key,
    priority: 10,
  })

  const response: RefreshResponse = {
    job_id: jobIds[0] || '',
    status: 'pending',
    estimated_wait_seconds: estimatedWait,
    message: `Refresh queued. ${jobIds.length} jobs created. Estimated wait: ${estimatedWait}s.`,
  }

  return NextResponse.json(response, { status: 202 })
  } catch (error) {
    logger.error('[v2-trader-refresh] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
