import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredGet } from '@/lib/cache/redis-layer'
import logger from '@/lib/logger'

/**
 * GET /api/user/usage
 *
 * Returns usage statistics for the authenticated user:
 * - followedTraders: Number of traders being followed
 * - apiCallsToday: Number of API calls made today (Pro feature)
 */
export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    // Get followed traders count
    // KEEP 'exact' — drives the usage widget Pro quota progress bar
    // ("42 / 50 traders followed"). Scoped per-user via (user_id)
    // index → cheap; must be accurate for the quota display.
    const { count: followedTraders } = await supabase
      .from('trader_follows')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)

    // Get today's API calls from Redis
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const apiCallsKey = `api_calls:${user.id}:${today}`
    const { data: apiCallsData } = await tieredGet<number>(apiCallsKey, 'hot')
    const apiCallsToday = apiCallsData ?? 0

    return NextResponse.json({
      followedTraders: followedTraders ?? 0,
      apiCallsToday,
    })
  } catch (err) {
    logger.error('[User Usage] Error:', err)
    return NextResponse.json({ error: 'Failed to get usage stats' }, { status: 500 })
  }
}

// incrementApiCalls moved to lib/services/api-usage.ts
