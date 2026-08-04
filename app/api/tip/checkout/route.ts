/**
 * Tip Checkout API
 * POST /api/tip/checkout - reserve and bind one exact Stripe Checkout Session
 */

import { type NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, notFound } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { env } from '@/lib/env'
import { createOneTimePaymentSession, getOrCreateStripeCustomer, getStripe } from '@/lib/stripe'
import { sanitizeInput } from '@/lib/utils/sanitize'
import { isTipCheckoutRuntimeEnabled } from '@/lib/security/tip-checkout-cutover'
import { isTrustedStripeCheckoutUrl } from '@/lib/stripe/hosted-url'

const logger = createLogger('tip-checkout')
const NO_STORE = 'private, no-store'

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STRIPE_CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const STRIPE_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/
const TIP_CHECKOUT_TTL_SECONDS = 60 * 60
const TIP_PRODUCT_NAME = 'Arena creator tip'
const TIP_PRODUCT_DESCRIPTION = 'Support a creator on Arena.'
const TIP_METADATA_KEYS = [
  'amount_cents',
  'from_user_id',
  'post_id',
  'tip_id',
  'to_user_id',
  'type',
  'user_id',
] as const

const TipCheckoutBodySchema = z
  .object({
    post_id: z
      .string()
      .regex(UUID_PATTERN, 'Invalid post_id parameter')
      .transform((value) => value.toLowerCase()),
    amount_cents: z.number().int().min(100).max(50_000),
    message: z.string().trim().max(200).optional(),
  })
  .strict()

type TipReservation = {
  status: 'reserved' | 'reservation_exists' | 'reservation_expiring' | 'already_bound'
  tipId: string
  postId: string
  toUserId: string
  checkoutExpiresAt: string
  checkoutExpiresAtSeconds: number
  checkoutSessionId: string | null
}

type TipSessionVerification =
  | { ok: true; session: Stripe.Checkout.Session }
  | { ok: false; reason: string }

function rpcRecord(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function stripeId(value: string | { id: string } | null): string | null {
  return typeof value === 'string' ? value : value?.id || null
}

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', NO_STORE)
  return response
}

function serviceUnavailable(message = 'Unable to prepare tip checkout. Please retry.') {
  return NextResponse.json(
    { error: message },
    {
      status: 503,
      headers: {
        'Cache-Control': NO_STORE,
        'Retry-After': '30',
      },
    }
  )
}

function isEmptyStripeCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

function parseTipReservation(value: unknown, expectedPostId: string): TipReservation | null {
  const reservation = rpcRecord(value)
  if (!reservation) return null
  const status = reservation.status
  if (
    status !== 'reserved' &&
    status !== 'reservation_exists' &&
    status !== 'reservation_expiring' &&
    status !== 'already_bound'
  ) {
    return null
  }

  const expectedKeys =
    status === 'reserved'
      ? ['checkout_expires_at', 'post_id', 'status', 'tip_id', 'to_user_id']
      : ['checkout_expires_at', 'checkout_session_id', 'post_id', 'status', 'tip_id', 'to_user_id']
  if (!hasExactKeys(reservation, expectedKeys)) return null

  const tipId = reservation.tip_id
  const postId = reservation.post_id
  const toUserId = reservation.to_user_id
  const checkoutExpiresAt = reservation.checkout_expires_at
  const checkoutSessionId = reservation.checkout_session_id
  const expiresAtMilliseconds =
    typeof checkoutExpiresAt === 'string' ? Date.parse(checkoutExpiresAt) : Number.NaN

  if (
    typeof tipId !== 'string' ||
    !UUID_PATTERN.test(tipId) ||
    tipId !== tipId.toLowerCase() ||
    typeof postId !== 'string' ||
    postId !== expectedPostId ||
    typeof toUserId !== 'string' ||
    !UUID_PATTERN.test(toUserId) ||
    toUserId !== toUserId.toLowerCase() ||
    typeof checkoutExpiresAt !== 'string' ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    expiresAtMilliseconds % 1000 !== 0
  ) {
    return null
  }

  const normalizedSessionId =
    typeof checkoutSessionId === 'string' && STRIPE_SESSION_ID_PATTERN.test(checkoutSessionId)
      ? checkoutSessionId
      : null
  if (
    (status === 'already_bound' && !normalizedSessionId) ||
    (status !== 'already_bound' && checkoutSessionId != null)
  ) {
    return null
  }

  return {
    status,
    tipId,
    postId,
    toUserId,
    checkoutExpiresAt,
    checkoutExpiresAtSeconds: expiresAtMilliseconds / 1000,
    checkoutSessionId: normalizedSessionId,
  }
}

