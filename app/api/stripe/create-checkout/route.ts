import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { randomUUID } from 'node:crypto'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_PRICE_IDS,
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
import type { Json } from '@/lib/supabase/database.types'
import {
  buildRecurringProCheckoutMetadata,
  callRecurringProRpc,
  exactCanonicalUuid,
  parseRecurringProReservation,
  recurringProRpcStatus,
  verifyRecurringProCheckoutSession,
  type RecurringProPlan,
} from '@/lib/stripe/recurring-pro-checkout'

const LIFETIME_RESERVATION_TTL_SECONDS = 60 * 60
const LIFETIME_PRICE_CENTS = Math.round(PRICING.lifetime.price * 100)
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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

function recurringProCheckoutWriterIsOpen(): boolean {
  if (env.PRO_CHECKOUT_WRITER_MODE !== 'sealed') return false
  const productionRuntime =
    process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
  if (!productionRuntime) return true

  const expectedSha = env.PRO_CHECKOUT_WRITER_SHA?.trim().toLowerCase() ?? ''
  const runtimeSha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').trim().toLowerCase()
  return (
    FULL_GIT_SHA_PATTERN.test(expectedSha) &&
    FULL_GIT_SHA_PATTERN.test(runtimeSha) &&
    expectedSha === runtimeSha
  )
}

function recurringProCheckoutWriterClosed() {
  return NextResponse.json(
    {
      error: 'Pro checkout is temporarily paused for a billing upgrade. Please retry shortly.',
      code: 'PRO_CHECKOUT_WRITER_CLOSED',
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '60',
        'X-Arena-Pro-Checkout-Writer': 'closed',
      },
    }
  )
}

function stripeSecretLivemode(secret: string): boolean | null {
  const canonical = secret.trim()
  if (canonical.startsWith('sk_live_')) return true
  if (canonical.startsWith('sk_test_')) return false
  return null
}

function recurringCheckoutConflict(code = 'PRO_CHECKOUT_CONFLICT') {
  return NextResponse.json(
    {
      error:
        'Another Pro checkout or subscription is already in progress. Finish it or retry after it expires.',
      code,
    },
    {
      status: 409,
      headers: { 'Cache-Control': 'no-store' },
    }
  )
}

function recurringCheckoutUnavailable() {
  return NextResponse.json(
    { error: 'Unable to prepare Pro checkout. Please retry.' },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '30',
      },
    }
  )
}

