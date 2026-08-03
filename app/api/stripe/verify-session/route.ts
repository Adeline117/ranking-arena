/**
 * 验证 Stripe Checkout Session 并同步订阅投影。
 *
 * Checkout/Subscription 对象本身不是 recurring 付款证明：退款后原 Session
 * 仍然是 paid，Subscription 也可以继续保持 active。recurring 路径因此只会
 * 确认 webhook 已持久化的 exact payment/trial authority，绝不从 Stripe
 * Subscription 直接铸造本地权益。
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
import { STRIPE_API_VERSION } from '@/lib/stripe/version'
import {
  BILLING_SURFACE_UNAVAILABLE_MESSAGE,
  assertUserStripeBillingSurfaceAccess,
} from '@/lib/stripe/billing-surface-access'

// 懒加载 Stripe 客户端
function getStripe() {
  const secretKey = env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
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

function timestampMatches(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

function recurringAuthorityPending() {
  return NextResponse.json(
    {
      error: 'Payment confirmation is still processing or is no longer eligible.',
      code: 'RECURRING_ENTITLEMENT_NOT_READY',
    },
    { status: 409 }
  )
}

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

    try {
      await assertUserStripeBillingSurfaceAccess(authUser.id)
    } catch (error) {
      logger.error('Checkout verification billing surface access was unavailable', {
        userId: authUser.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: BILLING_SURFACE_UNAVAILABLE_MESSAGE },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      )
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

    const metadataSupabaseUserId = session.metadata?.supabase_user_id
    const metadataUserId = session.metadata?.userId
    if (metadataSupabaseUserId && metadataUserId && metadataSupabaseUserId !== metadataUserId) {
      return NextResponse.json({ error: 'Checkout identity is inconsistent' }, { status: 400 })
    }
    const userId = metadataSupabaseUserId || metadataUserId
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

    // This retrieval intentionally did not expand Subscription or Customer.
    // Refuse an unexpected object shape instead of coercing it into an ID.
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
    const sessionCustomerId = typeof session.customer === 'string' ? session.customer : null

    if (!subscriptionId || !sessionCustomerId || session.status !== 'complete') {
      return NextResponse.json(
        { error: 'Checkout subscription identity is incomplete' },
        { status: 400 }
      )
    }

    // Stripe remains useful for checking the current product and object
    // identity, but it must never be the authority that grants recurring Pro.
    const tier = 'pro' as const
    let verifiedPlan: 'monthly' | 'yearly' | null = null
    let periodStart: string | null = null
    let periodEnd: string | null = null
    let subscriptionStatus = 'active'

    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      const subscriptionCustomerId =
        typeof subscription.customer === 'string' ? subscription.customer : null
      const item = subscription.items.data.length === 1 ? subscription.items.data[0] : null
      const priceId = item?.price.id || ''
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

      // 检查订阅状态
      if (
        subscription.id !== subscriptionId ||
        subscriptionCustomerId !== sessionCustomerId ||
        item?.quantity !== 1 ||
        plan !== verifiedPlan ||
        (subscription.status !== 'active' && subscription.status !== 'trialing')
      ) {
        return NextResponse.json(
          {
            error: 'Subscription identity is not eligible',
            status: subscription.status,
          },
          { status: 400 }
        )
      }

      // Stripe API 2026-04-22 exposes billing periods on subscription items.
      const pStart = item.current_period_start
      const pEnd = item.current_period_end
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

    const { data: localSubscription, error: localSubscriptionError } = await supabaseAdmin
      .from('subscriptions')
      .select(
        'user_id,tier,status,plan,stripe_subscription_id,stripe_customer_id,current_period_start,current_period_end,entitlement_payment_id,entitlement_trial_id'
      )
      .eq('user_id', userId)
      .maybeSingle()
    if (localSubscriptionError) {
      logger.error('Exact recurring subscription lookup failed', {
        error: localSubscriptionError.message,
        userId,
      })
      return NextResponse.json(
        { error: 'Unable to verify recurring payment authority. Please retry.' },
        { status: 503 }
      )
    }

    if (
      !localSubscription ||
      localSubscription.user_id !== userId ||
      localSubscription.tier !== 'pro' ||
      localSubscription.status !== subscriptionStatus ||
      localSubscription.plan !== verifiedPlan ||
      localSubscription.stripe_subscription_id !== subscriptionId ||
      localSubscription.stripe_customer_id !== sessionCustomerId ||
      !timestampMatches(localSubscription.current_period_start, periodStart) ||
      !timestampMatches(localSubscription.current_period_end, periodEnd)
    ) {
      return recurringAuthorityPending()
    }

    let exactBindingPresent = false
    if (localSubscription.entitlement_payment_id) {
      const { data: payment, error: paymentError } = await supabaseAdmin
        .from('stripe_entitlement_payments')
        .select(
          'id,user_id,payment_kind,payment_status,plan,stripe_customer_id,stripe_subscription_id,period_start,period_end,refund_state,refund_succeeded_amount,amount_paid'
        )
        .eq('id', localSubscription.entitlement_payment_id)
        .maybeSingle()
      if (paymentError) {
        logger.error('Exact recurring payment lookup failed', {
          error: paymentError.message,
          userId,
        })
        return NextResponse.json(
          { error: 'Unable to verify recurring payment authority. Please retry.' },
          { status: 503 }
        )
      }
      exactBindingPresent =
        !!payment &&
        payment.id === localSubscription.entitlement_payment_id &&
        payment.user_id === userId &&
        payment.payment_kind === 'recurring' &&
        (payment.payment_status === 'paid' || payment.payment_status === 'succeeded') &&
        payment.plan === verifiedPlan &&
        payment.stripe_customer_id === sessionCustomerId &&
        payment.stripe_subscription_id === subscriptionId &&
        timestampMatches(payment.period_start, periodStart) &&
        timestampMatches(payment.period_end, periodEnd) &&
        !(
          payment.refund_state === 'succeeded' &&
          payment.refund_succeeded_amount >= payment.amount_paid
        )
    } else if (subscriptionStatus === 'trialing' && localSubscription.entitlement_trial_id) {
      const { data: trial, error: trialError } = await supabaseAdmin
        .from('stripe_trial_entitlements')
        .select(
          'id,user_id,stripe_customer_id,stripe_subscription_id,plan,period_start,period_end,revoked_at'
        )
        .eq('id', localSubscription.entitlement_trial_id)
        .maybeSingle()
      if (trialError) {
        logger.error('Exact recurring trial lookup failed', {
          error: trialError.message,
          userId,
        })
        return NextResponse.json(
          { error: 'Unable to verify recurring payment authority. Please retry.' },
          { status: 503 }
        )
      }
      exactBindingPresent =
        !!trial &&
        trial.id === localSubscription.entitlement_trial_id &&
        trial.user_id === userId &&
        trial.stripe_customer_id === sessionCustomerId &&
        trial.stripe_subscription_id === subscriptionId &&
        trial.plan === verifiedPlan &&
        timestampMatches(trial.period_start, periodStart) &&
        timestampMatches(trial.period_end, periodEnd) &&
        trial.revoked_at === null
    }

    if (!exactBindingPresent) {
      logger.warn('Recurring Checkout replay has no current exact authority', {
        userId,
        subscriptionId,
      })
      return recurringAuthorityPending()
    }

    // This owner-only RPC rechecks payment/trial refund and expiry state inside
    // its transaction before repairing the denormalized profile projection. A
    // refund racing the reads above therefore still makes this request fail
    // closed instead of reviving the legacy subscriptions row.
    const { data: hasExactAuthority, error: syncError } = await supabaseAdmin.rpc(
      'sync_current_pro_projection_atomic',
      { p_user_id: userId }
    )
    if (syncError || typeof hasExactAuthority !== 'boolean') {
      logger.error('Exact recurring entitlement projection sync failed', {
        error: syncError?.message,
        userId,
      })
      return NextResponse.json(
        { error: 'Unable to verify recurring payment authority. Please retry.' },
        { status: 503 }
      )
    }
    if (!hasExactAuthority) {
      return recurringAuthorityPending()
    }

    logger.info('Exact recurring subscription authority verified', { userId, subscriptionId })

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