function isExactCustomerBindResult(value: unknown): boolean {
  const result = rpcRecord(value)
  return (
    !!result &&
    hasExactKeys(result, ['status']) &&
    (result.status === 'bound' || result.status === 'already_bound')
  )
}

function isExactTipSessionBindResult(
  value: unknown,
  expected: {
    tipId: string
    sessionId: string
    expiresAt: string
    postId: string
    toUserId: string
  }
): boolean {
  const result = rpcRecord(value)
  return (
    !!result &&
    hasExactKeys(result, [
      'checkout_expires_at',
      'checkout_session_id',
      'post_id',
      'status',
      'tip_id',
      'to_user_id',
    ]) &&
    (result.status === 'bound' || result.status === 'already_bound') &&
    result.tip_id === expected.tipId &&
    result.checkout_session_id === expected.sessionId &&
    result.checkout_expires_at === expected.expiresAt &&
    result.post_id === expected.postId &&
    result.to_user_id === expected.toUserId
  )
}

async function listCompleteCheckoutLineItems(
  stripeClient: Stripe,
  sessionId: string
): Promise<Stripe.LineItem[]> {
  const lines: Stripe.LineItem[] = []
  const seen = new Set<string>()
  let startingAfter: string | undefined

  while (true) {
    const page = await stripeClient.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      expand: ['data.price.product'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error('Stripe returned an invalid Tip line-item page')
    }
    if (startingAfter && page.data.length === 0) {
      throw new Error('Stripe returned an empty Tip line-item continuation page')
    }
    for (const line of page.data) {
      if (!line.id?.startsWith('li_') || line.object !== 'item' || seen.has(line.id)) {
        throw new Error('Stripe returned uncertain Tip line-item identity')
      }
      seen.add(line.id)
      lines.push(line)
    }
    if (!page.has_more) return lines

    const lastLine = page.data.at(-1)
    if (!lastLine?.id || lastLine.id === startingAfter) {
      throw new Error('Stripe Tip line-item pagination did not advance')
    }
    startingAfter = lastLine.id
  }
}

async function verifyFreshTipSession(params: {
  sessionId: string
  customerId: string
  tipId: string
  userId: string
  postId: string
  toUserId: string
  amountCents: number
  expiresAtSeconds: number
}): Promise<TipSessionVerification> {
  if (!STRIPE_SESSION_ID_PATTERN.test(params.sessionId)) {
    return { ok: false, reason: 'invalid_checkout_session_id' }
  }

  const stripeClient = getStripe()
  const [session, lines] = await Promise.all([
    stripeClient.checkout.sessions.retrieve(params.sessionId, {
      expand: ['line_items.data.price.product'],
    }),
    listCompleteCheckoutLineItems(stripeClient, params.sessionId),
  ])
  const line = lines.length === 1 ? lines[0] : null
  const price = line?.price ?? null
  const product = price && typeof price.product !== 'string' ? price.product : null
  const metadata = session.metadata ?? {}
  const metadataKeys = Object.keys(metadata).sort()
  const expectedLivemode = true
  const productMatches =
    !!product &&
    !('deleted' in product) &&
    product.name === TIP_PRODUCT_NAME &&
    product.description === TIP_PRODUCT_DESCRIPTION &&
    product.livemode === expectedLivemode

  const matches =
    session.id === params.sessionId &&
    session.object === 'checkout.session' &&
    stripeId(session.customer) === params.customerId &&
    session.client_reference_id === params.tipId &&
    metadataKeys.length === TIP_METADATA_KEYS.length &&
    TIP_METADATA_KEYS.every((key, index) => metadataKeys[index] === key) &&
    metadata.type === 'tip' &&
    metadata.tip_id === params.tipId &&
    metadata.user_id === params.userId &&
    metadata.from_user_id === params.userId &&
    metadata.post_id === params.postId &&
    metadata.to_user_id === params.toUserId &&
    metadata.amount_cents === String(params.amountCents) &&
    session.expires_at === params.expiresAtSeconds &&
    session.mode === 'payment' &&
    session.status === 'open' &&
    session.payment_status === 'unpaid' &&
    session.subscription === null &&
    session.invoice === null &&
    session.after_expiration === null &&
    isTrustedStripeCheckoutUrl(session.url) &&
    session.currency === 'usd' &&
    session.amount_subtotal === params.amountCents &&
    session.amount_total === params.amountCents &&
    session.total_details?.amount_discount === 0 &&
    session.total_details.amount_tax === 0 &&
    session.allow_promotion_codes !== true &&
    session.automatic_tax?.enabled === false &&
    session.adaptive_pricing?.enabled !== true &&
    session.livemode === expectedLivemode &&
    isEmptyStripeCollection(session.discounts) &&
    session.shipping_cost == null &&
    !!line &&
    line.quantity === 1 &&
    line.currency === 'usd' &&
    line.amount_subtotal === params.amountCents &&
    line.amount_total === params.amountCents &&
    line.amount_discount === 0 &&
    line.amount_tax === 0 &&
    isEmptyStripeCollection(line.discounts) &&
    isEmptyStripeCollection(line.taxes) &&
    price?.currency === 'usd' &&
    price.unit_amount === params.amountCents &&
    price.type === 'one_time' &&
    price.recurring === null &&
    price.livemode === expectedLivemode &&
    productMatches

  return matches ? { ok: true, session } : { ok: false, reason: 'checkout_session_identity_drift' }
}

