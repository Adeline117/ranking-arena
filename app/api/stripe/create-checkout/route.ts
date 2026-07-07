import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_PRICE_IDS,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  getStripe,
} from '@/lib/stripe'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'

export async function POST(request: NextRequest) {
  // 敏感操作限流
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  try {
    // 前置校验：确保 Stripe 环境变量已配置
    if (!env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    let plan: string,
      successUrl: string | undefined,
      cancelUrl: string | undefined,
      promotionCode: string | undefined,
      trial: boolean | undefined
    try {
      const body = await request.json()
      plan = body.plan
      successUrl = body.successUrl
      cancelUrl = body.cancelUrl
      promotionCode = body.promotionCode
      trial = body.trial === true
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
        { status: 400 }
      )
    }

    const { user, error: userError } = await extractUserFromRequest(request)

    const logger = createLogger('stripe-create-checkout')

    if (userError || !user) {
      logger.warn('Auth error', { error: userError })
      return NextResponse.json({ error: 'Unauthorized - Please login first' }, { status: 401 })
    }

    // Prevent duplicate subscriptions — check before doing anything else
    const supabaseAdmin = getSupabaseAdmin()
    const { data: existingSub } = await supabaseAdmin
      .from('subscriptions')
      .select('status, tier, stripe_subscription_id')
      .eq('user_id', user.id)
      .in('status', ['active', 'trialing'])
      .maybeSingle()

    if (existingSub?.tier === 'pro' || existingSub?.tier === 'elite') {
      return NextResponse.json(
        {
          error: 'You already have an active subscription. Manage it from your account settings.',
          code: 'ALREADY_SUBSCRIBED',
        },
        { status: 409 }
      )
    }

    // 验证计划类型
    if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
      return NextResponse.json({ error: 'Invalid plan type' }, { status: 400 })
    }

    // 获取或创建 Stripe 客户
    const userEmail = user.email || `${user.id}@user.ranking-arena.com`
    const customerId = await getOrCreateStripeCustomer(user.id, userEmail, {
      source: 'ranking-arena',
      plan: plan,
    })

    // 更新用户的 Stripe 客户 ID。校验写入:若失败,customer↔user 链未落地,
    // 后续 webhook 若 mis-key 会 orphan 订阅。log 便于观测(不阻断结账,可由 webhook 补)。
    const { error: customerLinkError } = await getSupabaseAdmin().from('user_profiles').upsert({
      id: user.id,
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    if (customerLinkError) {
      logger.warn('Failed to persist stripe_customer_id link', {
        userId: user.id,
        error: customerLinkError.message,
      })
    }

    // 获取价格 ID
    const priceId = STRIPE_PRICE_IDS[plan as 'monthly' | 'yearly' | 'lifetime']

    const meta = {
      supabase_user_id: user.id,
      userId: user.id,
      plan: plan,
    }

    // Validate redirect URLs to prevent open redirect attacks
    const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org').origin
    const defaultSuccessUrl = `${env.NEXT_PUBLIC_APP_URL}/pricing/success?session_id={CHECKOUT_SESSION_ID}`
    const defaultCancelUrl = `${env.NEXT_PUBLIC_APP_URL}/pricing`

    let sUrl = defaultSuccessUrl
    let cUrl = defaultCancelUrl
    if (successUrl && typeof successUrl === 'string') {
      try {
        const parsed = new URL(successUrl, appOrigin)
        if (parsed.origin === appOrigin) sUrl = parsed.href
      } catch {
        /* invalid URL — use default */
      }
    }
    if (cancelUrl && typeof cancelUrl === 'string') {
      try {
        const parsed = new URL(cancelUrl, appOrigin)
        if (parsed.origin === appOrigin) cUrl = parsed.href
      } catch {
        /* invalid URL — use default */
      }
    }

    let checkoutSession

    if (plan === 'lifetime') {
      // 终身会员 — 一次性付款 (mode: 'payment')
      if (!priceId || !priceId.startsWith('price_')) {
        throw new Error(
          `Invalid Stripe price ID for lifetime: "${priceId}". Please configure STRIPE_PRO_LIFETIME_PRICE_ID.`
        )
      }

      // Enforce 200-spot limit with pg_advisory_xact_lock to prevent TOCTOU oversell.
      // The RPC atomically acquires an advisory lock and checks the count,
      // so two concurrent requests cannot both see count=199 and both proceed.

      const { data: spotsAvailable, error: spotsError } = await (getSupabaseAdmin() as any).rpc(
        'check_lifetime_spots_available',
        { max_spots: 200 }
      )
      if (spotsError || spotsAvailable === false) {
        if (spotsError) {
          const logger = createLogger('stripe-create-checkout')
          logger.error('Lifetime spots check failed', { error: spotsError.message })
        }
        return NextResponse.json(
          { error: 'All founding member spots have been claimed.' },
          { status: 410 }
        )
      }

      // payment_method_types: card + link. Apple Pay / Google Pay are enabled
      // automatically via Stripe's card payment method when configured in Dashboard.
      // Idempotency key prevents double-charge on double-click/retry.
      // Scoped to user + plan + minute window. Stripe deduplicates within 24h.
      const lifetimeIdempotencyKey = `checkout_lifetime_${user.id}_${Math.floor(Date.now() / 60_000)}`
      checkoutSession = await getStripe().checkout.sessions.create(
        {
          customer: customerId,
          payment_method_types: ['card', 'link'],
          line_items: [{ price: priceId, quantity: 1 }],
          mode: 'payment',
          success_url: sUrl,
          cancel_url: cUrl,
          metadata: meta,
          allow_promotion_codes: !promotionCode,
          billing_address_collection: 'auto',
          locale: 'auto',
          ...(promotionCode ? { discounts: [{ promotion_code: promotionCode }] } : {}),
        },
        {
          idempotencyKey: lifetimeIdempotencyKey,
        }
      )
    } else {
      // 月付 / 年付订阅
      const checkoutOptions: Parameters<typeof createCheckoutSession>[0] = {
        customerId,
        priceId,
        successUrl: sUrl,
        cancelUrl: cUrl,
        metadata: meta,
      }

      // Add promotion code if provided
      if (promotionCode) {
        checkoutOptions.promotionCode = promotionCode
      }

      // Add 7-day free trial if requested (only for new subscribers, not lifetime)
      if (trial) {
        checkoutOptions.trialDays = 7
      }

      checkoutSession = await createCheckoutSession(checkoutOptions)
    }

    return NextResponse.json({
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    })
  } catch (error: unknown) {
    const logger = createLogger('stripe-create-checkout')
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Error creating checkout session', { error: errorMessage })

    // 环境变量缺失 → 503 Service Unavailable
    if (errorMessage.includes('STRIPE_SECRET_KEY') || errorMessage.includes('not configured')) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    // 提供更详细的错误信息
    let userFacingMessage = 'Failed to create checkout session'
    let statusCode = 500
    if (error instanceof Error) {
      const stripeError = error as Error & { type?: string; code?: string }
      if (stripeError.type === 'StripeInvalidRequestError') {
        userFacingMessage = 'Invalid payment configuration. Please contact support.'
      } else if (stripeError.code === 'ENOTFOUND' || stripeError.code === 'ECONNREFUSED') {
        userFacingMessage = 'Network error. Please check your connection and try again.'
        statusCode = 502
      }
    }

    return NextResponse.json(
      {
        error: userFacingMessage,
        code: 'CHECKOUT_ERROR',
      },
      { status: statusCode }
    )
  }
}
