/**
 * 订阅状态查询 API
 * 获取当前用户的订阅信息
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserSubscription } from '@/lib/premium'
import { createLogger } from '@/lib/utils/logger'
import { getCanonicalSubscriptionTier } from '@/lib/premium/server-entitlement'
import type { Database } from '@/lib/supabase/database.types'

export const dynamic = 'force-dynamic'

const logger = createLogger('subscription-api')

const SUBSCRIPTION_KEYS = [
  'user_id',
  'tier',
  'status',
  'plan',
  'created_at',
  'current_period_start',
  'current_period_end',
  'cancel_at_period_end',
  'stripe_subscription_id',
  'api_calls_today',
  'comparison_reports_this_month',
  'exports_this_month',
] as const

type ActiveSubscriptionRow = Record<(typeof SUBSCRIPTION_KEYS)[number], unknown>

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isDateOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function isUsageCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseActiveSubscription(value: unknown, userId: string): ActiveSubscriptionRow | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Subscription lookup returned an invalid row')
  }

  const row = value as Record<string, unknown>
  if (
    !hasExactKeys(row, SUBSCRIPTION_KEYS) ||
    row.user_id !== userId ||
    !['free', 'pro', 'elite'].includes(String(row.tier)) ||
    (row.status !== 'active' && row.status !== 'trialing') ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    !isDateOrNull(row.current_period_start) ||
    !isDateOrNull(row.current_period_end) ||
    typeof row.cancel_at_period_end !== 'boolean' ||
    (row.plan !== null && (typeof row.plan !== 'string' || row.plan.trim().length === 0)) ||
    (row.stripe_subscription_id !== null &&
      (typeof row.stripe_subscription_id !== 'string' ||
        !/^sub_[A-Za-z0-9]+$/.test(row.stripe_subscription_id))) ||
    !isUsageCount(row.api_calls_today) ||
    !isUsageCount(row.comparison_reports_this_month) ||
    !isUsageCount(row.exports_this_month)
  ) {
    throw new Error('Subscription lookup returned an inconsistent row')
  }

  return row as ActiveSubscriptionRow
}

function unavailable(error: unknown, userId: string): NextResponse {
  logger.error('Unable to verify subscription state', { error, userId })
  return NextResponse.json(
    { success: false, error: 'Unable to verify subscription status. Please retry.' },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
  )
}

function subscriptionResponse(subscription: UserSubscription, tier: 'free' | 'pro'): NextResponse {
  const response = NextResponse.json({ subscription })
  response.headers.set(
    'Set-Cookie',
    `arena_tier=${tier}; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`
  )
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export const GET = withAuth(
  async ({ user, supabase: sb }) => {
    const supabase: SupabaseClient<Database> = sb

    let subResult
    let followsResult
    let tier: 'free' | 'pro'
    try {
      ;[subResult, followsResult, tier] = await Promise.all([
        supabase
          .from('subscriptions')
          .select(SUBSCRIPTION_KEYS.join(', '))
          .eq('user_id', user.id)
          .in('status', ['active', 'trialing'])
          .order('created_at', { ascending: false })
          .limit(2)
          .maybeSingle(),
        // KEEP 'exact' — this count participates in the user's follow limit.
        supabase
          .from('trader_follows')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', user.id),
        getCanonicalSubscriptionTier(supabase, user.id),
      ])
    } catch (error) {
      return unavailable(error, user.id)
    }

    if (subResult.error || followsResult.error) {
      return unavailable(subResult.error ?? followsResult.error, user.id)
    }
    if (!isUsageCount(followsResult.count)) {
      return unavailable(new Error('Follow count lookup returned an invalid count'), user.id)
    }

    let subscription: ActiveSubscriptionRow | null
    try {
      subscription = parseActiveSubscription(subResult.data, user.id)
    } catch (error) {
      return unavailable(error, user.id)
    }

    const currentFollows = followsResult.count
    const currentCustomRankings = 0

    if (!subscription) {
      const defaultSubscription: UserSubscription = {
        userId: user.id,
        tier,
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
      return subscriptionResponse(defaultSubscription, tier)
    }

    const normalizedRowTier =
      subscription.tier === 'pro' || subscription.tier === 'elite' ? 'pro' : 'free'
    if (normalizedRowTier !== tier) {
      return unavailable(new Error('Subscription projection disagrees with entitlement'), user.id)
    }

    const sub = subscription
    const userSubscription: UserSubscription = {
      userId: sub.user_id as string,
      tier,
      status: sub.status as 'active' | 'trialing',
      startDate: sub.created_at as string,
      endDate: sub.current_period_end as string | null,
      trialEndDate: null,
      autoRenew: sub.status === 'active' && !sub.cancel_at_period_end,
      paymentMethod: sub.stripe_subscription_id ? 'stripe' : undefined,
      usage: {
        apiCallsToday: sub.api_calls_today as number,
        comparisonReportsThisMonth: sub.comparison_reports_this_month as number,
        exportsThisMonth: sub.exports_this_month as number,
        currentFollows,
        currentCustomRankings,
      },
    }

    // Include additional fields needed by the membership UI
    const res = NextResponse.json({
      subscription: {
        ...userSubscription,
        plan: (sub.plan as string | null) || undefined,
        currentPeriodEnd: (sub.current_period_end as string | null) || undefined,
        cancelAtPeriodEnd: sub.cancel_at_period_end as boolean,
      },
    })
    res.headers.set('Set-Cookie', `arena_tier=${tier}; Path=/; SameSite=Lax; Max-Age=${30 * 86400}`)
    res.headers.set('Cache-Control', 'private, no-store')
    return res
  },
  { name: 'subscription', rateLimit: 'authenticated' }
)
