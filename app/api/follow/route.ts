/**
 * 关注/取消关注交易员 API
 *
 * SECURITY: Both GET and POST now require authentication.
 * The userId is derived from the authenticated user's token,
 * preventing impersonation attacks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { apiLogger } from '@/lib/utils/logger'
import { getAuthUser, requireAuth, getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ following: false })
    }

    const traderId = request.nextUrl.searchParams.get('traderId')
    if (!traderId) {
      return NextResponse.json({ error: 'Missing traderId' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('trader_follows')
      .select('*')
      .eq('user_id', user.id)
      .eq('trader_id', traderId)
      .maybeSingle()

    if (error) {
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
    // Require authentication - userId comes from token, not body
    const user = await requireAuth(request)

    const body = await request.json()
    const { traderId, action } = body

    if (!traderId || !action) {
      return NextResponse.json({ error: 'Missing traderId or action' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    if (action === 'follow') {
      const { error } = await supabase
        .from('trader_follows')
        .insert({ user_id: user.id, trader_id: traderId })

      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ success: true, following: true })
        }
        if (error.message?.includes('Could not find the table')) {
          apiLogger.warn('trader_follows table not found, please run setup_trader_follows.sql')
          return NextResponse.json({ error: 'Follow feature coming soon', tableNotFound: true }, { status: 503 })
        }
        apiLogger.error('Follow error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, following: true })
    } else if (action === 'unfollow') {
      const { error } = await supabase
        .from('trader_follows')
        .delete()
        .eq('user_id', user.id)
        .eq('trader_id', traderId)

      if (error) {
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
  } catch (error: unknown) {
    if (error instanceof Error && (error as Error & { statusCode?: number }).statusCode === 401) {
      return NextResponse.json({ error: '未授权，请先登录' }, { status: 401 })
    }
    apiLogger.error('POST /api/follow error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

