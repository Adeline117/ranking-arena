/**
 * 订阅状态���询 API
 * 获取当前用户的订阅信息
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserSubscription } from '@/lib/premium'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'

const logger = createLogger('subscription-api')

export const GET = withAuth(async ({ user, supabase: sb }) => {
  const supabase = sb as SupabaseClient

  // 查询订阅信息 + 关注数并行
  const [subResult, followsResult] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('user_id, tier, status, created_at, current_period_start, current_period_end, stripe_subscription_id, api_calls_today, comparison_reports_this_month, exports_this_month')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .maybeSingle(),
    // KEEP 'exact' — this count is compared against the user's Pro
    // tier follow limit (billing enforcement). Scoped to one user
    // via (user_id) index -> cheap. Must be accurate to block the
    // (limit+1)th follow attempt.
    supabase
      .from('trader_follows')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
  ])

  const subscription = subResult.data
  if (subResult.error) {
    logger.warn('Query error', { error: subResult.error, userId: user.id })
  }

  const currentFollows = followsResult.count || 0
  const currentCustomRankings = 0

  // 确定 tier
  let tier: 'free' | 'pro' = 'free'
  if (!subscription) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('subscription_tier')
      .eq('id', user.id)
      .maybeSingle()

    if (profile?.subscription_tier === 'pro') {
      tier = 'pro'
      logger.warn('User has pro tier in profile but no active subscription record', { userId: user.id })
    }
  } else {
    tier = subscription.tier as 'free' | 'pro'
  }

  // 免费用户默认值
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
}, { name: 'subscription', rateLimit: 'authenticated' })
