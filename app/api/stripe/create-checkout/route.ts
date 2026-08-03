import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_PRICE_IDS,
  STRIPE_API_PRICE_IDS,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  getStripe,
  assertProPriceReady,
  assertStripePaymentRuntimeReady,
} from '@/lib/stripe'
import { PRICING } from '@/app/(app)/user-center/membership-config'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import {
  LIFETIME_RESERVATION_ID_METADATA_KEY,
  LIFETIME_RESERVATION_NONCE_METADATA_KEY,
  recordStripeCheckoutManualReview,
} from '@/lib/stripe/lifetime-entitlement'
import {
  BILLING_SURFACE_UNAVAILABLE_MESSAGE,
  assertUserStripeBillingSurfaceAccess,
} from '@/lib/stripe/billing-surface-access'
import type { Json } from '@/lib/supabase/database.types'
import {
  PRO_CHECKOUT_METADATA_KEYS,
  PRO_MEMBERSHIP_PRICE_METADATA_KEY,
  PRO_MEMBERSHIP_RESERVATION_METADATA_KEY,
  listCompleteCustomerProSubscriptions,
  recoverExpiredProCheckoutReservation,
  stripeCustomerIsExactlyOwned,
  verifyFreshProCheckoutSession,
  type ExactRecurringPriceSnapshot,
  type ProCheckoutReservation,
  type ProSessionVerification,
  type ProSubscriptionSnapshot,
} from '@/lib/stripe/pro-checkout-recovery'

const LIFETIME_RESERVATION_TTL_SECONDS = 60 * 60
const LIFETIME_PRICE_CENTS = Math.round(PRICING.lifetime.price * 100)
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const stripeCustomerIdPattern = /^cus_[A-Za-z0-9_]+$/
const stripeSessionIdPattern = /^cs_[A-Za-z0-9_]+$/
const stripePriceIdPattern = /^price_[A-Za-z0-9_]+$/
const stripeLineItemIdPattern = /^li_[A-Za-z0-9_]+$/
const maxStripeUnixSeconds = 253_402_300_799
const maxStripePaginationPages = 100
const reservationNoncePattern = /^[A-Za-z0-9_.:-]{8,128}$/
const blockingProSubscriptionStatuses = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
  'paused',
])
const terminalProSubscriptionStatuses = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
])
const PRIVATE_NO_STORE = 'private, no-store'

function rpcRecord(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function exactStripeIdentifier(value: unknown, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length <= 255 &&
    pattern.test(value)
  )
}

function stripeId(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : value?.id || null
}

function isHostedCheckoutUrl(value: string | null): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
  } catch {
    return false
  }
}

