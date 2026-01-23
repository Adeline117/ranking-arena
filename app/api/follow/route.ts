/**
 * 关注/取消关注交易员 API
 *
 * SECURITY: All write operations require authentication and verify
 * that the userId matches the authenticated user to prevent impersonation.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { apiLogger } from '@/lib/utils/logger'
import { getAuthUser } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const userId = searchParams.get('userId')
    const traderId = searchParams.get('traderId')

    if (!userId || !traderId) {
      return NextResponse.json({ error: 'Missing userId or traderId' }, { status: 400 })
    }

    // SECURITY: Verify that the requesting user can only check their own follow status
    const authUser = await getAuthUser(request)
    if (authUser && authUser.id !== userId) {
      apiLogger.warn('User attempted to check follow status for another user', {
        authUserId: authUser.id,
        requestedUserId: userId
      })
      return NextResponse.json({ error: 'Unauthorized: Cannot check follow status for other users' }, { status: 403 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    const { data, error } = await supabase
      .from('trader_follows')
      .select('*')
      .eq('user_id', userId)
      .eq('trader_id', traderId)
      .maybeSingle()

    if (error) {
      // 如果表不存在，返回未关注状态
      if (error.message?.includes('Could not find the table')) {
        apiLogger.warn('trader_follows table not found, please run setup_trader_follows.sql')
        return NextResponse.json({ following: false, tableNotFound: true })
      }
      apiLogger.error('Query error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ following: !!data })
  } catch (error) {
    apiLogger.error('GET /api/follow error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    // SECURITY: Require authentication
    const authUser = await getAuthUser(request)
    if (!authUser) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const body = await request.json()
    const { userId, traderId, action } = body

    if (!userId || !traderId || !action) {
      return NextResponse.json({ error: 'Missing userId, traderId or action' }, { status: 400 })
    }

    // SECURITY: Verify that userId matches the authenticated user
    // This prevents users from following/unfollowing on behalf of others
    if (userId !== authUser.id) {
      apiLogger.warn('User attempted to follow/unfollow for another user', {
        authUserId: authUser.id,
        requestedUserId: userId,
        traderId,
        action
      })
      return NextResponse.json({ error: 'Unauthorized: Cannot perform follow actions for other users' }, { status: 403 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

    if (action === 'follow') {
      // 关注
      const { error } = await supabase
        .from('trader_follows')
        .insert({ user_id: userId, trader_id: traderId })

      if (error) {
        // 如果是重复关注，忽略错误
        if (error.code === '23505') {
          return NextResponse.json({ success: true, following: true })
        }
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          apiLogger.warn('trader_follows table not found, please run setup_trader_follows.sql')
          return NextResponse.json({ error: 'Follow feature coming soon', tableNotFound: true }, { status: 503 })
        }
        apiLogger.error('Follow error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, following: true })
    } else if (action === 'unfollow') {
      // 取消关注
      const { error } = await supabase
        .from('trader_follows')
        .delete()
        .eq('user_id', userId)
        .eq('trader_id', traderId)

      if (error) {
        // 如果表不存在
        if (error.message?.includes('Could not find the table')) {
          apiLogger.warn('trader_follows table not found, please run setup_trader_follows.sql')
          return NextResponse.json({ error: 'Follow feature coming soon', tableNotFound: true }, { status: 503 })
        }
        apiLogger.error('Unfollow error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, following: false })
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error) {
    apiLogger.error('POST /api/follow error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

