import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_API_PRICE_IDS,
  STRIPE_PRICE_IDS,
  assertStripePaymentRuntimeReady,
  getStripe,
} from '@/lib/stripe'
import {
  createBillingPortalFlow,
  type BillingPortalAuthority,
  type BillingPortalFlow,
  type BillingPortalScope,
} from '@/lib/stripe/billing-portal'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { isTrustedStripeBillingPortalUrl } from '@/lib/stripe/hosted-url'

const allowedFlows = new Set<BillingPortalFlow>(['payment_method_update', 'subscription_cancel'])
const allowedScopes = new Set<BillingPortalScope>(['membership', 'api'])
const manageableLocalStatuses = new Set([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
  'paused',
])

type PortalRequest = {
  flow: BillingPortalFlow
  scope: BillingPortalScope
}

type BillingProfile = {
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  api_stripe_subscription_id: string | null
  api_tier: string
  deleted_at: string | null
}

type MembershipSubscription = {
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  status: string
  tier: string
  plan: string | null
}

class PortalRequestError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'NO_SUBSCRIPTION' | 'IDENTITY_UNAVAILABLE',
    message: string
  ) {
    super(message)
  }
}

function parsePortalRequest(value: unknown): PortalRequest {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new PortalRequestError('INVALID_REQUEST', 'Request body must be an object')
  }

  const body = value as Record<string, unknown>
  const keys = Object.keys(body)
  if (
    keys.length !== 2 ||
    !keys.includes('flow') ||
    !keys.includes('scope') ||
    typeof body.flow !== 'string' ||
    typeof body.scope !== 'string' ||
    !allowedFlows.has(body.flow as BillingPortalFlow) ||
    !allowedScopes.has(body.scope as BillingPortalScope)
  ) {
    throw new PortalRequestError('INVALID_REQUEST', 'Unsupported Billing Portal flow')
  }

  return {
    flow: body.flow as BillingPortalFlow,
    scope: body.scope as BillingPortalScope,
  }
}

function validStripeId(value: string | null, prefix: 'cus_' | 'sub_'): value is string {
  return Boolean(value?.startsWith(prefix) && value.length > prefix.length)
}

async function resolvePortalAuthority(params: {
  admin: ReturnType<typeof getSupabaseAdmin>
  userId: string
  scope: BillingPortalScope
  livemode: boolean
}): Promise<BillingPortalAuthority> {
  const { data: rawProfile, error: profileError } = await params.admin
    .from('user_profiles')
    .select(
      'stripe_customer_id, stripe_subscription_id, api_stripe_subscription_id, api_tier, deleted_at'
    )
    .eq('id', params.userId)
    .maybeSingle()
  const profile = rawProfile as BillingProfile | null

  if (profileError) {
    throw new PortalRequestError('IDENTITY_UNAVAILABLE', 'Billing profile lookup failed')
  }
  if (
    !profile ||
    profile.deleted_at !== null ||
    !validStripeId(profile.stripe_customer_id, 'cus_')
  ) {
    throw new PortalRequestError('NO_SUBSCRIPTION', 'No manageable subscription')
  }

  if (params.scope === 'api') {
    if (
      (profile.api_tier !== 'starter' && profile.api_tier !== 'pro') ||
      !validStripeId(profile.api_stripe_subscription_id, 'sub_')
    ) {
      throw new PortalRequestError('NO_SUBSCRIPTION', 'No manageable API subscription')
    }

    return {
      userId: params.userId,
      customerId: profile.stripe_customer_id,
      subscriptionId: profile.api_stripe_subscription_id,
      scope: 'api',
      plan: profile.api_tier,
      localStatus: 'active',
      livemode: params.livemode,
    }
  }

  const { data: rawSubscriptions, error: subscriptionError } = await params.admin
    .from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id, status, tier, plan')
    .eq('user_id', params.userId)
    .not('stripe_subscription_id', 'is', null)
    .limit(2)
  const subscriptions = (rawSubscriptions ?? []) as MembershipSubscription[]

  if (subscriptionError) {
    throw new PortalRequestError('IDENTITY_UNAVAILABLE', 'Subscription lookup failed')
  }
  if (subscriptions.length !== 1) {
    throw new PortalRequestError('NO_SUBSCRIPTION', 'No unambiguous membership subscription')
  }

  const subscription = subscriptions[0]
  if (
    !validStripeId(subscription.stripe_subscription_id, 'sub_') ||
    subscription.stripe_customer_id !== profile.stripe_customer_id ||
    (profile.stripe_subscription_id !== null &&
      profile.stripe_subscription_id !== subscription.stripe_subscription_id) ||
    subscription.tier !== 'pro' ||
    (subscription.plan !== 'monthly' && subscription.plan !== 'yearly') ||
    !manageableLocalStatuses.has(subscription.status)
  ) {
    throw new PortalRequestError('IDENTITY_UNAVAILABLE', 'Membership identity is inconsistent')
  }

  return {
    userId: params.userId,
    customerId: profile.stripe_customer_id,
    subscriptionId: subscription.stripe_subscription_id,
    scope: 'membership',
    plan: subscription.plan,
    localStatus: subscription.status,
    livemode: params.livemode,
  }
}

