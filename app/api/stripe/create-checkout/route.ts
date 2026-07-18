import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_PRICE_IDS,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  getStripe,
  assertProPriceReady,
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

    if (!['monthly', 'yearly', 'lifetime'].includes(plan)) {
      return NextResponse.json({ error: 'Invalid plan type' }, { status: 400 })
    }
    if (promotionCode !== undefined) {
      return NextResponse.json(
        {
          error: 'Promotion codes are not available for Pro checkout.',
          code: 'PROMOTION_CODES_DISABLED',
        },
        { status: 400 }
      )
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

    const { data: billingProfile, error: billingProfileError } = await supabaseAdmin
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()
    if (billingProfileError || !billingProfile) {
      logger.error('Billing profile lookup failed', {
        userId: user.id,
        error: billingProfileError?.message,
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503 }
      )
    }

    const typedPlan = plan as 'monthly' | 'yearly' | 'lifetime'
    const priceId = STRIPE_PRICE_IDS[typedPlan]
    try {
      await assertProPriceReady(typedPlan, priceId)
    } catch (priceError) {
      logger.error('Stripe Pro price readiness check failed', {
        plan: typedPlan,
        error: priceError instanceof Error ? priceError.message : String(priceError),
      })
      return NextResponse.json(
        { error: 'Payment pricing is not ready. Please contact support.' },
        { status: 503 }
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
      },
      billingProfile.stripe_customer_id
    )

    // The customer↔user link is required for every subscription/invoice/refund
    // webhook. Never create a payable session if this write did not persist.
    const { data: customerLink, error: customerLinkError } = await supabaseAdmin
      .from('user_profiles')
      .update({
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select('id')
      .maybeSingle()
    if (customerLinkError || customerLink?.id !== user.id) {
      logger.error('Failed to persist stripe_customer_id link; checkout blocked', {
        userId: user.id,
        error: customerLinkError?.message,
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503 }
      )
    }

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

      const { data: spotsAvailable, error: spotsError } = await getSupabaseAdmin().rpc(
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
          allow_promotion_codes: false,
          billing_address_collection: 'auto',
          locale: 'auto',
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
        allowPromotionCodes: false,
      }

      // Add 7-day free trial if requested (only for new subscribers, not lifetime).
      // 2026-07-11:trial 由客户端 body 传,此前无"已试用过"校验 → 取消后重订可
      // 无限薅 7 天。这里查该 customer 的 Stripe 订阅历史,任一曾有 trial 即拒发。
      if (trial) {
        let alreadyTrialed = false
        try {
          let startingAfter: string | undefined
          while (true) {
            const history = await getStripe().subscriptions.list({
              customer: customerId,
              status: 'all',
              limit: 100,
              ...(startingAfter ? { starting_after: startingAfter } : {}),
            })
            if (
              history.data.some(
                (subscription) => subscription.trial_start != null || subscription.trial_end != null
              )
            ) {
              alreadyTrialed = true
              break
            }
            if (!history.has_more) break

            const lastSubscription = history.data.at(-1)
            if (!lastSubscription || lastSubscription.id === startingAfter) {
              throw new Error('Stripe trial-history pagination did not advance')
            }
            startingAfter = lastSubscription.id
          }
        } catch (err) {
          // Stripe 查询失败 → 保守不给 trial(宁可少给也不重复白送)
          logger.warn('trial-history check failed; denying trial', {
            error: err instanceof Error ? err.message : err,
          })
          alreadyTrialed = true
        }
        if (!alreadyTrialed) {
          checkoutOptions.trialDays = 7
        }
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
