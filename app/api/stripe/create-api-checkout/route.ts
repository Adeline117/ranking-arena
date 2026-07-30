import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_API_PRICE_IDS,
  getOrCreateStripeCustomer,
  createCheckoutSession,
  assertApiPriceReady,
  assertStripePaymentRuntimeReady,
  getStripe,
} from '@/lib/stripe'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { env } from '@/lib/env'
import { extractUserFromRequest } from '@/lib/auth/extract-user'
import { API_PRICING } from '@/app/(app)/user-center/membership-config'
import { isTrustedStripeCheckoutUrl } from '@/lib/stripe/hosted-url'

const logger = createLogger('stripe-create-api-checkout')

type ApiPlan = 'starter' | 'pro'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const STRIPE_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/
const STRIPE_PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]+$/
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/
const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799
const API_CHECKOUT_METADATA_KEYS = [
  'api_plan',
  'api_tier_reservation_id',
  'supabase_user_id',
  'type',
  'userId',
] as const

type ApiCheckoutReservation = {
  status: 'reserved' | 'existing'
  reservationId: string
  apiPlan: ApiPlan
  stripePriceId: string
  checkoutExpiresAtSeconds: number
  checkoutSessionId: string | null
}

type JsonRpcResult = {
  data: unknown
  error: {
    code?: string
    details?: string
    hint?: string
    message?: string
  } | null
  status: number | null
}

function rpcRecord(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The Checkout reservation RPC is introduced by the same migration as this
 * route. Keeping this narrow adapter local lets the route fail closed even
 * before generated Supabase types are refreshed in a checkout-only test.
 */
async function callJsonRpc(
  client: unknown,
  name: 'reserve_api_tier_checkout_atomic' | 'bind_api_tier_checkout_session_atomic',
  args: Record<string, unknown>
): Promise<JsonRpcResult> {
  const rpc = rpcRecord(client)?.rpc
  if (typeof rpc !== 'function') {
    throw new Error(`Supabase RPC client is unavailable for ${name}`)
  }
  const result = await (
    rpc as (
      this: unknown,
      functionName: string,
      functionArgs: Record<string, unknown>
    ) => Promise<unknown>
  ).call(client, name, args)
  const record = rpcRecord(result)
  if (!record) {
    throw new Error(`Supabase RPC ${name} returned an invalid result`)
  }
  const rawError = record.error
  const errorRecord = rpcRecord(rawError)
  return {
    data: record.data,
    error:
      rawError == null
        ? null
        : {
            code: typeof errorRecord?.code === 'string' ? errorRecord.code : undefined,
            details: typeof errorRecord?.details === 'string' ? errorRecord.details : undefined,
            hint: typeof errorRecord?.hint === 'string' ? errorRecord.hint : undefined,
            message:
              typeof errorRecord?.message === 'string'
                ? errorRecord.message
                : 'Unknown database error',
          },
    status:
      typeof record.status === 'number' && Number.isInteger(record.status) ? record.status : null,
  }
}

function isExplicitDatabaseRejection(result: JsonRpcResult): boolean {
  return (
    result.error !== null &&
    typeof result.error.code === 'string' &&
    result.error.code.length > 0 &&
    result.status !== null &&
    result.status >= 400 &&
    result.status < 600
  )
}

function serviceUnavailable(message = 'Unable to prepare API checkout. Please retry.') {
  return NextResponse.json(
    { error: message },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '30',
      },
    }
  )
}

function apiTierCheckoutWriterIsOpen(): boolean {
  if (env.API_TIER_CHECKOUT_WRITER_MODE !== 'sealed') return false
  if (!env.isProduction) return true

  const expectedSha = env.API_TIER_CHECKOUT_WRITER_SHA?.trim().toLowerCase() ?? ''
  const runtimeSha = (process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.ARENA_RELEASE_SHA ?? '')
    .trim()
    .toLowerCase()
  return (
    FULL_GIT_SHA_PATTERN.test(expectedSha) &&
    FULL_GIT_SHA_PATTERN.test(runtimeSha) &&
    expectedSha === runtimeSha
  )
}

function checkoutWriterClosed() {
  return NextResponse.json(
    {
      error: 'API checkout is temporarily paused for a billing upgrade. Please retry shortly.',
      code: 'API_CHECKOUT_WRITER_CLOSED',
    },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': '60',
        'X-Arena-API-Checkout-Writer': 'closed',
      },
    }
  )
}

function checkoutConflict() {
  return NextResponse.json(
    {
      error:
        'A checkout for a different API plan is already in progress. Finish it or retry after it expires.',
      code: 'API_CHECKOUT_CONFLICT',
    },
    {
      status: 409,
      headers: { 'Cache-Control': 'no-store' },
    }
  )
}