function completionUrl(scope: BillingPortalScope): string {
  const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org').origin
  return scope === 'api'
    ? `${appOrigin}/settings#api-keys`
    : `${appOrigin}/user-center?tab=membership`
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    let portalRequest: PortalRequest
    try {
      portalRequest = parsePortalRequest(await request.json())
    } catch (error) {
      if (error instanceof PortalRequestError) {
        return NextResponse.json(
          { error: 'Unsupported Billing Portal request.', code: 'INVALID_PORTAL_REQUEST' },
          { status: 400 }
        )
      }
      return NextResponse.json(
        { error: 'Invalid JSON in request body.', code: 'INVALID_JSON' },
        { status: 400 }
      )
    }

    const { user, error: authError } = await extractUserFromRequest(request)
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
      assertStripePaymentRuntimeReady()
    } catch (error) {
      logger.error('Billing Portal runtime is not ready', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    const secretKey = env.STRIPE_SECRET_KEY?.trim()
    if (!secretKey) {
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503 }
      )
    }

    const authority = await resolvePortalAuthority({
      admin: getSupabaseAdmin(),
      userId: user.id,
      scope: portalRequest.scope,
      livemode: secretKey.startsWith('sk_live_'),
    })

    const portalSession = await createBillingPortalFlow({
      stripe: getStripe(),
      authority,
      flow: portalRequest.flow,
      returnUrl: completionUrl(portalRequest.scope),
      prices: {
        membership: {
          monthly: STRIPE_PRICE_IDS.monthly,
          yearly: STRIPE_PRICE_IDS.yearly,
        },
        api: {
          starter: STRIPE_API_PRICE_IDS.starter,
          pro: STRIPE_API_PRICE_IDS.pro,
        },
      },
    })

    // Keep the route boundary independently fail-closed even if the Stripe
    // adapter is mocked, replaced, or regresses later.
    if (!isTrustedStripeBillingPortalUrl(portalSession.url)) {
      throw new Error('Stripe returned an invalid Billing Portal URL')
    }

    logger.info('Stripe Billing Portal flow created', {
      userId: user.id,
      customerId: authority.customerId,
      subscriptionId: authority.subscriptionId,
      scope: authority.scope,
      flow: portalRequest.flow,
    })

    const response = NextResponse.json({ url: portalSession.url })
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  } catch (error: unknown) {
    if (error instanceof PortalRequestError) {
      const status = error.code === 'NO_SUBSCRIPTION' ? 409 : 503
      logger.warn('Billing Portal authority rejected', {
        code: error.code,
        error: error.message,
      })
      return NextResponse.json(
        {
          error:
            status === 409
              ? 'No manageable subscription was found.'
              : 'Unable to verify billing identity. Please retry.',
          code: status === 409 ? 'NO_MANAGEABLE_SUBSCRIPTION' : 'BILLING_IDENTITY_UNAVAILABLE',
        },
        { status }
      )
    }

    logger.error('Billing Portal flow error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      {
        error: 'Unable to open subscription management. Please retry.',
        code: 'BILLING_PORTAL_UNAVAILABLE',
      },
      { status: 503 }
    )
  }
}
