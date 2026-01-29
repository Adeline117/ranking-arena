/**
 * 验证 Stripe Checkout Session 并同步订阅状态
 * 用于本地开发或 webhook 失败时的备用方案
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

// 懒加载 Stripe 客户端
function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
  apiVersion: '2025-12-15.clover',
})
}

// 懒加载 Supabase Admin 客户端
function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Supabase credentials not configured')
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

// 从价格 ID 获取订阅等级
function getTierFromPriceId(priceId: string): 'free' | 'pro' {
  if (priceId === process.env.STRIPE_PRO_MONTHLY_PRICE_ID || 
      priceId === process.env.STRIPE_PRO_YEARLY_PRICE_ID ||
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

    // 检查是否为订阅模式
    if (session.mode !== 'subscription') {
      return NextResponse.json({
        error: 'Session is not a subscription',
        mode: session.mode
      }, { status: 400 })
    }

    const userId = session.metadata?.supabase_user_id || session.metadata?.userId
    const customerId = session.customer as string
    // session.subscription 在未 expand 时始终是 string | null
    const subscriptionId = session.subscription as string | null

    if (!userId) {
      return NextResponse.json({ error: 'User ID not found in session' }, { status: 400 })
    }

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
        details: errorMessage
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
      // 继续执行，因为 user_profiles 更新可能成功
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
