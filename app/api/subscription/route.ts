/**
 * 订阅状态查询 API
 * 获取当前用户的订阅信息
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { UserSubscription } from '@/lib/premium'

export const dynamic = 'force-dynamic'

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !serviceKey) {
    throw new Error('Supabase credentials not configured')
  }
  
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

export async function GET(request: NextRequest) {
  try {
    const supabase = getSupabase()
    
    // 获取当前用户
    const authHeader = request.headers.get('authorization')
    
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const token = authHeader.substring(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Invalid token' },
        { status: 401 }
      )
    }

    // 查询订阅信息
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) {
      console.error('[Subscription API] Query error:', error)
      return NextResponse.json(
        { error: 'Failed to fetch subscription' },
        { status: 500 }
      )
    }

    // 统计用户关注的交易员数量
    const { count: followsCount } = await supabase
      .from('trader_follows')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)

    const currentFollows = followsCount || 0
    // custom_rankings 表尚未创建，暂时返回 0
    const currentCustomRankings = 0

    // 如果没有订阅记录，返回免费版默认值
    if (!subscription) {
      const defaultSubscription: UserSubscription = {
        userId: user.id,
        tier: 'free',
        status: 'active',
        startDate: new Date().toISOString(),
        endDate: null,
        trialEndDate: null,
        autoRenew: false,
        usage: {
          apiCallsToday: 0,
          comparisonReportsThisMonth: 0,
          exportsThisMonth: 0,
          currentFollows,
          currentCustomRankings,
        },
      }

      return NextResponse.json({ subscription: defaultSubscription })
    }

    // 转换为 UserSubscription 格式
    const userSubscription: UserSubscription = {
      userId: subscription.user_id,
      tier: subscription.tier,
      status: subscription.status,
      startDate: subscription.created_at,
      endDate: subscription.current_period_end,
      trialEndDate: null,
      autoRenew: subscription.status === 'active',
      paymentMethod: subscription.stripe_subscription_id ? 'stripe' : undefined,
      usage: {
        apiCallsToday: subscription.api_calls_today || 0,
        comparisonReportsThisMonth: subscription.comparison_reports_this_month || 0,
        exportsThisMonth: subscription.exports_this_month || 0,
        currentFollows,
        currentCustomRankings,
      },
    }

    return NextResponse.json({ subscription: userSubscription })
  } catch (error) {
    console.error('[Subscription API] Error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