function stripeSecretLivemode(secret: string): boolean | null {
  const canonicalSecret = secret.trim()
  if (canonicalSecret.startsWith('sk_live_')) return true
  if (canonicalSecret.startsWith('sk_test_')) return false
  return null
}

function parseReservation(value: unknown): ApiCheckoutReservation | null {
  const reservation = rpcRecord(value)
  if (!reservation) return null

  const status = reservation.status
  const reservationId = reservation.reservation_id
  const apiPlan = reservation.api_plan
  const stripePriceId = reservation.stripe_price_id
  const checkoutExpiresAt = reservation.checkout_expires_at
  const checkoutSessionId = reservation.checkout_session_id

  if (
    (status !== 'reserved' && status !== 'existing') ||
    typeof reservationId !== 'string' ||
    !UUID_PATTERN.test(reservationId) ||
    (apiPlan !== 'starter' && apiPlan !== 'pro') ||
    typeof stripePriceId !== 'string' ||
    !STRIPE_PRICE_ID_PATTERN.test(stripePriceId) ||
    typeof checkoutExpiresAt !== 'number' ||
    !Number.isSafeInteger(checkoutExpiresAt) ||
    checkoutExpiresAt <= Math.floor(Date.now() / 1000) ||
    checkoutExpiresAt > MAX_STRIPE_UNIX_SECONDS ||
    (checkoutSessionId !== null &&
      (typeof checkoutSessionId !== 'string' ||
        !STRIPE_SESSION_ID_PATTERN.test(checkoutSessionId))) ||
    (status === 'reserved' && checkoutSessionId !== null)
  ) {
    return null
  }

  return {
    status,
    reservationId,
    apiPlan,
    stripePriceId,
    checkoutExpiresAtSeconds: checkoutExpiresAt,
    checkoutSessionId,
  }
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value
  const record = rpcRecord(value)
  return typeof record?.id === 'string' ? record.id : null
}

function parseExactCheckoutSession(params: {
  value: unknown
  customerId: string
  livemode: boolean
  expectedAmountCents: number
  reservation: ApiCheckoutReservation
  metadata: Record<(typeof API_CHECKOUT_METADATA_KEYS)[number], string>
}): { id: string; url: string } | null {
  const session = rpcRecord(params.value)
  const metadata = rpcRecord(session?.metadata)
  if (!session || !metadata) return null

  const id = session.id
  const url = session.url
  const metadataKeys = Object.keys(metadata).sort()
  const discounts = session.discounts
  const totalDetails = rpcRecord(session.total_details)
  const persistedSessionMatches =
    params.reservation.checkoutSessionId === null || id === params.reservation.checkoutSessionId

  const exact =
    typeof id === 'string' &&
    STRIPE_SESSION_ID_PATTERN.test(id) &&
    id.length <= 255 &&
    persistedSessionMatches &&
    isTrustedStripeCheckoutUrl(url) &&
    session.object === 'checkout.session' &&
    session.mode === 'subscription' &&
    session.status === 'open' &&
    session.payment_status === 'unpaid' &&
    session.allow_promotion_codes === false &&
    Array.isArray(discounts) &&
    discounts.length === 0 &&
    session.currency === 'usd' &&
    session.amount_subtotal === params.expectedAmountCents &&
    session.amount_total === params.expectedAmountCents &&
    totalDetails?.amount_discount === 0 &&
    totalDetails.amount_shipping === 0 &&
    totalDetails.amount_tax === 0 &&
    session.subscription === null &&
    stripeObjectId(session.customer) === params.customerId &&
    session.livemode === params.livemode &&
    session.expires_at === params.reservation.checkoutExpiresAtSeconds &&
    session.client_reference_id === params.reservation.reservationId &&
    metadataKeys.length === API_CHECKOUT_METADATA_KEYS.length &&
    API_CHECKOUT_METADATA_KEYS.every((key, index) => metadataKeys[index] === key) &&
    API_CHECKOUT_METADATA_KEYS.every((key) => metadata[key] === params.metadata[key])

  return exact ? { id, url } : null
}

