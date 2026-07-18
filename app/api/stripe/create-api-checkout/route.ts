import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_API_PRICE_IDS,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  assertApiPriceReady,
  assertStripePaymentRuntimeReady,
} from '@/lib/stripe'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'

const logger = createLogger('stripe-create-api-checkout')

type ApiPlan = 'starter' | 'pro'

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    if (!env.STRIPE_SECRET_KEY) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    let plan: string
    try {
      const body = await request.json()
      plan = body.plan
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
        { status: 400 }
      )
    }

    if (!['starter', 'pro'].includes(plan)) {
      return NextResponse.json(
        { error: 'Invalid plan. Must be "starter" or "pro".' },
        { status: 400 }
      )
    }

    const { user, error: userError } = await extractUserFromRequest(request)
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized - Please login first' }, { status: 401 })
    }

    // Check if user already has an active API tier subscription
    const supabaseAdmin = getSupabaseAdmin()
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .select('api_tier, api_stripe_subscription_id, stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError || !profile) {
      logger.error('Billing profile lookup failed', {
        userId: user.id,
        error: profileError?.message,
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503 }
      )
    }

    if (profile?.api_tier === plan) {
      return NextResponse.json(
        {
          error: `You already have an active ${plan} API plan. Manage it from your account settings.`,
          code: 'ALREADY_SUBSCRIBED',
        },
        { status: 409 }
      )
    }

    const priceId = STRIPE_API_PRICE_IDS[plan as ApiPlan]
    if (!priceId || !priceId.startsWith('price_')) {
      return NextResponse.json(
        { error: 'API plan pricing not configured. Please contact support.' },
        { status: 503 }
      )
    }

    try {
      assertStripePaymentRuntimeReady()
      await assertApiPriceReady(plan as ApiPlan, priceId)
    } catch (priceError) {
      logger.error('Stripe API price readiness check failed', {
        plan,
        error: priceError instanceof Error ? priceError.message : String(priceError),
      })
      return NextResponse.json(
        { error: 'API plan pricing is not ready. Please contact support.' },
        { status: 503 }
      )
    }

    const userEmail = user.email || `${user.id}@user.ranking-arena.com`
    const customerId = await getOrCreateStripeCustomer(
      user.id,
      userEmail,
      {
        source: 'ranking-arena-api',
        plan: `api_${plan}`,
      },
      profile.stripe_customer_id
    )

    // Invoice/subscription webhooks resolve ownership through this link. Do
    // not expose a payable Checkout Session if the link failed to persist.
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
      logger.error('Failed to persist Stripe customer link; API checkout blocked', {
        userId: user.id,
        error: customerLinkError?.message,
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503 }
      )
    }

    const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org').origin
    const successUrl = `${appOrigin}/settings?api_upgraded=${plan}`
    const cancelUrl = `${appOrigin}/api-docs`

    const meta = {
      supabase_user_id: user.id,
      userId: user.id,
      type: 'api_tier',
      api_plan: plan,
    }

    const checkoutSession = await createCheckoutSession({
      customerId,
      priceId,
      successUrl,
      cancelUrl,
      metadata: meta,
    })

    return NextResponse.json({
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('Error creating API checkout session', { error: errorMessage })

    if (errorMessage.includes('not configured')) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { error: 'Failed to create checkout session', code: 'CHECKOUT_ERROR' },
      { status: 500 }
    )
  }
}
