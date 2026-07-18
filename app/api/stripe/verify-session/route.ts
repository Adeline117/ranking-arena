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
import {
  activateLifetimeCheckoutEntitlement,
  lifetimeActivationGranted,
} from '@/lib/stripe/lifetime-entitlement'

// 懒加载 Stripe 客户端
function getStripe() {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
    apiVersion: '2026-04-22.dahlia',
  })
}

// 从价格 ID 获取订阅等级
function getPlanFromPriceId(priceId: string): 'monthly' | 'yearly' | null {
  if (priceId && priceId === env.STRIPE_PRO_MONTHLY_PRICE_ID) return 'monthly'
  if (priceId && priceId === env.STRIPE_PRO_YEARLY_PRICE_ID) return 'yearly'
  if (priceId && priceId === process.env.STRIPE_PRO_PRICE_ID) return 'monthly'
  return null
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

    let sessionId: string
    try {
      const body = await request.json()
      sessionId = body.sessionId
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
        { status: 400 }
      )
    }

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session ID' }, { status: 400 })
    }

    const stripe = getStripe()
    const supabaseAdmin = getSupabaseAdmin()

    // 获取 Checkout Session（不展开 subscription，避免类型问题）
    const session = await stripe.checkout.sessions.retrieve(sessionId)

    const acceptablePaymentStatus =
      session.payment_status === 'paid' ||
      (session.mode === 'subscription' && session.payment_status === 'no_payment_required')
    if (!acceptablePaymentStatus) {
      return NextResponse.json(
        {
          error: 'Payment not completed',
          paymentStatus: session.payment_status,
        },
        { status: 400 }
      )
    }

    // 2026-07-11 修:paid 不代表没退款——重放已退款的 session 可重授 Pro
    // (退款白嫖第二入口)。mode=payment 时核对 charge 退款态;查不到时
    // The refund check is part of the authorization decision. If Stripe is
    // unavailable, fail closed and let the client retry; never re-grant a
    // refunded lifetime purchase because a safety lookup timed out.
    if (session.mode === 'payment' && session.payment_intent) {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent.id,
          { expand: ['latest_charge'] }
        )
        const latestCharge = pi.latest_charge as import('stripe').Stripe.Charge | null
        if (latestCharge && (latestCharge.refunded || (latestCharge.amount_refunded ?? 0) > 0)) {
          logger.warn('verify-session replay on refunded charge — denied', {
            sessionId,
            chargeId: latestCharge.id,
          })
          return NextResponse.json({ error: 'Payment was refunded' }, { status: 400 })
        }
      } catch (refundCheckErr) {
        logger.error('verify-session refund check failed (fail-closed)', {
          sessionId,
          error: refundCheckErr instanceof Error ? refundCheckErr.message : refundCheckErr,
        })
        return NextResponse.json(
          { error: 'Unable to verify payment safety. Please retry.' },
          { status: 503 }
        )
      }
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
      return NextResponse.json(
        { error: 'Session does not belong to current user' },
        { status: 403 }
      )
    }

    // Lifetime one-time payment (mode=payment)
    if (session.mode === 'payment' && plan === 'lifetime') {
      const outcome = await activateLifetimeCheckoutEntitlement({
        stripe,
        supabase: supabaseAdmin,
        session,
        expectedUserId: authUser.id,
      })
      if (!lifetimeActivationGranted(outcome.status)) {
        logger.warn('Lifetime verification reached a safe non-grant terminal state', {
          userId,
          sessionId,
          status: outcome.status,
          reviewCode: outcome.reviewCode,
        })
        if (outcome.status === 'refunded_payment') {
          return NextResponse.json({ error: 'Payment was refunded' }, { status: 400 })
        }
        return NextResponse.json(
          {
            error: 'Payment requires review before membership can be activated.',
            code: 'LIFETIME_ACTIVATION_REVIEW',
          },
          { status: 409 }
        )
      }

      logger.info('Exact lifetime payment verified', { userId, status: outcome.status })
      return NextResponse.json({
        success: true,
        tier: 'pro' as const,
        status: 'active',
        plan: 'lifetime',
      })
    }

    // Subscription mode (monthly/yearly)
    if (session.mode !== 'subscription') {
      return NextResponse.json(
        {
          error: 'Session is not a subscription',
          mode: session.mode,
        },
        { status: 400 }
      )
    }

    // session.subscription 在未 expand 时始终是 string | null
    const subscriptionId = session.subscription as string | null

    if (!subscriptionId) {
      return NextResponse.json({ error: 'Subscription ID not found in session' }, { status: 400 })
    }

    // 获取订阅详情
    const tier = 'pro' as const
    let verifiedPlan: 'monthly' | 'yearly' | null = null
    let periodStart: string | null = null
    let periodEnd: string | null = null
    let subscriptionStatus = 'active'
    let cancelAtPeriodEnd = false

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      const priceId = subscription.items.data[0]?.price.id || ''
      verifiedPlan = getPlanFromPriceId(priceId)
      if (!verifiedPlan) {
        logger.error('verify-session encountered unknown Stripe price', {
          subscriptionId,
          priceId,
        })
        return NextResponse.json(
          { error: 'Unknown payment configuration. Please contact support.' },
          { status: 500 }
        )
      }
      subscriptionStatus = subscription.status
      cancelAtPeriodEnd = subscription.cancel_at_period_end

      // 检查订阅状态
      if (subscription.status !== 'active' && subscription.status !== 'trialing') {
        return NextResponse.json(
          {
            error: 'Subscription is not active',
            status: subscription.status,
          },
          { status: 400 }
        )
      }

      // Stripe API 2026-04-22 exposes billing periods on subscription items.
      const itemPeriod = subscription.items.data[0]
      const pStart = itemPeriod?.current_period_start
      const pEnd = itemPeriod?.current_period_end
      if (pStart) {
        periodStart = new Date(pStart * 1000).toISOString()
      }
      if (pEnd) {
        periodEnd = new Date(pEnd * 1000).toISOString()
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      logger.error('Failed to retrieve subscription', { error: errorMessage, subscriptionId })
      return NextResponse.json(
        {
          error: 'Failed to retrieve subscription',
          details: 'Payment verification failed',
        },
        { status: 500 }
      )
    }

    if (!periodStart || !periodEnd || !verifiedPlan) {
      logger.error('Active Stripe subscription is missing billing contract fields', {
        subscriptionId,
        hasPeriodStart: !!periodStart,
        hasPeriodEnd: !!periodEnd,
        verifiedPlan,
      })
      return NextResponse.json(
        { error: 'Incomplete subscription data. Please retry.' },
        { status: 503 }
      )
    }

    const { error: syncError } = await supabaseAdmin.rpc('update_subscription_and_profile', {
      p_user_id: userId,
      p_tier: tier,
      p_status: subscriptionStatus,
      p_stripe_sub_id: subscriptionId,
      p_stripe_customer_id: customerId,
      p_plan: verifiedPlan,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_cancel_at_period_end: cancelAtPeriodEnd,
    })

    if (syncError) {
      logger.error('Atomic subscription verification sync failed', { error: syncError, userId })
      return NextResponse.json({ error: 'Failed to activate subscription' }, { status: 500 })
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
