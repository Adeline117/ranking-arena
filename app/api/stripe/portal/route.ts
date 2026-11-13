import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createPortalSession } from '@/lib/stripe'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'

type PortalFlowData = NonNullable<Stripe.BillingPortal.SessionCreateParams['flow_data']>

type PortalFlowType = 'payment_method_update' | 'subscription_update' | 'subscription_cancel'
const PORTAL_FLOW_TYPES: readonly PortalFlowType[] = [
  'payment_method_update',
  'subscription_update',
  'subscription_cancel',
]

function parseFlowType(raw: unknown): PortalFlowType | null {
  if (!raw || typeof raw !== 'object') return null
  const type = (raw as { type?: unknown }).type
  return PORTAL_FLOW_TYPES.includes(type as PortalFlowType) ? (type as PortalFlowType) : null
}

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

    let rawReturnUrl: string | undefined
    let flowType: PortalFlowType | null = null
    try {
      const body = await request.json()
      rawReturnUrl = body.returnUrl
      // Deep-link flows (change plan / update card / cancel) used to be dropped
      // here, so every button landed on the generic portal home.
      flowType = parseFlowType(body?.flow_data)
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
        { status: 400 }
      )
    }

    // Validate returnUrl to prevent open redirect
    let returnUrl: string | undefined
    if (rawReturnUrl && typeof rawReturnUrl === 'string') {
      try {
        const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org').origin
        const parsed = new URL(rawReturnUrl, appOrigin)
        if (parsed.origin === appOrigin) {
          returnUrl = parsed.href
        }
      } catch {
        // Invalid URL — use default
      }
    }

    // 获取当前用户
    const { user, error: authError } = await extractUserFromRequest(request)

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Alias for backward compat
    const session = { user }

    // 获取用户的 Stripe Customer ID
    const admin = getSupabaseAdmin()
    const { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', session.user.id)
      .maybeSingle()

    if (profileError) {
      // A failed lookup is not "no customer": redirecting a paying user to
      // /pricing would invite a duplicate subscription.
      logger.error('Portal profile lookup failed', {
        userId: session.user.id,
        error: profileError.message,
      })
      return NextResponse.json({ error: 'Failed to create portal session' }, { status: 500 })
    }

    if (!profile?.stripe_customer_id) {
      // Fallback: redirect to pricing page when no customer exists
      return NextResponse.json({ redirect: '/pricing' }, { status: 200 })
    }

    const resolvedReturnUrl = returnUrl || `${env.NEXT_PUBLIC_APP_URL}/settings`
    let flowData: PortalFlowData | undefined
    if (flowType === 'payment_method_update') {
      flowData = { type: 'payment_method_update' }
    } else if (flowType) {
      const { data: sub, error: subError } = await admin
        .from('subscriptions')
        .select('stripe_subscription_id, stripe_customer_id')
        .eq('user_id', session.user.id)
        .maybeSingle()
      if (subError) {
        logger.warn('Portal subscription lookup failed; opening portal home', {
          userId: session.user.id,
          error: subError.message,
        })
      }
      const subscriptionId = sub?.stripe_subscription_id
      // Only deep-link a subscription that belongs to this user's customer.
      if (subscriptionId && sub?.stripe_customer_id === profile.stripe_customer_id) {
        flowData =
          flowType === 'subscription_update'
            ? { type: 'subscription_update', subscription_update: { subscription: subscriptionId } }
            : { type: 'subscription_cancel', subscription_cancel: { subscription: subscriptionId } }
      }
    }

    // 创建客户门户会话
    let portalSession: Stripe.BillingPortal.Session
    try {
      portalSession = await createPortalSession(
        profile.stripe_customer_id,
        resolvedReturnUrl,
        flowData
      )
    } catch (flowError) {
      if (!flowData) throw flowError
      // The portal configuration may not enable this flow; the portal home
      // still lets the user do it, which beats a dead button.
      logger.warn('Portal flow rejected; opening portal home', {
        userId: session.user.id,
        flow: flowData.type,
        error: flowError instanceof Error ? flowError.message : String(flowError),
      })
      portalSession = await createPortalSession(profile.stripe_customer_id, resolvedReturnUrl)
    }

    logger.info('Stripe portal session created', {
      userId: session.user.id,
      customerId: profile.stripe_customer_id,
    })

    return NextResponse.json({
      url: portalSession.url,
    })
  } catch (error: unknown) {
    logger.error('Portal session error:', error)
    const message = error instanceof Error ? error.message : ''
    if (message.includes('STRIPE_SECRET_KEY') || message.includes('not configured')) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }
    return NextResponse.json({ error: 'Failed to create portal session' }, { status: 500 })
  }
}