async function expireSessionBestEffort(sessionId: string, context: string): Promise<void> {
  if (!STRIPE_SESSION_ID_PATTERN.test(sessionId)) return
  try {
    await getStripe().checkout.sessions.expire(sessionId)
  } catch (error) {
    logger.error('[Tip Checkout] Failed to expire unsafe Session', {
      sessionId,
      context,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const authenticatedPost = withAuth(
  async ({ user, supabase, request }) => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return noStore(badRequest('Invalid JSON body'))
    }

    const parsedBody = TipCheckoutBodySchema.safeParse(body)
    if (!parsedBody.success) return noStore(badRequest('Invalid tip checkout input'))
    const { post_id: canonicalPostId, amount_cents: amount, message } = parsedBody.data

    const normalizedMessage =
      typeof message === 'string' && message.trim()
        ? sanitizeInput(message.trim(), { maxLength: 200 })
        : null

    // Customer identity is established before reserving a payable Tip tuple.
    // Both the Stripe create key and the DB compare-and-set are stable by user.
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()
    if (profileError || !profile) {
      logger.error('[Tip Checkout] Billing profile lookup failed', {
        userId: user.id,
        error: profileError?.message,
      })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }

    const previousCustomerId = profile.stripe_customer_id || null
    let customerId: string
    try {
      customerId = await getOrCreateStripeCustomer(
        user.id,
        user.email || `${user.id}@user.ranking-arena.com`,
        undefined,
        previousCustomerId
      )
    } catch (error) {
      logger.error('[Tip Checkout] Stripe Customer identity failed', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }
    if (!STRIPE_CUSTOMER_ID_PATTERN.test(customerId)) {
      logger.error('[Tip Checkout] Stripe returned invalid Customer identity', {
        userId: user.id,
      })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }

    const { data: customerBind, error: customerBindError } = await supabase.rpc(
      'bind_stripe_customer_owner_atomic',
      {
        p_user_id: user.id,
        p_new_stripe_customer_id: customerId,
        p_expected_previous_stripe_customer_id: previousCustomerId,
      }
    )
    const customerBindStatus = rpcRecord(customerBind)?.status
    if (customerBindError || !isExactCustomerBindResult(customerBind)) {
      logger.error('[Tip Checkout] Exact Stripe Customer bind failed', {
        userId: user.id,
        status: customerBindStatus,
        error: customerBindError?.message,
      })
      return serviceUnavailable('Unable to prepare payment account. Please retry.')
    }

    const { data: reservationData, error: reservationError } = await supabase.rpc(
      'reserve_tip_checkout_atomic',
      {
        p_from_user_id: user.id,
        p_post_id: canonicalPostId,
        p_amount_cents: amount,
        p_message: normalizedMessage,
        p_checkout_ttl_seconds: TIP_CHECKOUT_TTL_SECONDS,
      }
    )
    const reservationStatus = rpcRecord(reservationData)?.status
    if (reservationError) {
      logger.error('[Tip Checkout] Atomic reservation failed', {
        userId: user.id,
        error: reservationError.message,
      })
      return serviceUnavailable()
    }
    if (reservationStatus === 'not_found' || reservationStatus === 'recipient_unavailable') {
      return noStore(notFound('Post not found'))
    }
    if (reservationStatus === 'self_tip') {
      return noStore(badRequest('Cannot tip your own post'))
    }

    const reservation = parseTipReservation(reservationData, canonicalPostId)
    if (!reservation) {
      logger.error('[Tip Checkout] Reservation returned uncertain identity', {
        userId: user.id,
        status: reservationStatus,
      })
      return serviceUnavailable()
    }
    if (reservation.status === 'reservation_expiring') {
      return serviceUnavailable('This tip checkout is expiring. Please retry after it closes.')
    }

    const metadata = {
      type: 'tip',
      tip_id: reservation.tipId,
      user_id: user.id,
      from_user_id: user.id,
      post_id: reservation.postId,
      to_user_id: reservation.toUserId,
      amount_cents: String(amount),
    }

    let sessionId = reservation.checkoutSessionId
    const newlyCreated = !sessionId
    if (!sessionId) {
      try {
        const created = await createOneTimePaymentSession({
          customerId,
          userId: user.id,
          discriminator: 'tip_checkout_v1',
          idempotencyKey: `checkout_tip_v1_${reservation.tipId}`,
          expiresAt: reservation.checkoutExpiresAtSeconds,
          clientReferenceId: reservation.tipId,
          lineItems: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: TIP_PRODUCT_NAME,
                  description: TIP_PRODUCT_DESCRIPTION,
                },
                unit_amount: amount,
              },
              quantity: 1,
            },
          ],
          successUrl: `${env.NEXT_PUBLIC_APP_URL}/tip/success?session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/post/${reservation.postId}?tip_canceled=true`,
          metadata,
        })
        sessionId = created.id
      } catch (error) {
        // Stripe create responses are ambiguous under network failure. Preserve
        // the reservation so the same stable key can recover the same Session.
        logger.warn('[Tip Checkout] Stripe Session create ambiguous; reservation preserved', {
          userId: user.id,
          tipId: reservation.tipId,
          error: error instanceof Error ? error.message : String(error),
        })
        return serviceUnavailable()
      }
    }

    if (!sessionId || !STRIPE_SESSION_ID_PATTERN.test(sessionId)) {
      logger.error('[Tip Checkout] Stripe returned invalid Session identity', {
        userId: user.id,
        tipId: reservation.tipId,
      })
      return serviceUnavailable()
    }

    let verification: TipSessionVerification
    try {
      verification = await verifyFreshTipSession({
        sessionId,
        customerId,
        tipId: reservation.tipId,
        userId: user.id,
        postId: reservation.postId,
        toUserId: reservation.toUserId,
        amountCents: amount,
        expiresAtSeconds: reservation.checkoutExpiresAtSeconds,
      })
    } catch (error) {
      // Retrieval failure does not prove drift. Keep the exact reservation and
      // stable Stripe create identity available for retry.
      logger.error('[Tip Checkout] Fresh Session verification unavailable', {
        userId: user.id,
        tipId: reservation.tipId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return serviceUnavailable()
    }
    if (!verification.ok) {
      await expireSessionBestEffort(sessionId, verification.reason)
      return serviceUnavailable()
    }

    if (newlyCreated) {
      const { data: bindData, error: bindError } = await supabase.rpc(
        'bind_tip_checkout_session_atomic',
        {
          p_tip_id: reservation.tipId,
          p_from_user_id: user.id,
          p_checkout_session_id: sessionId,
          p_checkout_expires_at: reservation.checkoutExpiresAt,
        }
      )
      const bindStatus = rpcRecord(bindData)?.status
      if (
        bindError ||
        !isExactTipSessionBindResult(bindData, {
          tipId: reservation.tipId,
          sessionId,
          expiresAt: reservation.checkoutExpiresAt,
          postId: reservation.postId,
          toUserId: reservation.toUserId,
        })
      ) {
        await expireSessionBestEffort(sessionId, 'tip_checkout_bind_failed')
        logger.error('[Tip Checkout] Session bind failed; URL withheld', {
          userId: user.id,
          tipId: reservation.tipId,
          sessionId,
          status: bindStatus,
          error: bindError?.message,
        })
        return serviceUnavailable()
      }
    }

    return NextResponse.json(
      {
        success: true as const,
        data: {
          checkout: {
            tip_id: reservation.tipId,
            session_id: verification.session.id,
            from_user_id: user.id.toLowerCase(),
            post_id: reservation.postId,
            to_user_id: reservation.toUserId,
            amount_cents: amount,
            currency: 'usd' as const,
            status: 'open' as const,
            url: verification.session.url as string,
            expires_at: reservation.checkoutExpiresAt,
          },
        },
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 200, headers: { 'Cache-Control': NO_STORE } }
    )
  },
  {
    name: 'tip-checkout',
    rateLimit: 'sensitive',
  }
)

export async function POST(request: NextRequest) {
  // Fail closed before authentication, database access, or Stripe work during
  // the atomic Tip checkout cutover. Every runtime requires both the exact
  // server-side flag and live Stripe keys; deployment metadata is not authority.
  if (!isTipCheckoutRuntimeEnabled()) {
    return NextResponse.json(
      {
        error: 'Tip checkout is temporarily unavailable.',
        code: 'TIP_CHECKOUT_UNAVAILABLE',
      },
      {
        status: 503,
        headers: {
          'Cache-Control': NO_STORE,
          'Retry-After': '300',
        },
      }
    )
  }

  return authenticatedPost(request)
}
