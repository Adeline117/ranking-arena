/**
 * 验证 Stripe Checkout Session 并同步订阅状态
 * 用于本地开发或 webhook 失败时的备用方案
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { env } from '@/lib/env'

// 懒加载 Stripe 客户端
function getStripe() {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
  apiVersion: '2026-03-25.dahlia',
})
}

// 从价格 ID 获取订阅等级
function getTierFromPriceId(priceId: string): 'free' | 'pro' {
  if (priceId === env.STRIPE_PRO_MONTHLY_PRICE_ID ||
      priceId === env.STRIPE_PRO_YEARLY_PRICE_ID ||
      priceId === process.env.STRIPE_PRO_LIFETIME_PRICE_ID ||
      priceId === process.env.STRIPE_PRO_PRICE_ID) {
    return 'pro'
  }
  return 'free'
}

const logger = createLogger('stripe-verify-session')

export async function POST(request: NextRequest) {
  try {
    // 速率限制检查（金融操作使用 sensitive 预设：15次/分钟）
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
    if (rateLimitResponse) {
      logger.warn('Rate limit exceeded for stripe/verify-session')
      return rateLimitResponse
    }

    // Verify authenticated user
    const authUser = await getAuthUser(request)
    if (!authUser) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const { sessionId } = await request.json()

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session ID' }, { status: 400 })
    }

    const stripe = getStripe()
    const supabaseAdmin = getSupabaseAdmin()

    // 获取 Checkout Session（不展开 subscription，避免类型问题）
    const session = await stripe.checkout.sessions.retrieve(sessionId)

    if (session.payment_status !== 'paid') {
      return NextResponse.json({
        error: 'Payment not completed',
        paymentStatus: session.payment_status
      }, { status: 400 })
    }

    const userId = session.metadata?.supabase_user_id || session.metadata?.userId
    const customerId = session.customer as string
    const plan = session.metadata?.plan

    if (!userId) {
      return NextResponse.json({ error: 'User ID not found in session' }, { status: 400 })
    }

    // Verify the session belongs to the authenticated user
    if (userId !== authUser.id) {
      logger.warn('Session user mismatch', { sessionUserId: userId, authUserId: authUser.id })
      return NextResponse.json({ error: 'Session does not belong to current user' }, { status: 403 })
    }

    // Lifetime one-time payment (mode=payment)
    if (session.mode === 'payment' && plan === 'lifetime') {
      const { error: subError } = await supabaseAdmin
        .from('subscriptions')
        .upsert({
          user_id: userId,
          stripe_customer_id: customerId,
          stripe_subscription_id: `lifetime_${userId}`,
          status: 'active',
          tier: 'pro',
          plan: 'lifetime',
          current_period_start: new Date().toISOString(),
          current_period_end: null,
          cancel_at_period_end: false,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      if (subError) {
        logger.error('Failed to update subscriptions for lifetime', { error: subError, userId })
      }

      const { error: profileError } = await supabaseAdmin
        .from('user_profiles')
        .update({
          subscription_tier: 'pro',
          pro_plan: 'lifetime',
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId)

      if (profileError) {
        logger.error('Failed to update user_profiles for lifetime', { error: profileError, userId })
        return NextResponse.json({ error: 'Failed to update user profile' }, { status: 500 })
      }

      logger.info('Lifetime payment verified', { userId })
      return NextResponse.json({
        success: true,
        tier: 'pro' as const,
        status: 'active',
        plan: 'lifetime',
      })
    }

    // Subscription mode (monthly/yearly)
    if (session.mode !== 'subscription') {
      return NextResponse.json({
        error: 'Session is not a subscription',
        mode: session.mode
      }, { status: 400 })
    }

    // session.subscription 在未 expand 时始终是 string | null
    const subscriptionId = session.subscription as string | null

    if (!subscriptionId) {
      return NextResponse.json({ error: 'Subscription ID not found in session' }, { status: 400 })
    }

    // 获取订阅详情
    let tier: 'free' | 'pro' = 'pro'
    let periodStart: string | null = null
    let periodEnd: string | null = null
    let subscriptionStatus = 'active'

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      const priceId = subscription.items.data[0]?.price.id || ''
      tier = getTierFromPriceId(priceId)
      subscriptionStatus = subscription.status

      // 检查订阅状态
      if (subscription.status !== 'active' && subscription.status !== 'trialing') {
        return NextResponse.json({
          error: 'Subscription is not active',
          status: subscription.status
        }, { status: 400 })
      }

      // 获取周期信息（兼容不同 Stripe API 版本）
      const sub = subscription as unknown as Record<string, unknown>
      const itemPeriod = subscription.items?.data?.[0] as unknown as Record<string, unknown> | undefined
      const pStart = (sub.current_period_start ?? itemPeriod?.current_period_start) as number | undefined
      const pEnd = (sub.current_period_end ?? itemPeriod?.current_period_end) as number | undefined
      if (pStart) {
        periodStart = new Date(pStart * 1000).toISOString()
      }
      if (pEnd) {
        periodEnd = new Date(pEnd * 1000).toISOString()
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      logger.error('Failed to retrieve subscription', { error: errorMessage, subscriptionId })
      return NextResponse.json({
        error: 'Failed to retrieve subscription',
        details: 'Payment verification failed'
      }, { status: 500 })
    }

    // 更新订阅记录
    const { error: subscriptionError } = await supabaseAdmin
      .from('subscriptions')
      .upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        tier,
        status: subscriptionStatus,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      })

    if (subscriptionError) {
      logger.error('Failed to update subscriptions table', { error: subscriptionError, userId })
    } else {
      logger.info('Updated subscriptions table', { userId })
    }

    // 同时更新 user_profiles 的 subscription_tier
    const { error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .upsert({
        id: userId,
        subscription_tier: tier,
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'id',
      })

    if (profileError) {
      logger.error('Failed to update user_profiles', { error: profileError, userId })
      return NextResponse.json({ error: 'Failed to update user profile' }, { status: 500 })
    }

    logger.info('Updated subscription', { userId, tier })

    return NextResponse.json({
      success: true,
      tier,
      status: subscriptionStatus,
      subscriptionId,
    })

  } catch (error: unknown) {
    logger.error('Verify session error', { error })
    const message = error instanceof Error ? error.message : ''
    if (message.includes('STRIPE_SECRET_KEY') || message.includes('not configured')) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: 'Failed to verify session' }, { status: 500 })
  }
}
