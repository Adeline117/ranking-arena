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

    const { plan, successUrl, cancelUrl, promotionCode } = await request.json()

    const { user, error: userError } = await extractUserFromRequest(request)

    const logger = createLogger('stripe-create-checkout')

    if (userError || !user) {
      logger.warn('Auth error', { error: userError })
      return NextResponse.json(
        { error: 'Unauthorized - Please login first' },
        { status: 401 }
      )
    }

    // 验证计划类型
    if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
      return NextResponse.json(
        { error: 'Invalid plan type' },
        { status: 400 }
      )
    }

    // 获取或创建 Stripe 客户
    const userEmail = user.email || `${user.id}@user.ranking-arena.com`
    const customerId = await getOrCreateStripeCustomer(
      user.id,
      userEmail,
      {
        source: 'ranking-arena',
        plan: plan,
      }
    )

    // 更新用户的 Stripe 客户 ID
    await getSupabaseAdmin()
      .from('user_profiles')
      .upsert({
        id: user.id,
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      })

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
      } catch { /* invalid URL — use default */ }
    }
    if (cancelUrl && typeof cancelUrl === 'string') {
      try {
        const parsed = new URL(cancelUrl, appOrigin)
        if (parsed.origin === appOrigin) cUrl = parsed.href
      } catch { /* invalid URL — use default */ }
    }

    let checkoutSession

    if (plan === 'lifetime') {
      // 终身会员 — 一次性付款 (mode: 'payment')
      if (!priceId || !priceId.startsWith('price_')) {
        throw new Error(`Invalid Stripe price ID for lifetime: "${priceId}". Please configure STRIPE_PRO_LIFETIME_PRICE_ID.`)
      }

      // Enforce 200-spot limit
      // KEEP 'exact' — billing-critical scarcity check. Must be accurate
      // to prevent overselling the 200 lifetime founding member spots.
      const LIFETIME_SPOTS_TOTAL = 200
      const { count: lifetimeCount } = await getSupabaseAdmin()
        .from('user_profiles')
        .select('id', { count: 'exact', head: true })
        .eq('pro_plan', 'lifetime')
      if ((lifetimeCount ?? 0) >= LIFETIME_SPOTS_TOTAL) {
        return NextResponse.json(
          { error: 'All founding member spots have been claimed.' },
          { status: 410 }
        )
      }

      checkoutSession = await getStripe().checkout.sessions.create({
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
      })
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