async function expireCheckoutSessionBestEffort(sessionId: unknown, context: string): Promise<void> {
  if (typeof sessionId !== 'string' || !STRIPE_SESSION_ID_PATTERN.test(sessionId)) return
  try {
    await getStripe().checkout.sessions.expire(sessionId)
  } catch (error) {
    logger.error('Failed to expire unsafe API Checkout Session', {
      sessionId,
      context,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function POST(request: NextRequest) {
  // This gate is intentionally before rate limiting, authentication, database
  // reads, Customer creation, and Checkout reservation. A cutover release can
  // therefore prove that every old writer has drained without creating any
  // new four-key legacy Session. Production re-opening is bound to one exact
  // release SHA so a stale instance cannot become a paid writer.
  if (!apiTierCheckoutWriterIsOpen()) return checkoutWriterClosed()

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

    if (plan !== 'starter' && plan !== 'pro') {
      return NextResponse.json(
        { error: 'Invalid plan. Must be "starter" or "pro".' },
        { status: 400 }
      )
    }
    const apiPlan: ApiPlan = plan

    const { user, error: userError } = await extractUserFromRequest(request)
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized - Please login first' }, { status: 401 })
    }

    // The profile is only a fast pre-check. The reservation RPC below remains
    // the final authority across concurrent requests and server instances.
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
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }

    if (profile.api_tier !== 'free' || profile.api_stripe_subscription_id) {
      return NextResponse.json(
        {
          error:
            'You already have an API subscription. Change or cancel it from your account settings before starting another checkout.',
          code: 'ALREADY_SUBSCRIBED',
        },
        { status: 409 }
      )
    }

    const priceId = STRIPE_API_PRICE_IDS[apiPlan]
    if (!priceId || !STRIPE_PRICE_ID_PATTERN.test(priceId)) {
      return NextResponse.json(
        { error: 'API plan pricing not configured. Please contact support.' },
        { status: 503 }
      )
    }

    const livemode = stripeSecretLivemode(env.STRIPE_SECRET_KEY)
    if (livemode === null) {
      return serviceUnavailable('Payment system not configured. Please contact support.')
    }

    try {
      assertStripePaymentRuntimeReady()
      await assertApiPriceReady(apiPlan, priceId)
    } catch (priceError) {
      logger.error('Stripe API price readiness check failed', {
        plan: apiPlan,
        error: priceError instanceof Error ? priceError.message : String(priceError),
      })
      return NextResponse.json(
        { error: 'API plan pricing is not ready. Please contact support.' },
        { status: 503 }
      )
    }

    const previousCustomerId = profile.stripe_customer_id || null
    const userEmail = user.email || `${user.id}@user.ranking-arena.com`
    const customerId = await getOrCreateStripeCustomer(
      user.id,
      userEmail,
      {
        source: 'ranking-arena-api',
        plan: `api_${apiPlan}`,
      },
      previousCustomerId
    )
    if (!STRIPE_CUSTOMER_ID_PATTERN.test(customerId)) {
      logger.error('Stripe returned invalid Customer identity', { userId: user.id })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }

    // Invoice/subscription webhooks resolve ownership through this link. A
    // compare-and-set prevents two concurrent customer identities from winning.
    let customerLink: unknown
    let customerLinkError: { message?: string } | null
    try {
      const customerLinkResult = await supabaseAdmin.rpc('bind_stripe_customer_owner_atomic', {
        p_user_id: user.id,
        p_new_stripe_customer_id: customerId,
        p_expected_previous_stripe_customer_id: previousCustomerId,
      })
      customerLink = customerLinkResult.data
      customerLinkError = customerLinkResult.error
    } catch (error) {
      logger.error('Atomic Stripe customer link was unavailable; API checkout blocked', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }
    const customerLinkStatus = rpcRecord(customerLink)?.status
    if (
      customerLinkError ||
      (customerLinkStatus !== 'bound' && customerLinkStatus !== 'already_bound')
    ) {
      logger.error('Failed to atomically persist Stripe customer link; API checkout blocked', {
        userId: user.id,
        status: customerLinkStatus,
        error: customerLinkError?.message,
      })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }

    let reservationData: unknown
    let reservationError: { message?: string } | null
    try {
      const reservationResult = await callJsonRpc(
        supabaseAdmin,
        'reserve_api_tier_checkout_atomic',
        {
          p_user_id: user.id,
          p_livemode: livemode,
          p_stripe_customer_id: customerId,
          p_api_plan: apiPlan,
          p_stripe_price_id: priceId,
        }
      )
      reservationData = reservationResult.data
      reservationError = reservationResult.error
    } catch (error) {
      logger.error('Atomic API Checkout reservation was unavailable', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return serviceUnavailable()
    }
    if (reservationError) {
      logger.error('Atomic API Checkout reservation failed', {
        userId: user.id,
        error: reservationError.message,
      })
      return serviceUnavailable()
    }

    const reservation = parseReservation(reservationData)
    if (!reservation) {
      logger.error('Atomic API Checkout reservation returned uncertain identity', {
        userId: user.id,
      })
      return serviceUnavailable()
    }
    if (
      reservation.status === 'existing' &&
      (reservation.apiPlan !== apiPlan || reservation.stripePriceId !== priceId)
    ) {
      return checkoutConflict()
    }
    if (reservation.apiPlan !== apiPlan || reservation.stripePriceId !== priceId) {
      logger.error('New API Checkout reservation did not match the requested product', {
        userId: user.id,
        reservationId: reservation.reservationId,
      })
      return serviceUnavailable()
    }

    const appOrigin = new URL(env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org').origin
    const successUrl = `${appOrigin}/settings?api_upgraded=${apiPlan}`
    const cancelUrl = `${appOrigin}/api-docs`
    const metadata = {
      supabase_user_id: user.id,
      userId: user.id,
      type: 'api_tier',
      api_plan: apiPlan,
      api_tier_reservation_id: reservation.reservationId,
    }

    let checkoutSession: unknown
    try {
      checkoutSession = await createCheckoutSession({
        customerId,
        priceId,
        successUrl,
        cancelUrl,
        metadata,
        idempotencyKey: `api_tier_checkout_${livemode ? 'live' : 'test'}_${reservation.reservationId}`,
        expiresAt: reservation.checkoutExpiresAtSeconds,
        clientReferenceId: reservation.reservationId,
        allowPromotionCodes: false,
      })
    } catch (error) {
      // A network error can arrive after Stripe created the Session. Keep the
      // reservation so the same idempotency key can recover that exact object.
      logger.warn('Stripe API Checkout create was ambiguous; reservation preserved', {
        userId: user.id,
        reservationId: reservation.reservationId,
        error: error instanceof Error ? error.message : String(error),
      })
      return serviceUnavailable()
    }

    const exactSession = parseExactCheckoutSession({
      value: checkoutSession,
      customerId,
      livemode,
      expectedAmountCents: Math.round(API_PRICING[apiPlan].price * 100),
      reservation,
      metadata,
    })
    if (!exactSession) {
      const sessionId = rpcRecord(checkoutSession)?.id
      await expireCheckoutSessionBestEffort(sessionId, 'api_checkout_identity_drift')
      logger.error('Stripe returned an unsafe API Checkout Session; URL withheld', {
        userId: user.id,
        reservationId: reservation.reservationId,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
      })
      return serviceUnavailable()
    }

    let bindResult: JsonRpcResult
    try {
      bindResult = await callJsonRpc(supabaseAdmin, 'bind_api_tier_checkout_session_atomic', {
        p_reservation_id: reservation.reservationId,
        p_user_id: user.id,
        p_livemode: livemode,
        p_stripe_customer_id: customerId,
        p_api_plan: apiPlan,
        p_stripe_price_id: priceId,
        p_checkout_session_id: exactSession.id,
        p_checkout_expires_at: reservation.checkoutExpiresAtSeconds,
      })
    } catch (error) {
      // A transport failure can arrive after the database committed the bind.
      // Preserve both identities so a retry can recover the same Stripe
      // Session through the reservation UUID and idempotency key.
      logger.error('Atomic API Checkout Session bind outcome was uncertain; Session preserved', {
        userId: user.id,
        reservationId: reservation.reservationId,
        sessionId: exactSession.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return serviceUnavailable()
    }
    const bindStatus = rpcRecord(bindResult.data)?.status
    if (isExplicitDatabaseRejection(bindResult)) {
      await expireCheckoutSessionBestEffort(exactSession.id, 'api_checkout_bind_failed')
      logger.error('Atomic API Checkout Session bind failed; URL withheld', {
        userId: user.id,
        reservationId: reservation.reservationId,
        sessionId: exactSession.id,
        status: bindStatus,
        error: bindResult.error?.message,
        databaseCode: bindResult.error?.code,
        responseStatus: bindResult.status,
      })
      return serviceUnavailable()
    }
    if (bindResult.error) {
      // postgrest-js resolves fetch/Abort/network failures as an error object
      // with status=0 and an empty code. That outcome can arrive after the
      // transaction committed, so preserve the Session and reservation.
      logger.error('Atomic API Checkout Session bind outcome was uncertain; Session preserved', {
        userId: user.id,
        reservationId: reservation.reservationId,
        sessionId: exactSession.id,
        error: bindResult.error.message,
        databaseCode: bindResult.error.code,
        responseStatus: bindResult.status,
      })
      return serviceUnavailable()
    }
    if (bindStatus !== 'bound' && bindStatus !== 'already_bound' && bindStatus !== 'converted') {
      // An unrecognized success payload is also an uncertain commit outcome.
      // Withhold the URL, but do not destroy a Session that may already be
      // durably bound.
      logger.error('Atomic API Checkout Session bind returned an uncertain status', {
        userId: user.id,
        reservationId: reservation.reservationId,
        sessionId: exactSession.id,
        status: bindStatus,
      })
      return serviceUnavailable()
    }

    return NextResponse.json(
      {
        url: exactSession.url,
        sessionId: exactSession.id,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
          'X-Arena-API-Checkout-Writer': 'sealed',
        },
      }
    )
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
