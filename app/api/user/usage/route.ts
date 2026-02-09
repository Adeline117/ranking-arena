import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
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

/**
 * Increment API call count for a user.
 * Called internally by API routes that count towards the daily limit.
 */
export async function incrementApiCalls(userId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const key = `api_calls:${userId}:${today}`

  const { data: current } = await tieredGet<number>(key, 'hot')
  const newCount = (current ?? 0) + 1

  // Cache in hot tier (short TTL, frequently accessed)
  await tieredSet(key, newCount, 'hot')

  return newCount
}
