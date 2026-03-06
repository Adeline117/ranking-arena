/**
 * Cron: Refresh Leaderboard Cache
 * 
 * Pre-computes leaderboard data for all periods and stores in Redis.
 * Schedule: every 5 minutes (add to vercel.json or batch-5min dispatcher)
 * 
 * This eliminates Supabase queries on the hot path, reducing TTFB from ~1.88s to <500ms.
 */

import { NextRequest, NextResponse } from 'next/server'
import { fetchLeaderboardFromDB } from '@/lib/getInitialTraders'
import { setCachedLeaderboard } from '@/lib/cache/leaderboard-cache'
import type { Period } from '@/lib/utils/arena-score'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PERIODS: Period[] = ['90D', '30D', '7D']
// Cache 50 traders (page uses 25, but cache extra for flexibility)
const CACHE_LIMIT = 50

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // Allow unauthenticated in dev, require secret in production
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const results: Record<string, { traders: number; durationMs: number; error?: string }> = {}

  for (const period of PERIODS) {
    const periodStart = Date.now()
    try {
      const { traders, lastUpdated } = await fetchLeaderboardFromDB(period, CACHE_LIMIT)
      await setCachedLeaderboard(period, traders, lastUpdated)
      results[period] = { traders: traders.length, durationMs: Date.now() - periodStart }
    } catch (err) {
      results[period] = {
        traders: 0,
        durationMs: Date.now() - periodStart,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  return NextResponse.json({
    ok: true,
    totalDurationMs: Date.now() - start,
    periods: results,
  })
}