function rpcRecord(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
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

function checkoutLinePriceId(line: Stripe.LineItem): string | null {
  return line.price?.id || null
}

function isEmptyOptionalStripeCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

async function listCompleteCheckoutLineItems(
  stripeClient: Stripe,
  sessionId: string
): Promise<Stripe.LineItem[]> {
  const lines: Stripe.LineItem[] = []
  const seenLineIds = new Set<string>()
  let startingAfter: string | undefined

  while (true) {
    const page = await stripeClient.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error('Stripe Checkout line-item pagination returned an invalid page')
    }
    if (startingAfter && page.data.length === 0) {
      throw new Error('Stripe Checkout line-item pagination returned an empty continuation page')
    }
    for (const line of page.data) {
      if (!line.id?.startsWith('li_') || line.object !== 'item' || seenLineIds.has(line.id)) {
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
  if (!params.sessionId.startsWith('cs_')) {
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
    session.id.startsWith('cs_') &&
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

function subscriptionItemPriceId(item: Stripe.SubscriptionItem): string | null {
  return item.price?.id || null
}

async function completeSubscriptionPriceIds(
  stripeClient: Stripe,
  subscription: Stripe.Subscription
): Promise<string[]> {
  if (!subscription.items || !Array.isArray(subscription.items.data)) {
    throw new Error(`Stripe subscription ${subscription.id} omitted its item list`)
  }
  if (typeof subscription.items.has_more !== 'boolean') {
    throw new Error(`Stripe subscription ${subscription.id} returned an invalid item page`)
  }

  const priceIds: string[] = []
  const seenItemIds = new Set<string>()
  const appendItems = (items: Stripe.SubscriptionItem[]) => {
    for (const item of items) {
      if (
        !item.id?.startsWith('si_') ||
        seenItemIds.has(item.id) ||
        stripeId(item.subscription) !== subscription.id
      ) {
        throw new Error(`Stripe subscription ${subscription.id} returned uncertain item identity`)
      }
      const priceId = subscriptionItemPriceId(item)
      if (!priceId?.startsWith('price_')) {
        throw new Error(`Stripe subscription ${subscription.id} returned an invalid price identity`)
      }
      seenItemIds.add(item.id)
      priceIds.push(priceId)
    }
  }

  appendItems(subscription.items.data)
  let hasMore = subscription.items.has_more
  let startingAfter = subscription.items.data.at(-1)?.id
  const seenCursors = new Set<string>()
  if (hasMore && !startingAfter) {
    throw new Error(`Stripe subscription ${subscription.id} item pagination did not advance`)
  }

  while (hasMore) {
    if (!startingAfter || seenCursors.has(startingAfter)) {
      throw new Error(`Stripe subscription ${subscription.id} item pagination did not advance`)
    }
    seenCursors.add(startingAfter)
    const page = await stripeClient.subscriptionItems.list({
      subscription: subscription.id,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error(`Stripe subscription ${subscription.id} returned an invalid item page`)
    }
    if (page.data.length === 0) {
      throw new Error(`Stripe subscription ${subscription.id} returned an empty item continuation`)
    }
    appendItems(page.data)
    if (!page.has_more) break

    const lastItem = page.data.at(-1)
    if (!lastItem?.id || lastItem.id === startingAfter) {
      throw new Error(`Stripe subscription ${subscription.id} item pagination did not advance`)
    }
    startingAfter = lastItem.id
    hasMore = page.has_more
  }

  if (priceIds.length === 0) {
    throw new Error(`Stripe subscription ${subscription.id} has no classifiable price`)
  }
  return priceIds
}

type ProSubscriptionSnapshot = {
  subscription: Stripe.Subscription
  priceIds: string[]
}

async function listCompleteCustomerProSubscriptions(params: {
  stripeClient: Stripe
  customerId: string
  proPriceIds: ReadonlySet<string>
}): Promise<ProSubscriptionSnapshot[]> {
  const snapshots: ProSubscriptionSnapshot[] = []
  const seenSubscriptionIds = new Set<string>()
  let startingAfter: string | undefined

  while (true) {
    const page = await params.stripeClient.subscriptions.list({
      customer: params.customerId,
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error('Stripe customer subscription pagination returned an invalid page')
    }
    if (startingAfter && page.data.length === 0) {
      throw new Error('Stripe customer subscription pagination returned an empty continuation page')
    }

    for (const subscription of page.data) {
      if (
        !subscription.id?.startsWith('sub_') ||
        seenSubscriptionIds.has(subscription.id) ||
        stripeId(subscription.customer) !== params.customerId
      ) {
        throw new Error('Stripe customer subscription pagination returned uncertain identity')
      }
      seenSubscriptionIds.add(subscription.id)
      if (
        !blockingProSubscriptionStatuses.has(subscription.status) &&
        !terminalProSubscriptionStatuses.has(subscription.status)
      ) {
        throw new Error(`Stripe subscription ${subscription.id} returned an unknown status`)
      }
      const priceIds = await completeSubscriptionPriceIds(params.stripeClient, subscription)
      if (priceIds.some((priceId) => params.proPriceIds.has(priceId))) {
        snapshots.push({ subscription, priceIds })
      }
    }

    if (!page.has_more) return snapshots
    const lastSubscription = page.data.at(-1)
    if (!lastSubscription?.id || lastSubscription.id === startingAfter) {
      throw new Error('Stripe customer subscription pagination did not advance')
    }
    startingAfter = lastSubscription.id
  }
}

export async function POST(request: NextRequest) {
  let plan: string,
    successUrl: string | undefined,
    cancelUrl: string | undefined,
    promotionCode: string | undefined,
    trial: boolean | undefined,
    requestedOperationId: unknown
  try {
    const body = await request.json()
    plan = body.plan
    successUrl = body.successUrl
    cancelUrl = body.cancelUrl
    promotionCode = body.promotionCode
    trial = body.trial === true
    requestedOperationId = body.operationId
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body', code: 'INVALID_JSON' },
      { status: 400 }
    )
  }

  // Parsing the product is side-effect free. The production writer gate then
  // runs before rate limiting, auth, database access, Customer lookup, or any
  // Stripe call, and is sealed to one exact full deployment SHA.
  const recurringPlanRequested = plan === 'monthly' || plan === 'yearly'
  if (recurringPlanRequested && !recurringProCheckoutWriterIsOpen()) {
    return recurringProCheckoutWriterClosed()
  }

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

    const typedPlan = plan as 'monthly' | 'yearly' | 'lifetime'
    const recurringCheckout = typedPlan === 'monthly' || typedPlan === 'yearly'
    const operationId = recurringCheckout
      ? requestedOperationId === undefined
        ? randomUUID()
        : exactCanonicalUuid(requestedOperationId)
      : null
    if (recurringCheckout && !operationId) {
      return NextResponse.json(
        {
          error: 'Invalid Pro checkout operation identity.',
          code: 'INVALID_CHECKOUT_OPERATION',
        },
        { status: 400 }
      )
    }

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
    if (recurringCheckout) {
      const proPriceIds = new Set([STRIPE_PRICE_IDS.monthly, STRIPE_PRICE_IDS.yearly])
      if (
        proPriceIds.size !== 2 ||
        [...proPriceIds].some((configuredPriceId) => !configuredPriceId?.startsWith('price_'))
      ) {
        logger.error('Exact Pro subscription classification is not configured', {
          userId: user.id,
        })
        return NextResponse.json(
          { error: 'Unable to verify subscription status. Please retry.' },
          { status: 503 }
        )
      }

      try {
        stripeProSubscriptions = await listCompleteCustomerProSubscriptions({
          stripeClient: getStripe(),
          customerId,
          proPriceIds,
        })
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
        if (!existingSessionId?.startsWith('cs_')) {
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
        if (checkoutSession.id.startsWith('cs_')) {
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
      const recurringPlan = typedPlan as RecurringProPlan
      if (!operationId) {
        throw new Error('Recurring Pro checkout operation identity unexpectedly became incomplete')
      }
      const livemode = stripeSecretLivemode(env.STRIPE_SECRET_KEY)
      if (livemode === null) return recurringCheckoutUnavailable()

      let trialRequested = false
      if (trial) {
        const alreadyTrialed = stripeProSubscriptions.some(
          ({ subscription }) => subscription.trial_start != null || subscription.trial_end != null
        )
        trialRequested = !alreadyTrialed
      }

      let reservationResult
      try {
        reservationResult = await callRecurringProRpc(
          supabaseAdmin,
          'reserve_recurring_pro_checkout_atomic',
          {
            p_user_id: user.id,
            p_livemode: livemode,
            p_stripe_customer_id: customerId,
            p_plan: recurringPlan,
            p_stripe_price_id: priceId,
            p_operation_id: operationId,
            p_trial_requested: trialRequested,
          }
        )
      } catch (reservationError) {
        logger.error('Recurring Pro Checkout admission was unavailable', {
          userId: user.id,
          operationId,
          error:
            reservationError instanceof Error ? reservationError.message : String(reservationError),
        })
        return recurringCheckoutUnavailable()
      }
      if (reservationResult.error) {
        logger.error('Recurring Pro Checkout admission failed', {
          userId: user.id,
          operationId,
          error: reservationResult.error.message,
        })
        return recurringCheckoutUnavailable()
      }
      const reservationStatus = recurringProRpcStatus(reservationResult.data)
      if (reservationStatus === 'already_subscribed') {
        return recurringCheckoutConflict('ALREADY_SUBSCRIBED')
      }
      if (reservationStatus === 'conflict') return recurringCheckoutConflict()

      const reservation = parseRecurringProReservation(reservationResult.data)
      if (
        !reservation ||
        reservation.userId !== user.id ||
        reservation.livemode !== livemode ||
        reservation.customerId !== customerId ||
        reservation.plan !== recurringPlan ||
        reservation.priceId !== priceId ||
        reservation.operationId !== operationId ||
        reservation.trialRequested !== trialRequested
      ) {
        logger.error('Recurring Pro Checkout admission returned uncertain identity', {
          userId: user.id,
          operationId,
          status: reservationStatus,
        })
        return recurringCheckoutUnavailable()
      }

      const recurringIdentity = {
        userId: reservation.userId,
        customerId: reservation.customerId,
        plan: reservation.plan,
        priceId: reservation.priceId,
        reservationId: reservation.reservationId,
        operationId: reservation.operationId,
        nonce: reservation.nonce,
        trialRequested: reservation.trialRequested,
      }
      const recurringMetadata = buildRecurringProCheckoutMetadata(recurringIdentity)
      const stripeClient = getStripe()

      if (reservation.checkoutSessionId) {
        try {
          checkoutSession = await verifyRecurringProCheckoutSession({
            stripe: stripeClient,
            sessionId: reservation.checkoutSessionId,
            identity: recurringIdentity,
            livemode,
            checkoutExpiresAtSeconds: reservation.checkoutExpiresAtSeconds,
            phase: 'open',
          })
        } catch (recoveryError) {
          try {
            await stripeClient.checkout.sessions.expire(reservation.checkoutSessionId)
          } catch (expireError) {
            logger.error('Failed to expire unsafe recovered Pro Checkout Session', {
              sessionId: reservation.checkoutSessionId,
              error: expireError instanceof Error ? expireError.message : String(expireError),
            })
          }
          await recordStripeCheckoutManualReview({
            supabase: supabaseAdmin,
            sessionId: reservation.checkoutSessionId,
            userId: user.id,
            reasonKey: 'recurring_checkout_recovery_identity_conflict',
            reason: 'A bound recurring Pro Checkout Session failed exact open-state recovery.',
            context: {
              reservation_id: reservation.reservationId,
              operation_id: reservation.operationId,
              error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
            },
          })
          return recurringCheckoutUnavailable()
        }

        return NextResponse.json(
          { url: checkoutSession.url, sessionId: checkoutSession.id },
          {
            headers: {
              'Cache-Control': 'no-store',
              'X-Arena-Pro-Checkout-Writer': 'sealed',
            },
          }
        )
      }

      const checkoutOptions: Parameters<typeof createCheckoutSession>[0] = {
        customerId,
        priceId,
        successUrl: sUrl,
        cancelUrl: cUrl,
        metadata: recurringMetadata,
        allowPromotionCodes: false,
        idempotencyKey: `recurring_pro_checkout_${livemode ? 'live' : 'test'}_${reservation.reservationId}`,
        expiresAt: reservation.checkoutExpiresAtSeconds,
        clientReferenceId: reservation.reservationId,
      }

      if (trialRequested) checkoutOptions.trialDays = 7

      try {
        checkoutSession = await createCheckoutSession(checkoutOptions)
      } catch (createError) {
        // Stripe can commit before its response is lost. Preserve the durable
        // reservation and recover this exact idempotency key on the same
        // operation; never create a second Session or unsigned release.
        logger.warn('Recurring Pro Checkout create outcome was ambiguous', {
          userId: user.id,
          reservationId: reservation.reservationId,
          error: createError instanceof Error ? createError.message : String(createError),
        })
        return recurringCheckoutUnavailable()
      }

      const createdSessionId =
        checkoutSession &&
        typeof checkoutSession === 'object' &&
        typeof checkoutSession.id === 'string'
          ? checkoutSession.id
          : null
      if (!createdSessionId) return recurringCheckoutUnavailable()

      // Bind the returned Session identity before fresh verification. If
      // verification later discovers a Stripe-side contradiction, this row
      // remains bound and therefore cannot be retired by unsigned DB time.
      // Only the exact signed expired event (or exact completion) can release
      // the financial barrier.
      let bindResult
      try {
        bindResult = await callRecurringProRpc(
          supabaseAdmin,
          'bind_recurring_pro_checkout_session_atomic',
          {
            p_user_id: recurringIdentity.userId,
            p_livemode: livemode,
            p_stripe_customer_id: recurringIdentity.customerId,
            p_plan: recurringIdentity.plan,
            p_stripe_price_id: recurringIdentity.priceId,
            p_operation_id: recurringIdentity.operationId,
            p_reservation_id: recurringIdentity.reservationId,
            p_reservation_nonce: recurringIdentity.nonce,
            p_trial_requested: recurringIdentity.trialRequested,
            p_checkout_session_id: createdSessionId,
            p_checkout_expires_at: reservation.checkoutExpiresAtSeconds,
          }
        )
      } catch (bindError) {
        logger.error('Recurring Pro Checkout bind outcome was uncertain', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: createdSessionId,
          error: bindError instanceof Error ? bindError.message : String(bindError),
        })
        try {
          await stripeClient.checkout.sessions.expire(createdSessionId)
        } catch (expireError) {
          logger.error('Failed to expire Pro Checkout after uncertain bind', {
            sessionId: createdSessionId,
            error: expireError instanceof Error ? expireError.message : String(expireError),
          })
        }
        return recurringCheckoutUnavailable()
      }
      const bindStatus = recurringProRpcStatus(bindResult.data)
      if (
        bindResult.error ||
        (bindStatus !== 'bound' &&
          bindStatus !== 'already_bound' &&
          bindStatus !== 'already_completed')
      ) {
        try {
          await stripeClient.checkout.sessions.expire(createdSessionId)
        } catch (expireError) {
          logger.error('Failed to expire rejected Pro Checkout Session', {
            sessionId: createdSessionId,
            error: expireError instanceof Error ? expireError.message : String(expireError),
          })
        }
        logger.error('Recurring Pro Checkout bind was not durably acknowledged', {
          userId: user.id,
          reservationId: reservation.reservationId,
          sessionId: createdSessionId,
          status: bindStatus,
          error: bindResult.error?.message,
        })
        return recurringCheckoutUnavailable()
      }

      try {
        checkoutSession = await verifyRecurringProCheckoutSession({
          stripe: stripeClient,
          sessionId: createdSessionId,
          identity: recurringIdentity,
          livemode,
          checkoutExpiresAtSeconds: reservation.checkoutExpiresAtSeconds,
          phase: 'open',
        })
      } catch (verificationError) {
        try {
          await stripeClient.checkout.sessions.expire(createdSessionId)
        } catch (expireError) {
          logger.error('Failed to expire unsafe fresh Pro Checkout Session', {
            sessionId: createdSessionId,
            error: expireError instanceof Error ? expireError.message : String(expireError),
          })
        }
        await recordStripeCheckoutManualReview({
          supabase: supabaseAdmin,
          sessionId: createdSessionId,
          userId: user.id,
          reasonKey: 'recurring_checkout_fresh_identity_conflict',
          reason: 'A fresh recurring Pro Checkout Session failed exact verification.',
          context: {
            reservation_id: reservation.reservationId,
            operation_id: reservation.operationId,
            error:
              verificationError instanceof Error
                ? verificationError.message
                : String(verificationError),
          },
        })
        return recurringCheckoutUnavailable()
      }
    }

    return NextResponse.json(
      {
        url: checkoutSession.url,
        sessionId: checkoutSession.id,
      },
      recurringCheckout
        ? {
            headers: {
              'Cache-Control': 'no-store',
              'X-Arena-Pro-Checkout-Writer': 'sealed',
            },
          }
        : undefined
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
