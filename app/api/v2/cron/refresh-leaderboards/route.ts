/**
 * GET /api/v2/cron/refresh-leaderboards
 *
 * Cron endpoint for Vercel cron jobs.
 * Triggers scheduled discovery and preheat jobs.
 *
 * Called by Vercel cron (see vercel.json):
 *   - Every 15 minutes: preheat top N
 *   - Every hour: discovery
 *
 * Query params:
 *   action: 'discover' | 'preheat' | 'long_tail' | 'all' (default: 'all')
 *   platform: specific platform (optional)
 *
 * Security: Requires CRON_SECRET header for Vercel cron.
 */

import { NextRequest, NextResponse } from 'next/server'
import { scheduleDiscovery, schedulePreheat, scheduleLongTailRefresh, getQueueStats } from '@/lib/jobs/scheduler'
import type { LeaderboardPlatform, MarketType } from '@/lib/types/leaderboard'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel cron sends this automatically)
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'all'
  const platform = searchParams.get('platform') as LeaderboardPlatform | null

  const results: Record<string, number | unknown> = {}

  try {
    switch (action) {
      case 'discover':
        results.discovery_jobs = await scheduleDiscovery()
        break

      case 'preheat':
        results.preheat_jobs = await schedulePreheat(500)
        break

      case 'long_tail':
        if (platform) {
          const marketType = (searchParams.get('market_type') || 'futures') as MarketType
          results.long_tail_jobs = await scheduleLongTailRefresh(platform, marketType, 100)
        } else {
          results.error = 'platform required for long_tail action'
        }
        break

      case 'all':
        results.discovery_jobs = await scheduleDiscovery()
        results.preheat_jobs = await schedulePreheat(500)
        break

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Use: discover, preheat, long_tail, all` },
          { status: 400 }
        )
    }

    // Get queue stats
    results.queue_stats = await getQueueStats()

    return NextResponse.json({
      success: true,
      action,
      results,
      timestamp: new Date().toISOString(),
    })

  } catch (error: unknown) {
    logger.error('[Cron] Error:', error)
    return NextResponse.json(
      { error: 'Cron execution failed', details: String(error) },
      { status: 500 }
    )
  }
}
