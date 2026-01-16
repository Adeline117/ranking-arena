/**
 * 关注/取消关注交易员 API
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { apiLogger } from '@/lib/utils/logger'

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
        apiLogger.warn('trader_follows 表不存在，请运行 setup_trader_follows.sql')
        return NextResponse.json({ following: false, tableNotFound: true })
      }
      apiLogger.error('查询错误:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ following: !!data })
  } catch (error) {
    apiLogger.error('错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { userId, traderId, action } = body

    if (!userId || !traderId || !action) {
      return NextResponse.json({ error: 'Missing userId, traderId or action' }, { status: 400 })
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
          apiLogger.warn('trader_follows 表不存在，请运行 setup_trader_follows.sql')
          return NextResponse.json({ error: '关注功能暂未开放', tableNotFound: true }, { status: 503 })
        }
        apiLogger.error('关注错误:', error)
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
          apiLogger.warn('trader_follows 表不存在，请运行 setup_trader_follows.sql')
          return NextResponse.json({ error: '关注功能暂未开放', tableNotFound: true }, { status: 503 })
        }
        apiLogger.error('取消关注错误:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, following: false })
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error) {
    apiLogger.error('错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