function configuredApplicationOrigin(): string | null {
  try {
    const configured = env.NEXT_PUBLIC_APP_URL
    if (!configured) return null
    const url = new URL(configured)
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function hasExactOrigin(value: string, expectedOrigin: string): boolean {
  try {
    return new URL(value).origin === expectedOrigin
  } catch {
    return false
  }
}

function checkoutLinePriceId(line: Stripe.LineItem): string | null {
  return line.price?.id || null
}

function isEmptyOptionalStripeCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

type RecurringProPlan = 'monthly' | 'yearly'

function stripeSecretLivemode(secret: string): boolean | null {
  const value = secret.trim()
  if (value.startsWith('sk_live_')) return true
  if (value.startsWith('sk_test_')) return false
  return null
}

function recurringCheckoutUnavailable() {
  return NextResponse.json(
    { error: 'Unable to prepare Pro checkout. Please retry.' },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
    }
  )
}

function recurringCheckoutConflict() {
  return NextResponse.json(
    {
      error:
        'A checkout for a different Pro plan is already in progress. Finish it or retry after it expires.',
      code: 'PRO_CHECKOUT_CONFLICT',
    },
    { status: 409, headers: { 'Cache-Control': 'no-store' } }
  )
}

function recurringTrialAlreadyUsed() {
  return NextResponse.json(
    {
      error:
        'This account has already used its Pro free trial. Choose the paid upgrade explicitly to continue.',
      code: 'TRIAL_ALREADY_USED',
    },
    { status: 409, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
  )
}

function parseProCheckoutReservation(value: unknown): ProCheckoutReservation | null {
  const record = rpcRecord(value)
  if (!record) return null
  const status = record.status
  const reservationId = record.reservation_id
  const plan = record.pro_plan
  const priceId = record.stripe_price_id
  const unitAmount = record.unit_amount
  const currency = record.currency
  const trialDays = record.trial_days
  const successUrl = record.success_url
  const cancelUrl = record.cancel_url
  const checkoutExpiresAt = record.checkout_expires_at
  const checkoutSessionId = record.checkout_session_id

  if (
    (status !== 'reserved' && status !== 'existing') ||
    typeof reservationId !== 'string' ||
    !canonicalUuidPattern.test(reservationId) ||
    (plan !== 'monthly' && plan !== 'yearly') ||
    !exactStripeIdentifier(priceId, stripePriceIdPattern) ||
    typeof unitAmount !== 'number' ||
    !Number.isSafeInteger(unitAmount) ||
    unitAmount <= 0 ||
    currency !== 'usd' ||
    (trialDays !== 0 && trialDays !== 7) ||
    typeof successUrl !== 'string' ||
    !successUrl.startsWith('https://') ||
    typeof cancelUrl !== 'string' ||
    !cancelUrl.startsWith('https://') ||
    typeof checkoutExpiresAt !== 'number' ||
    !Number.isSafeInteger(checkoutExpiresAt) ||
    checkoutExpiresAt <= 2700 ||
    checkoutExpiresAt > maxStripeUnixSeconds ||
    (checkoutSessionId !== null &&
      !exactStripeIdentifier(checkoutSessionId, stripeSessionIdPattern)) ||
    (status === 'reserved' && checkoutSessionId !== null)
  ) {
    return null
  }

  return {
    status,
    reservationId,
    plan,
    priceId,
    unitAmount,
    currency,
    trialDays,
    successUrl,
    cancelUrl,
    checkoutExpiresAtSeconds: checkoutExpiresAt,
    checkoutSessionId,
  }
}

async function listCompleteCheckoutLineItems(
  stripeClient: Stripe,
  sessionId: string,
  expandPrice = false
): Promise<Stripe.LineItem[]> {
  const lines: Stripe.LineItem[] = []
  const seenLineIds = new Set<string>()
  let startingAfter: string | undefined
  let pageCount = 0

  while (true) {
    pageCount += 1
    if (pageCount > maxStripePaginationPages) {
      throw new Error('Stripe Checkout line-item pagination exceeded its safety limit')
    }
    const page = await stripeClient.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      ...(expandPrice ? { expand: ['data.price'] } : {}),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || page.data.length > 100 || typeof page.has_more !== 'boolean') {
      throw new Error('Stripe Checkout line-item pagination returned an invalid page')
    }
    if (startingAfter && page.data.length === 0) {
      throw new Error('Stripe Checkout line-item pagination returned an empty continuation page')
    }
    for (const line of page.data) {
      if (
        !exactStripeIdentifier(line.id, stripeLineItemIdPattern) ||
        line.object !== 'item' ||
        seenLineIds.has(line.id)
      ) {
        throw new Error('Stripe Checkout line-item pagination returned uncertain identity')
      }
      seenLineIds.add(line.id)
      lines.push(line)
    }
    if (!page.has_more) return lines

    const lastLine = page.data.at(-1)
    if (!lastLine?.id || lastLine.id === startingAfter) {
      throw new Error('Stripe Checkout line-item pagination did not advance')
    }
    startingAfter = lastLine.id
  }
}

async function expireProCheckoutSessionBestEffort(
  sessionId: string,
  logger: ReturnType<typeof createLogger>,
  context: string
) {
  try {
    await getStripe().checkout.sessions.expire(sessionId)
  } catch (error) {
    logger.error('Failed to expire an exact-owned unsafe Pro Checkout Session', {
      sessionId,
      context,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

type LifetimeSessionVerification =
  | { ok: true; session: Stripe.Checkout.Session }
  | { ok: false; reason: string; context: Record<string, Json> }

async function verifyFreshLifetimeSession(params: {
  stripeClient: Stripe
  sessionId: string
  userId: string
  customerId: string
  reservationId: string
  requestNonce: string
  checkoutExpiresAtSeconds: number
  priceId: string
}): Promise<LifetimeSessionVerification> {
  if (!exactStripeIdentifier(params.sessionId, stripeSessionIdPattern)) {
    return {
      ok: false,
      reason: 'Stripe returned an invalid lifetime Checkout Session identity.',
      context: { checkout_session_id: params.sessionId },
    }
  }

  const session = await params.stripeClient.checkout.sessions.retrieve(params.sessionId, {
    expand: ['line_items'],
  })
  const lines = await listCompleteCheckoutLineItems(params.stripeClient, params.sessionId)
  const line = lines.length === 1 ? lines[0] : null
  const sessionDiscounts = session.discounts
  const lineDiscounts = line?.discounts
  const lineTaxes = line?.taxes
  const matches =
    session.id === params.sessionId &&
    exactStripeIdentifier(session.id, stripeSessionIdPattern) &&
    stripeId(session.customer) === params.customerId &&
    session.metadata?.supabase_user_id === params.userId &&
    session.metadata?.userId === params.userId &&
    session.metadata?.plan === 'lifetime' &&
    session.metadata?.[LIFETIME_RESERVATION_ID_METADATA_KEY] === params.reservationId &&
    session.metadata?.[LIFETIME_RESERVATION_NONCE_METADATA_KEY] === params.requestNonce &&
    session.expires_at === params.checkoutExpiresAtSeconds &&
    session.mode === 'payment' &&
    session.status === 'open' &&
    session.payment_status === 'unpaid' &&
    session.subscription === null &&
    session.after_expiration === null &&
    isHostedCheckoutUrl(session.url) &&
    session.currency === 'usd' &&
    session.amount_subtotal === LIFETIME_PRICE_CENTS &&
    session.amount_total === LIFETIME_PRICE_CENTS &&
    session.total_details?.amount_discount === 0 &&
    session.total_details.amount_tax === 0 &&
    session.allow_promotion_codes !== true &&
    session.automatic_tax?.enabled === false &&
    session.adaptive_pricing?.enabled !== true &&
    isEmptyOptionalStripeCollection(sessionDiscounts) &&
    !!line &&
    line.quantity === 1 &&
    checkoutLinePriceId(line) === params.priceId &&
    line.currency === 'usd' &&
    line.amount_subtotal === LIFETIME_PRICE_CENTS &&
    line.amount_total === LIFETIME_PRICE_CENTS &&
    line.amount_discount === 0 &&
    line.amount_tax === 0 &&
    isEmptyOptionalStripeCollection(lineDiscounts) &&
    isEmptyOptionalStripeCollection(lineTaxes)

  if (matches) return { ok: true, session }
  return {
    ok: false,
    reason: 'A lifetime Checkout Session failed exact fresh identity and price verification.',
    context: {
      checkout_session_id: session.id,
      expected_customer_id: params.customerId,
      actual_customer_id: stripeId(session.customer),
      expected_price_id: params.priceId,
      actual_price_id: line ? checkoutLinePriceId(line) : null,
      expected_amount: LIFETIME_PRICE_CENTS,
      actual_session_amount_subtotal: session.amount_subtotal,
      actual_session_amount_total: session.amount_total,
      actual_line_amount_subtotal: line?.amount_subtotal ?? null,
      actual_line_amount_total: line?.amount_total ?? null,
      actual_session_currency: session.currency,
      actual_line_currency: line?.currency ?? null,
      actual_line_count: lines.length,
      actual_line_quantity: line?.quantity ?? null,
      actual_session_discount: session.total_details?.amount_discount ?? null,
      actual_line_discount: line?.amount_discount ?? null,
      actual_session_tax: session.total_details?.amount_tax ?? null,
      actual_line_tax: line?.amount_tax ?? null,
      actual_allow_promotion_codes: session.allow_promotion_codes,
      actual_automatic_tax_enabled: session.automatic_tax?.enabled ?? null,
      actual_adaptive_pricing_enabled: session.adaptive_pricing?.enabled ?? null,
      actual_session_discount_count: Array.isArray(sessionDiscounts)
        ? sessionDiscounts.length
        : null,
      actual_line_discount_count: Array.isArray(lineDiscounts) ? lineDiscounts.length : null,
      actual_line_tax_count: Array.isArray(lineTaxes) ? lineTaxes.length : null,
      actual_mode: session.mode,
      actual_status: session.status,
      actual_payment_status: session.payment_status,
      actual_after_expiration_present: session.after_expiration !== null,
      actual_expiry_recovery_enabled: session.after_expiration?.recovery?.enabled ?? null,
      actual_expires_at: session.expires_at,
      actual_url: session.url,
    },
  }
}

async function handlePost(request: NextRequest, appOrigin: string) {
  let parsedBody: unknown
  try {
    parsedBody = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
      { status: 400 }
    )
  }
  if (!parsedBody || Array.isArray(parsedBody) || typeof parsedBody !== 'object') {
    return NextResponse.json(
      { error: 'Invalid request body', code: 'INVALID_REQUEST_BODY' },
      { status: 400 }
    )
  }

  const body = parsedBody as Record<string, unknown>
  const hasTrialChoice = Object.prototype.hasOwnProperty.call(body, 'trial')
  if (hasTrialChoice && typeof body.trial !== 'boolean') {
    return NextResponse.json(
      { error: 'Trial choice must be a boolean.', code: 'INVALID_TRIAL_CHOICE' },
      { status: 400 }
    )
  }

  const plan = body.plan
  if (plan !== 'monthly' && plan !== 'yearly' && plan !== 'lifetime') {
    return NextResponse.json({ error: 'Invalid plan type' }, { status: 400 })
  }
  if ((plan === 'monthly' || plan === 'yearly') && !hasTrialChoice) {
    return NextResponse.json(
      {
        error: 'Choose paid checkout or the free trial explicitly.',
        code: 'TRIAL_CHOICE_REQUIRED',
      },
      { status: 400 }
    )
  }
  if (plan === 'lifetime' && body.trial === true) {
    return NextResponse.json(
      { error: 'Lifetime checkout cannot include a trial.', code: 'INVALID_TRIAL_CHOICE' },
      { status: 400 }
    )
  }

  const successUrl = body.successUrl
  const cancelUrl = body.cancelUrl
  const promotionCode = body.promotionCode
  const trial = body.trial === true

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

    if (
      plan === 'lifetime' &&
      process.env.VERCEL_ENV === 'production' &&
      process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED !== 'true'
    ) {
      return NextResponse.json(
        {
          error: 'Lifetime checkout is temporarily unavailable.',
          code: 'LIFETIME_CHECKOUT_UNAVAILABLE',
        },
        { status: 503 }
      )
    }

    const { user, error: userError } = await extractUserFromRequest(request)

    const logger = createLogger('stripe-create-checkout')

    if (userError || !user) {
      logger.warn('Auth error', { error: userError })
      return NextResponse.json({ error: 'Unauthorized - Please login first' }, { status: 401 })
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

    try {
      await assertUserStripeBillingSurfaceAccess(user.id)
    } catch (error) {
      logger.error('Pro Checkout billing surface access was unavailable', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        { error: BILLING_SURFACE_UNAVAILABLE_MESSAGE },
        { status: 503, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
      )
    }

    const typedPlan = plan
    const recurringCheckout = typedPlan === 'monthly' || typedPlan === 'yearly'

    // Keep the local projection as an early safety signal for recurring Pro
    // checkout. Stripe is queried after exact Customer binding below because
    // this row can be stale or can omit non-active non-terminal states.
    const supabaseAdmin = getSupabaseAdmin()
    let localNonTerminalPro: {
      status: string
      tier: string
      stripe_subscription_id: string | null
    } | null = null
    if (recurringCheckout) {
      const { data: existingSub, error: existingSubError } = await supabaseAdmin
        .from('subscriptions')
        .select('status, tier, stripe_subscription_id')
        .eq('user_id', user.id)
        .in('status', ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused'])
        .maybeSingle()

      if (existingSubError) {
        logger.error('Existing Pro subscription lookup failed; checkout blocked', {
          userId: user.id,
          error: existingSubError.message,
        })
        return NextResponse.json(
          { error: 'Unable to verify subscription status. Please retry.' },
          { status: 503 }
        )
      }

      if (existingSub?.tier === 'pro' || existingSub?.tier === 'elite') {
        localNonTerminalPro = existingSub
      }
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

    const priceId = STRIPE_PRICE_IDS[typedPlan]
    try {
      assertStripePaymentRuntimeReady()
      if (recurringCheckout) {
        // Both recurring IDs participate in exact duplicate/trial
        // classification, so both contracts must be authoritative even when
        // this request buys only one of them.
        await Promise.all([
          assertProPriceReady('monthly', STRIPE_PRICE_IDS.monthly),
          assertProPriceReady('yearly', STRIPE_PRICE_IDS.yearly),
        ])
      } else {
        await assertProPriceReady(typedPlan, priceId)
      }
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

    const stripeLivemode = stripeSecretLivemode(env.STRIPE_SECRET_KEY)
    if (stripeLivemode === null) {
      logger.error('Stripe secret has no exact live/test identity')
      return NextResponse.json(
        { error: 'Payment system not configured. Please contact support.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
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

    // get/create/update responses are not fresh ownership attestations: a
    // stale helper response or a conflicting metadata write must not reach a
    // financial reservation. Retrieve the final object and bind its exact
    // mode plus all known user aliases before any Checkout admission RPC.
    let freshCustomer: Stripe.Customer | Stripe.DeletedCustomer
    try {
      freshCustomer = await getStripe().customers.retrieve(customerId)
    } catch (customerError) {
      logger.error('Fresh Stripe Customer ownership attestation was unavailable', {
        userId: user.id,
        customerId,
        error: customerError instanceof Error ? customerError.message : String(customerError),
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      )
    }
    if (
      !stripeCustomerIsExactlyOwned({
        value: freshCustomer,
        expectedCustomerId: customerId,
        expectedUserId: user.id,
        expectedLivemode: stripeLivemode,
      })
    ) {
      logger.error('Fresh Stripe Customer ownership attestation conflicted', {
        userId: user.id,
        customerId,
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    // Customer ownership is a financial identity, not a last-write-wins profile
    // field. The RPC serializes the user and Customer identities and performs a
    // compare-and-set against the profile value we read before Stripe lookup.
    const { data: customerLink, error: customerLinkError } = await supabaseAdmin.rpc(
      'bind_stripe_customer_owner_atomic',
      {
        p_user_id: user.id,
        p_new_stripe_customer_id: customerId,
        p_expected_previous_stripe_customer_id: billingProfile.stripe_customer_id,
      }
    )
    const customerLinkStatus = rpcRecord(customerLink)?.status
    if (
      customerLinkError ||
      (customerLinkStatus !== 'bound' && customerLinkStatus !== 'already_bound')
    ) {
      logger.error('Failed to bind exact Stripe customer owner; checkout blocked', {
        userId: user.id,
        status: customerLinkStatus,
        error: customerLinkError?.message,
      })
      return NextResponse.json(
        { error: 'Unable to prepare payment account. Please retry.' },
        { status: 503 }
      )
    }

    let stripeProSubscriptions: ProSubscriptionSnapshot[] = []
    let recurringTrialDays: 0 | 7 = 0
    let scanStripeProSubscriptions: (() => Promise<ProSubscriptionSnapshot[]>) | null = null
    if (recurringCheckout) {
      const proPriceIds = new Set([STRIPE_PRICE_IDS.monthly, STRIPE_PRICE_IDS.yearly])
      const apiPriceIds = new Set(
        Object.values(STRIPE_API_PRICE_IDS).filter(
          (configuredPriceId): configuredPriceId is string =>
            exactStripeIdentifier(configuredPriceId, stripePriceIdPattern)
        )
      )
      if (
        proPriceIds.size !== 2 ||
        [...proPriceIds].some(
          (configuredPriceId) => !exactStripeIdentifier(configuredPriceId, stripePriceIdPattern)
        ) ||
        [...apiPriceIds].some((configuredPriceId) => proPriceIds.has(configuredPriceId))
      ) {
        logger.error('Exact Pro subscription classification is not configured', {
          userId: user.id,
        })
        return NextResponse.json(
          { error: 'Unable to verify subscription status. Please retry.' },
          { status: 503 }
        )
      }

      const resolveHistoricalAuthority = async (
        subscription: Stripe.Subscription,
        historicalPrice: ExactRecurringPriceSnapshot
      ) => {
        const { data, error } = await supabaseAdmin.rpc('resolve_b2c_recurring_price_authority', {
          p_stripe_subscription_id: subscription.id,
          p_livemode: stripeLivemode,
          p_stripe_price_id: historicalPrice.priceId,
        })
        if (error) {
          throw new Error(`Historical Pro price authority failed: ${error.message}`)
        }
        const authority = rpcRecord(data)
        if (authority?.status === 'not_found') return
        const plan = authority?.plan ?? authority?.pro_plan
        if (
          authority?.status !== 'resolved' ||
          authority.user_id !== user.id ||
          authority.stripe_customer_id !== customerId ||
          authority.stripe_price_id !== historicalPrice.priceId ||
          !Number.isSafeInteger(authority.expected_amount) ||
          Number(authority.expected_amount) <= 0 ||
          authority.expected_amount !== historicalPrice.unitAmount ||
          typeof authority.currency !== 'string' ||
          !/^[a-z]{3}$/.test(authority.currency) ||
          authority.currency !== historicalPrice.currency ||
          (plan !== 'monthly' && plan !== 'yearly') ||
          (authority.plan !== undefined && authority.plan !== plan) ||
          (authority.pro_plan !== undefined && authority.pro_plan !== plan) ||
          (authority.source_kind !== 'converted_checkout_reservation' &&
            authority.source_kind !== 'verified_invoice_event')
        ) {
          throw new Error(`Historical Pro price authority for ${subscription.id} was uncertain`)
        }
      }
      scanStripeProSubscriptions = () =>
        listCompleteCustomerProSubscriptions({
          stripeClient: getStripe(),
          customerId,
          livemode: stripeLivemode,
          proPriceIds,
          apiPriceIds,
          resolveHistoricalAuthority,
        })

      try {
        stripeProSubscriptions = await scanStripeProSubscriptions()
      } catch (subscriptionError) {
        logger.error('Exact Stripe Pro subscription lookup failed; checkout blocked', {
          userId: user.id,
          customerId,
          error:
            subscriptionError instanceof Error
              ? subscriptionError.message
              : String(subscriptionError),
        })
        return NextResponse.json(
          { error: 'Unable to verify subscription status. Please retry.' },
          { status: 503 }
        )
      }

      const blockingSubscription = stripeProSubscriptions.find(({ subscription }) =>
        blockingProSubscriptionStatuses.has(subscription.status)
      )
      if (blockingSubscription) {
        return NextResponse.json(
          {
            error:
              'You already have a non-terminal subscription. Manage it from your account settings.',
            code: 'ALREADY_SUBSCRIBED',
          },
          { status: 409 }
        )
      }

      if (localNonTerminalPro) {
        const localStripeSubscriptionId = localNonTerminalPro.stripe_subscription_id
        const exactLocalProjection = localStripeSubscriptionId
          ? stripeProSubscriptions.find(
              ({ subscription }) => subscription.id === localStripeSubscriptionId
            )
          : null
        if (!exactLocalProjection) {
          logger.error('Local Pro subscription projection has no exact Stripe authority', {
            userId: user.id,
            localStatus: localNonTerminalPro.status,
            stripeSubscriptionId: localNonTerminalPro.stripe_subscription_id,
          })
          return NextResponse.json(
            { error: 'Unable to verify subscription status. Please retry.' },
            { status: 503 }
          )
        }
        logger.warn('Local Pro subscription projection is stale and Stripe-terminal', {
          userId: user.id,
          localStatus: localNonTerminalPro.status,
          stripeSubscriptionId: exactLocalProjection.subscription.id,
          stripeStatus: exactLocalProjection.subscription.status,
        })
        return NextResponse.json(
          { error: 'Unable to verify subscription status. Please retry.' },
          { status: 503 }
        )
      }

      if (trial) {
        // Only exact monthly/yearly Stripe history consumes this B2C trial.
        // API-tier and unrelated subscriptions were filtered out above.
        const alreadyTrialed = stripeProSubscriptions.some(
          ({ subscription }) => subscription.trial_start != null || subscription.trial_end != null
        )
        if (alreadyTrialed) return recurringTrialAlreadyUsed()
        recurringTrialDays = 7
      }
    }

    const meta = {
      supabase_user_id: user.id,
      userId: user.id,
      plan: plan,
    }

    // Validate redirect URLs to prevent open redirect attacks
    const defaultSuccessUrl = `${appOrigin}/pricing/success?session_id={CHECKOUT_SESSION_ID}`
    const defaultCancelUrl = `${appOrigin}/pricing`

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
      if (!exactStripeIdentifier(priceId, stripePriceIdPattern)) {
        throw new Error(
          `Invalid Stripe price ID for lifetime: "${priceId}". Please configure STRIPE_PRO_LIFETIME_PRICE_ID.`
        )
      }

      // The reservation row, rather than a transaction-scoped pre-check, holds
      // one of the 200 seats while the buyer is on Stripe Checkout. The stable
      // minute nonce also makes a double-click reuse the same reservation.
      const requestNonce = `lifetime:${user.id}:${Math.floor(Date.now() / 60_000)}`
      const { data: reservationData, error: reservationError } = await supabaseAdmin.rpc(
        'reserve_lifetime_membership_spot_atomic',
        {
          p_user_id: user.id,
          p_request_nonce: requestNonce,
          p_ttl_seconds: LIFETIME_RESERVATION_TTL_SECONDS,
          p_livemode: stripeLivemode,
        }
      )
      const reservation = rpcRecord(reservationData)
      const reservationStatus = reservation?.status
      if (reservationError) {
        logger.error('Lifetime seat reservation failed', {
          userId: user.id,
          error: reservationError.message,
        })
        return NextResponse.json(
          { error: 'Unable to reserve a founding member spot. Please retry.' },
          { status: 503 }
        )
      }
      if (reservationStatus === 'sold_out') {
        return NextResponse.json(
          { error: 'All founding member spots have been claimed.' },
          { status: 410 }
        )
      }
      if (reservationStatus === 'already_entitled' || reservationStatus === 'already_converted') {
        return NextResponse.json(
          {
            error: 'You already have lifetime access.',
            code: 'ALREADY_SUBSCRIBED',
          },
          { status: 409 }
        )
      }
      if (
        reservationStatus !== 'reserved' &&
        reservationStatus !== 'already_reserved' &&
        reservationStatus !== 'reservation_exists'
      ) {
        logger.error('Lifetime seat reservation returned an unsafe status', {
          userId: user.id,
          status: reservationStatus,
        })
        return NextResponse.json(
          { error: 'Unable to reserve a founding member spot. Please retry.' },
          { status: 503 }
        )
      }

      const reservationId =
        typeof reservation?.reservation_id === 'string' ? reservation.reservation_id : null
      const canonicalReservationId =
        reservationId && uuidPattern.test(reservationId) ? reservationId.toLowerCase() : null
      const checkoutExpiresAt =
        typeof reservation?.checkout_expires_at === 'string'
          ? Date.parse(reservation.checkout_expires_at)
          : Number.NaN
      const checkoutExpiresAtSeconds = Math.floor(checkoutExpiresAt / 1000)
      if (
        !canonicalReservationId ||
        !Number.isSafeInteger(checkoutExpiresAtSeconds) ||
        checkoutExpiresAtSeconds <= Math.floor(Date.now() / 1000)
      ) {
        logger.error('Lifetime seat reservation returned incomplete identity', {
          userId: user.id,
          status: reservationStatus,
        })
        return NextResponse.json(
          { error: 'Unable to reserve a founding member spot. Please retry.' },
          { status: 503 }
        )
      }

      const recordRecoveryReview = async (params: {
        sessionId?: string | null
        reason: string
        context: Json
      }) => {
        try {
          await recordStripeCheckoutManualReview({
            supabase: supabaseAdmin,
            objectType: params.sessionId ? 'checkout_session' : 'lifetime_reservation',
            sessionId: params.sessionId || canonicalReservationId,
            userId: user.id,
            reasonKey: 'lifetime_checkout_recovery_identity_conflict',
            reason: params.reason,
            context: params.context,
          })
        } catch (reviewError) {
          logger.error('Failed to persist lifetime checkout recovery review', {
            userId: user.id,
            reservationId: canonicalReservationId,
            sessionId: params.sessionId,
            error: reviewError instanceof Error ? reviewError.message : String(reviewError),
          })
        }
      }

      let effectiveRequestNonce = requestNonce
      const durableReservationStatus =
        typeof reservation?.reservation_status === 'string'
          ? reservation.reservation_status
          : 'reserved'

      if (reservationStatus === 'reservation_exists') {
        const originalRequestNonce =
          typeof reservation?.request_nonce === 'string' ? reservation.request_nonce : null
        if (!originalRequestNonce || !reservationNoncePattern.test(originalRequestNonce)) {
          await recordRecoveryReview({
            reason: 'An existing lifetime reservation omitted its original request nonce.',
            context: {
              reservation_id: canonicalReservationId,
              reservation_status: durableReservationStatus,
              returned_request_nonce: originalRequestNonce,
            },
          })
          return NextResponse.json(
            { error: 'Unable to recover lifetime checkout. Please retry later.' },
            { status: 503 }
          )
        }
        effectiveRequestNonce = originalRequestNonce
      }

      if (durableReservationStatus === 'bound') {
        const existingSessionId =
          typeof reservation?.checkout_session_id === 'string'
            ? reservation.checkout_session_id
            : null
        if (!exactStripeIdentifier(existingSessionId, stripeSessionIdPattern)) {
          await recordRecoveryReview({
            sessionId: existingSessionId,
            reason: 'A bound lifetime reservation omitted its Checkout Session identity.',
            context: {
              reservation_id: canonicalReservationId,
              reservation_status: durableReservationStatus,
              checkout_session_id: existingSessionId,
            },
          })
          return NextResponse.json(
            { error: 'Unable to recover lifetime checkout. Please retry later.' },
            { status: 503 }
          )
        }

        let recoveredVerification: LifetimeSessionVerification
        try {
          recoveredVerification = await verifyFreshLifetimeSession({
            stripeClient: getStripe(),
            sessionId: existingSessionId,
            userId: user.id,
            customerId,
            reservationId: canonicalReservationId,
            requestNonce: effectiveRequestNonce,
            checkoutExpiresAtSeconds,
            priceId,
          })
        } catch (retrieveError) {
          logger.error('Failed to verify bound lifetime Checkout Session', {
            userId: user.id,
            reservationId: canonicalReservationId,
            sessionId: existingSessionId,
            error: retrieveError instanceof Error ? retrieveError.message : String(retrieveError),
          })
          return NextResponse.json(
            { error: 'Unable to recover lifetime checkout. Please retry.' },
            { status: 503 }
          )
        }

        if (!recoveredVerification.ok) {
          try {
            await getStripe().checkout.sessions.expire(existingSessionId)
          } catch (expireError) {
            logger.error('Failed to expire mismatched recovered lifetime Checkout Session', {
              sessionId: existingSessionId,
              error: expireError instanceof Error ? expireError.message : String(expireError),
            })
          }
          await recordRecoveryReview({
            sessionId: existingSessionId,
            reason: recoveredVerification.reason,
            context: {
              reservation_id: canonicalReservationId,
              expected_request_nonce: effectiveRequestNonce,
              ...recoveredVerification.context,
            },
          })
          return NextResponse.json(
            { error: 'Unable to recover lifetime checkout. Please retry later.' },
            { status: 503 }
          )
        }
        const recoveredSession = recoveredVerification.session

        return NextResponse.json({
          url: recoveredSession.url,
          sessionId: recoveredSession.id,
        })
      }

      if (durableReservationStatus !== 'reserved') {
        await recordRecoveryReview({
          reason: 'An existing lifetime reservation had no recoverable checkout state.',
          context: {
            reservation_id: canonicalReservationId,
            reservation_status: durableReservationStatus,
          },
        })
        return NextResponse.json(
          { error: 'Unable to recover lifetime checkout. Please retry later.' },
          { status: 503 }
        )
      }

      const lifetimeMeta = {
        ...meta,
        [LIFETIME_RESERVATION_ID_METADATA_KEY]: canonicalReservationId,
        [LIFETIME_RESERVATION_NONCE_METADATA_KEY]: effectiveRequestNonce,
      }

      // payment_method_types: card + link. Apple Pay / Google Pay are enabled
      // automatically via Stripe's card payment method when configured in Dashboard.
      // The Stripe idempotency key is the durable reservation identity, so an
      // HTTP retry cannot create a second payable Session for the same seat.
      try {
        checkoutSession = await getStripe().checkout.sessions.create(
          {
            customer: customerId,
            payment_method_types: ['card', 'link'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: sUrl,
            cancel_url: cUrl,
            metadata: lifetimeMeta,
            payment_intent_data: { metadata: lifetimeMeta },
            expires_at: checkoutExpiresAtSeconds,
            allow_promotion_codes: false,
            automatic_tax: { enabled: false },
            adaptive_pricing: { enabled: false },
            billing_address_collection: 'auto',
            locale: 'auto',
          },
          {
            idempotencyKey: `checkout_lifetime_${canonicalReservationId}`,
          }
        )
      } catch (createError) {
        // No Stripe error class proves that this exact reservation never
        // created (or concurrently recovered) a Session. Preserve it for exact
        // idempotent recovery and signed expiry remediation.
        logger.warn('Lifetime Checkout creation failed; reservation preserved', {
          userId: user.id,
          reservationId: canonicalReservationId,
          error: createError instanceof Error ? createError.message : String(createError),
        })
        throw createError
      }

      let createdVerification: LifetimeSessionVerification
      try {
        createdVerification = await verifyFreshLifetimeSession({
          stripeClient: getStripe(),
          sessionId: checkoutSession.id,
          userId: user.id,
          customerId,
          reservationId: canonicalReservationId,
          requestNonce: effectiveRequestNonce,
          checkoutExpiresAtSeconds,
          priceId,
        })
      } catch (verificationError) {
        logger.error('Failed to verify freshly created lifetime Checkout Session', {
          userId: user.id,
          reservationId: canonicalReservationId,
          sessionId: checkoutSession.id,
          error:
            verificationError instanceof Error
              ? verificationError.message
              : String(verificationError),
        })
        return NextResponse.json(
          { error: 'Unable to prepare lifetime checkout. Please retry.' },
          { status: 503 }
        )
      }

      if (!createdVerification.ok) {
        if (exactStripeIdentifier(checkoutSession.id, stripeSessionIdPattern)) {
          try {
            await getStripe().checkout.sessions.expire(checkoutSession.id)
          } catch (expireError) {
            logger.error('Failed to expire lifetime Session with mismatched identity', {
              sessionId: checkoutSession.id,
              error: expireError instanceof Error ? expireError.message : String(expireError),
            })
          }
        }
        await recordRecoveryReview({
          sessionId: checkoutSession.id,
          reason: createdVerification.reason,
          context: {
            reservation_id: canonicalReservationId,
            expected_request_nonce: effectiveRequestNonce,
            ...createdVerification.context,
          },
        })
        // Once Stripe returned a Session identity, never release its seat from
        // this unsigned request path. Even a failed expire call can leave a
        // payable Session alive. The signed checkout.session.expired event
        // releases the exact reservation; otherwise its lease remains held
        // until the common Stripe/DB expiry boundary.
        return NextResponse.json(
          { error: 'Unable to prepare lifetime checkout. Please retry.' },
          { status: 503 }
        )
      }
      checkoutSession = createdVerification.session

      const sessionExpiresAt = checkoutExpiresAtSeconds
      const { data: bindingData, error: bindingError } = await supabaseAdmin.rpc(
        'bind_lifetime_membership_reservation_session_atomic',
        {
          p_user_id: user.id,
          p_reservation_id: canonicalReservationId,
          p_request_nonce: effectiveRequestNonce,
          p_checkout_session_id: checkoutSession.id,
          p_session_expires_at: new Date(sessionExpiresAt * 1000).toISOString(),
          p_livemode: stripeLivemode,
        }
      )
      const bindingStatus = rpcRecord(bindingData)?.status
      if (bindingError || (bindingStatus !== 'bound' && bindingStatus !== 'already_bound')) {
        // Do not hand an unbound payable Session to the client. Expiring it
        // closes the payment surface; the signed expired webhook performs the
        // exact release if the bind committed but its response was lost.
        try {
          await getStripe().checkout.sessions.expire(checkoutSession.id)
        } catch (expireError) {
          logger.error('Failed to expire unbound lifetime Checkout Session', {
            sessionId: checkoutSession.id,
            error: expireError instanceof Error ? expireError.message : String(expireError),
          })
        }
        // The bind may have committed even when its response did not arrive.
        // Preserve the seat until Stripe's signed expired event proves this
        // exact Session is no longer payable.
        logger.error('Lifetime Checkout Session reservation bind failed', {
          userId: user.id,
          reservationId: canonicalReservationId,
          sessionId: checkoutSession.id,
          status: bindingStatus,
          error: bindingError?.message,
        })
        return NextResponse.json(
          { error: 'Unable to prepare lifetime checkout. Please retry.' },
          { status: 503 }
        )
      }
    } else {
      // 月付 / 年付订阅。The database reservation is the admission
      // authority across processes; Stripe scans above remain a second,
      // external duplicate check but no longer carry the concurrency burden.
      const recurringPlan = typedPlan as RecurringProPlan
      const recurringUnitAmount = Math.round(PRICING[recurringPlan].price * 100)
      const recurringCurrency = 'usd' as const
      const livemode = stripeLivemode
      if (!exactStripeIdentifier(customerId, stripeCustomerIdPattern)) {
        logger.error('Recurring Pro checkout runtime identity is not exact', {
          userId: user.id,
          customerId,
        })
        return recurringCheckoutUnavailable()
      }

      let reservationData: unknown
      let reservationError: { message?: string } | null
      try {
        const result = await supabaseAdmin.rpc('reserve_pro_membership_checkout_atomic', {
          p_user_id: user.id,
          p_livemode: livemode,
          p_stripe_customer_id: customerId,
          p_pro_plan: recurringPlan,
          p_stripe_price_id: priceId,
          p_unit_amount: recurringUnitAmount,
          p_currency: recurringCurrency,
          p_trial_days: recurringTrialDays,
          p_success_url: sUrl,
          p_cancel_url: cUrl,
        })
        reservationData = result.data
        reservationError = result.error
      } catch (error) {
        logger.error('Atomic Pro Checkout reservation was unavailable', {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return recurringCheckoutUnavailable()
      }
      if (reservationError) {
        logger.error('Atomic Pro Checkout reservation failed', {
          userId: user.id,
          error: reservationError.message,
        })
        return recurringCheckoutUnavailable()
      }
      if (rpcRecord(reservationData)?.status === 'already_subscribed') {
        return NextResponse.json(
          {
            error:
              'You already have a non-terminal subscription. Manage it from your account settings.',
            code: 'ALREADY_SUBSCRIBED',
          },
          { status: 409, headers: { 'Cache-Control': 'no-store' } }
        )
      }
      if (rpcRecord(reservationData)?.status === 'trial_already_used') {
        return recurringTrialAlreadyUsed()
      }

      const reservation = parseProCheckoutReservation(reservationData)
      if (!reservation) {
        logger.error('Atomic Pro Checkout reservation returned uncertain identity', {
          userId: user.id,
        })
        return recurringCheckoutUnavailable()
      }
      if (
        reservation.unitAmount !== recurringUnitAmount ||
        reservation.currency !== recurringCurrency ||
        !hasExactOrigin(reservation.successUrl, appOrigin) ||
        !hasExactOrigin(reservation.cancelUrl, appOrigin)
      ) {
        logger.error('Pro Checkout reservation returned unsafe durable product identity', {
          userId: user.id,
          reservationId: reservation.reservationId,
        })
        return recurringCheckoutUnavailable()
      }

      const proMetadata: Record<(typeof PRO_CHECKOUT_METADATA_KEYS)[number], string> = {
        supabase_user_id: user.id,
        userId: user.id,
        currency: reservation.currency,
        type: 'pro_membership',
        plan: reservation.plan,
        [PRO_MEMBERSHIP_RESERVATION_METADATA_KEY]: reservation.reservationId,
        [PRO_MEMBERSHIP_PRICE_METADATA_KEY]: reservation.priceId,
        trial_days: String(reservation.trialDays),
        unit_amount: String(reservation.unitAmount),
      }

      if (reservation.checkoutExpiresAtSeconds <= Math.floor(Date.now() / 1000)) {
        try {
          const recovery = await recoverExpiredProCheckoutReservation({
            stripeClient: getStripe(),
            supabaseAdmin,
            reservation,
            userId: user.id,
            customerId,
            livemode,
            metadata: proMetadata,
          })
          if (recovery === 'released' || recovery === 'converted') {
            return NextResponse.json(
              {
                error: 'A previous checkout was safely reconciled. Please retry your selection.',
                code: 'PRO_CHECKOUT_RECOVERED',
              },
              { status: 409, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
            )
          }
        } catch (error) {
          logger.error('Expired Pro Checkout recovery remained uncertain', {
            userId: user.id,
            reservationId: reservation.reservationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return recurringCheckoutUnavailable()
      }
      if (
        reservation.status === 'existing' &&
        (reservation.plan !== recurringPlan ||
          reservation.priceId !== priceId ||
          reservation.trialDays !== recurringTrialDays ||
          reservation.successUrl !== sUrl ||
          reservation.cancelUrl !== cUrl)
      ) {
        if (trial && reservation.trialDays !== 7) return recurringTrialAlreadyUsed()
        return recurringCheckoutConflict()
      }
      if (trial && reservation.trialDays !== 7) {
        return recurringTrialAlreadyUsed()
      }
      if (
        reservation.plan !== recurringPlan ||
        reservation.priceId !== priceId ||
        reservation.trialDays !== recurringTrialDays ||
        reservation.successUrl !== sUrl ||
        reservation.cancelUrl !== cUrl
      ) {
        logger.error('New Pro Checkout reservation did not match the requested product', {
          userId: user.id,
          reservationId: reservation.reservationId,
        })
        return recurringCheckoutUnavailable()
      }

      let sessionId = reservation.checkoutSessionId
      if (!sessionId) {
        try {
          const created = await createCheckoutSession({
            customerId,
            priceId: reservation.priceId,
            successUrl: reservation.successUrl,
            cancelUrl: reservation.cancelUrl,
            metadata: proMetadata,
            allowPromotionCodes: false,
            ...(reservation.trialDays === 7 ? { trialDays: 7 } : {}),
            idempotencyKey: `pro_membership_checkout_${livemode ? 'live' : 'test'}_${reservation.reservationId}`,
            expiresAt: reservation.checkoutExpiresAtSeconds,
            clientReferenceId: reservation.reservationId,
          })
          sessionId = created.id
        } catch (error) {
          // No Stripe transport/error class proves the Session was not
          // committed. Preserve the reservation and retry this stable UUID.
          logger.warn('Stripe Pro Checkout create was ambiguous; reservation preserved', {
            userId: user.id,
            reservationId: reservation.reservationId,
            error: error instanceof Error ? error.message : String(error),
          })
          return recurringCheckoutUnavailable()
        }
      }

      let verification: ProSessionVerification
      try {
        verification = await verifyFreshProCheckoutSession({
          stripeClient: getStripe(),
          sessionId,
          userId: user.id,
          customerId,
          livemode,
          reservation,
          metadata: proMetadata,
        })
      } catch (error) {
        // Retrieval/pagination failure cannot distinguish an unsafe Session
        // from a temporary Stripe read failure. Keep both durable identities.
        logger.error('Fresh Pro Checkout verification was unavailable', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
        return recurringCheckoutUnavailable()
      }
      if (!verification.ok) {
        if (verification.safeToExpire) {
          await expireProCheckoutSessionBestEffort(
            sessionId,
            logger,
            'pro_checkout_exact_verification_failed'
          )
        }
        logger.error('Stripe returned an unsafe Pro Checkout Session; URL withheld', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId,
          safeToExpire: verification.safeToExpire,
          reason: verification.reason,
        })
        return recurringCheckoutUnavailable()
      }

      // Close the long Stripe-create/verification window with a second fresh
      // Customer attestation and full Subscription scan. The bind RPC
      // separately repeats local authority checks under its transaction
      // locks; none of these snapshots is sufficient on its own.
      let preBindCustomer: Stripe.Customer | Stripe.DeletedCustomer
      try {
        preBindCustomer = await getStripe().customers.retrieve(customerId)
      } catch (error) {
        logger.error('Pre-bind Stripe Customer attestation was unavailable', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: verification.session.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return recurringCheckoutUnavailable()
      }
      if (
        !stripeCustomerIsExactlyOwned({
          value: preBindCustomer,
          expectedCustomerId: customerId,
          expectedUserId: user.id,
          expectedLivemode: livemode,
        })
      ) {
        await expireProCheckoutSessionBestEffort(
          verification.session.id,
          logger,
          'pro_checkout_customer_authority_changed_before_bind'
        )
        logger.error('Pre-bind Stripe Customer ownership attestation conflicted', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: verification.session.id,
        })
        return recurringCheckoutUnavailable()
      }

      let preBindSubscriptions: ProSubscriptionSnapshot[]
      try {
        if (!scanStripeProSubscriptions) {
          throw new Error('Recurring Pro subscription scanner was not initialized')
        }
        preBindSubscriptions = await scanStripeProSubscriptions()
      } catch (error) {
        logger.error('Pre-bind Stripe Pro subscription verification was unavailable', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: verification.session.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return recurringCheckoutUnavailable()
      }
      const preBindBlocking = preBindSubscriptions.some(({ subscription }) =>
        blockingProSubscriptionStatuses.has(subscription.status)
      )
      const preBindTrialConflict =
        reservation.trialDays === 7 &&
        preBindSubscriptions.some(
          ({ subscription }) => subscription.trial_start !== null || subscription.trial_end !== null
        )
      if (preBindBlocking || preBindTrialConflict) {
        await expireProCheckoutSessionBestEffort(
          verification.session.id,
          logger,
          preBindBlocking
            ? 'pro_checkout_remote_authority_appeared_before_bind'
            : 'pro_checkout_trial_history_appeared_before_bind'
        )
        if (preBindTrialConflict && !preBindBlocking) {
          return recurringTrialAlreadyUsed()
        }
        return NextResponse.json(
          {
            error:
              'You already have a non-terminal subscription. Manage it from your account settings.',
            code: 'ALREADY_SUBSCRIBED',
          },
          { status: 409 }
        )
      }

      let bindResult:
        | {
            data: unknown
            error: { code?: string; message?: string } | null
            status?: number
          }
        | undefined
      try {
        bindResult = await supabaseAdmin.rpc('bind_pro_membership_checkout_session_atomic', {
          p_reservation_id: reservation.reservationId,
          p_user_id: user.id,
          p_livemode: livemode,
          p_stripe_customer_id: customerId,
          p_pro_plan: reservation.plan,
          p_stripe_price_id: reservation.priceId,
          p_unit_amount: reservation.unitAmount,
          p_currency: reservation.currency,
          p_trial_days: reservation.trialDays,
          p_checkout_session_id: verification.session.id,
          p_checkout_expires_at: reservation.checkoutExpiresAtSeconds,
        })
      } catch (error) {
        logger.error('Pro Checkout bind outcome was uncertain; Session preserved', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: verification.session.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return recurringCheckoutUnavailable()
      }

      const bindStatus = rpcRecord(bindResult.data)?.status
      const explicitRejection =
        bindResult.error !== null &&
        typeof bindResult.error.code === 'string' &&
        bindResult.error.code.length > 0 &&
        typeof bindResult.status === 'number' &&
        bindResult.status >= 400 &&
        bindResult.status < 600
      if (explicitRejection) {
        await expireProCheckoutSessionBestEffort(
          verification.session.id,
          logger,
          'pro_checkout_bind_explicitly_rejected'
        )
      }
      if (
        bindResult.error ||
        (bindStatus !== 'bound' && bindStatus !== 'already_bound' && bindStatus !== 'converted')
      ) {
        logger.error('Pro Checkout bind was not durably acknowledged; URL withheld', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: verification.session.id,
          status: bindStatus,
          explicitRejection,
          error: bindResult.error?.message,
        })
        return recurringCheckoutUnavailable()
      }

      checkoutSession = verification.session
    }

    return NextResponse.json(
      {
        url: checkoutSession.url,
        sessionId: checkoutSession.id,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    )
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

export async function POST(request: NextRequest) {
  // This endpoint uses browser cookies and creates a durable financial
  // reservation. Reject ambient cross-site POSTs before rate limiting, auth,
  // database reads, or Stripe calls; an unreadable response would still let a
  // CSRF request occupy the reservation for 45 minutes.
  const appOrigin = configuredApplicationOrigin()
  if (!appOrigin) {
    return NextResponse.json(
      { error: 'Payment system not configured. Please contact support.' },
      { status: 503, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    )
  }
  if (
    request.headers.get('origin') !== appOrigin ||
    request.headers.get('sec-fetch-site') !== 'same-origin'
  ) {
    return NextResponse.json(
      { error: 'Invalid request origin', code: 'INVALID_REQUEST_ORIGIN' },
      { status: 403, headers: { 'Cache-Control': PRIVATE_NO_STORE } }
    )
  }

  const response = await handlePost(request, appOrigin)
  // POST is usually not cached, but Checkout URLs and subscription state are
  // too sensitive to leave to proxy/browser heuristics.
  response.headers.set('Cache-Control', PRIVATE_NO_STORE)
  return response
}
