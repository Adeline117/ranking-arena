/**
 * 订阅状态查询 API
 * 获取当前用户的订阅信息
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { UserSubscription } from '@/lib/premium'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

const logger = createLogger('subscription-api')

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

    // 查询订阅信息 - 优先检查 subscriptions 表
    const { data: subscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .select('user_id, tier, status, created_at, current_period_start, current_period_end, stripe_subscription_id, api_calls_today, comparison_reports_this_month, exports_this_month')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .maybeSingle()

    if (subscriptionError) {
      logger.warn('Query error', { error: subscriptionError, userId: user.id })
    }

    // 统计用户关注的交易员数量
    const { count: followsCount } = await supabase
      .from('trader_follows')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)

    const currentFollows = followsCount || 0
    // custom_rankings 表尚未创建，暂时返回 0
    const currentCustomRankings = 0

    // 如果没有活跃订阅记录，检查 user_profiles 作为备用
    let tier: 'free' | 'pro' = 'free'
    if (!subscription) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('subscription_tier')
        .eq('id', user.id)
        .maybeSingle()
      
      // 如果 user_profiles 显示是 pro，但 subscriptions 表没有记录，可能是 webhook 延迟
      // 这种情况下返回 pro，但标记为需要同步
      if (profile?.subscription_tier === 'pro') {
        tier = 'pro'
        logger.warn('User has pro tier in profile but no active subscription record', { userId: user.id })
      }
    } else {
      tier = subscription.tier as 'free' | 'pro'
    }

    // 如果没有订阅记录或不是 pro，返回免费版默认值
    if (!subscription && tier === 'free') {
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

    // 转换为 UserSubscription 格式 (subscription is non-null here — early return above)
    const sub = subscription!
    const userSubscription: UserSubscription = {
      userId: sub.user_id,
      tier: sub.tier || tier,
      status: sub.status,
      startDate: sub.created_at || sub.current_period_start || new Date().toISOString(),
      endDate: sub.current_period_end,
      trialEndDate: null,
      autoRenew: sub.status === 'active',
      paymentMethod: sub.stripe_subscription_id ? 'stripe' : undefined,
      usage: {
        apiCallsToday: sub.api_calls_today || 0,
        comparisonReportsThisMonth: sub.comparison_reports_this_month || 0,
        exportsThisMonth: sub.exports_this_month || 0,
        currentFollows,
        currentCustomRankings,
      },
    }

    return NextResponse.json({ subscription: userSubscription })
  } catch (error: unknown) {
    logger.error('Subscription API error', { error })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
