import type Stripe from 'stripe'
import type { InlineJobResult } from '@/lib/cron/inline-jobs'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  STRIPE_API_PRICE_IDS,
  STRIPE_PRICE_IDS,
  assertProPriceReady,
  assertStripePaymentRuntimeReady,
  createCheckoutSession,
  getStripe,
} from '@/lib/stripe'
import {
  PRO_CHECKOUT_METADATA_KEYS,
  listCompleteCustomerProSubscriptions,
  recoverExpiredProCheckoutReservation,
  stripeCustomerIsExactlyOwned,
  verifyFreshProCheckoutSession,
  type ProCheckoutReservation,
} from '@/lib/stripe/pro-checkout-recovery'

const candidateLimit = 5
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const stripeCustomerIdPattern = /^cus_[A-Za-z0-9_]+$/
const stripePriceIdPattern = /^price_[A-Za-z0-9_]+$/
const maxStripeUnixSeconds = 253_402_300_799
const blockingStatuses = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
  'paused',
])

type RecoveryCandidate = ProCheckoutReservation & {
  userId: string
  customerId: string
  livemode: boolean
  expectedCompletion?: {
    eventId: string
    eventCreated: number
    subscriptionId: string
  }
}

type CandidateOutcome = 'bound' | 'released' | 'converted' | 'preserved' | 'expired_unsafe'

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function exactIdentifier(value: unknown, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length <= 255 &&
    pattern.test(value)
  )
}

function configuredLivemode(): boolean | null {
  const secret = env.STRIPE_SECRET_KEY?.trim()
  if (secret?.startsWith('sk_live_')) return true
  if (secret?.startsWith('sk_test_')) return false
  return null
}

function configuredOrigin(): string | null {
  try {
    const url = new URL(env.NEXT_PUBLIC_APP_URL || '')
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function hasOrigin(value: unknown, origin: string): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).origin === origin
  } catch {
    return false
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function parseCandidates(value: unknown, expectedLivemode: boolean): RecoveryCandidate[] | null {
  const result = record(value)
  if (!result || result.status !== 'claimed' || !Array.isArray(result.candidates)) return null
  if (result.candidates.length > candidateLimit) return null

  const candidates: RecoveryCandidate[] = []
  const reservationIds = new Set<string>()
  const userIds = new Set<string>()
  const customerIds = new Set<string>()
  for (const valueCandidate of result.candidates) {
    const candidate = record(valueCandidate)
    if (!candidate) return null
    const reservationId = candidate.reservation_id
    const status = candidate.status
    const userId = candidate.user_id
    const customerId = candidate.stripe_customer_id
    const plan = candidate.pro_plan
    const priceId = candidate.stripe_price_id
    const unitAmount = candidate.unit_amount
    const trialDays = candidate.trial_days
    const checkoutExpiresAt = candidate.checkout_expires_at
    const checkoutSessionId = candidate.checkout_session_id
    const stripeSubscriptionId = candidate.stripe_subscription_id
    const paymentStatus = candidate.completion_payment_status
    const subscriptionStatus = candidate.subscription_status
    const trialStart = candidate.trial_start
    const trialEnd = candidate.trial_end
    const terminalEventId = candidate.terminal_event_id
    const terminalEventCreated = candidate.terminal_event_created
    const createdAt = candidate.created_at
    const claimedAt = candidate.claimed_at
    const successUrl = candidate.success_url
    const cancelUrl = candidate.cancel_url
    if (
      !exactIdentifier(reservationId, canonicalUuidPattern) ||
      !exactIdentifier(userId, canonicalUuidPattern) ||
      !exactIdentifier(customerId, stripeCustomerIdPattern) ||
      (plan !== 'monthly' && plan !== 'yearly') ||
      !exactIdentifier(priceId, stripePriceIdPattern) ||
      candidate.livemode !== expectedLivemode ||
      candidate.currency !== 'usd' ||
      typeof unitAmount !== 'number' ||
      !Number.isSafeInteger(unitAmount) ||
      unitAmount !== (plan === 'monthly' ? 499 : 2999) ||
      (trialDays !== 0 && trialDays !== 7) ||
      (status !== 'reserved' && status !== 'bound' && status !== 'converted') ||
      typeof checkoutExpiresAt !== 'number' ||
      !Number.isSafeInteger(checkoutExpiresAt) ||
      checkoutExpiresAt > maxStripeUnixSeconds ||
      (checkoutSessionId !== null && !exactIdentifier(checkoutSessionId, /^cs_[A-Za-z0-9_]+$/)) ||
      (status === 'reserved' && checkoutSessionId !== null) ||
      (status === 'bound' && !exactIdentifier(checkoutSessionId, /^cs_[A-Za-z0-9_]+$/)) ||
      (status !== 'converted' &&
        (stripeSubscriptionId !== null ||
          paymentStatus !== null ||
          subscriptionStatus !== null ||
          trialStart !== null ||
          trialEnd !== null ||
          terminalEventId !== null ||
          terminalEventCreated !== null)) ||
      (status === 'converted' &&
        (!exactIdentifier(checkoutSessionId, /^cs_[A-Za-z0-9_]+$/) ||
          !exactIdentifier(stripeSubscriptionId, /^sub_[A-Za-z0-9_]+$/) ||
          !exactIdentifier(terminalEventId, /^evt_[A-Za-z0-9_]+$/) ||
          typeof terminalEventCreated !== 'number' ||
          !Number.isSafeInteger(terminalEventCreated) ||
          terminalEventCreated <= 0 ||
          terminalEventCreated > maxStripeUnixSeconds ||
          ![
            'trialing',
            'active',
            'past_due',
            'unpaid',
            'paused',
            'canceled',
            'incomplete_expired',
          ].includes(String(subscriptionStatus)) ||
          (trialDays === 0 &&
            (paymentStatus !== 'paid' || trialStart !== null || trialEnd !== null)) ||
          (trialDays === 7 &&
            (paymentStatus !== 'no_payment_required' ||
              typeof trialStart !== 'number' ||
              typeof trialEnd !== 'number' ||
              !Number.isSafeInteger(trialStart) ||
              !Number.isSafeInteger(trialEnd) ||
              trialStart <= 0 ||
              trialEnd !== trialStart + 604800)))) ||
      (status !== 'converted' &&
        checkoutExpiresAt > Math.floor(Date.now() / 1000) &&
        (status !== 'reserved' ||
          checkoutSessionId !== null ||
          checkoutExpiresAt <= Math.floor(Date.now() / 1000) + 300)) ||
      typeof createdAt !== 'string' ||
      !Number.isFinite(Date.parse(createdAt)) ||
      typeof claimedAt !== 'string' ||
      !Number.isFinite(Date.parse(claimedAt)) ||
      !isHttpsUrl(successUrl) ||
      !isHttpsUrl(cancelUrl) ||
      reservationIds.has(reservationId) ||
      userIds.has(userId) ||
      customerIds.has(customerId)
    ) {
      return null
    }
    reservationIds.add(reservationId)
    userIds.add(userId)
    customerIds.add(customerId)
    const expectedCompletion =
      status === 'converted'
        ? {
            eventId: terminalEventId as string,
            eventCreated: terminalEventCreated as number,
            subscriptionId: stripeSubscriptionId as string,
          }
        : undefined
    candidates.push({
      status,
      reservationId,
      userId,
      customerId,
      livemode: expectedLivemode,
      plan,
      priceId,
      unitAmount,
      currency: 'usd',
      trialDays,
      successUrl,
      cancelUrl,
      checkoutExpiresAtSeconds: checkoutExpiresAt,
      checkoutSessionId,
      ...(expectedCompletion ? { expectedCompletion } : {}),
    })
  }
  return candidates
}

function metadataFor(candidate: RecoveryCandidate) {
  const metadata: Record<(typeof PRO_CHECKOUT_METADATA_KEYS)[number], string> = {
    currency: candidate.currency,
    plan: candidate.plan,
    pro_membership_reservation_id: candidate.reservationId,
    pro_price_id: candidate.priceId,
    supabase_user_id: candidate.userId,
    trial_days: String(candidate.trialDays),
    type: 'pro_membership',
    unit_amount: String(candidate.unitAmount),
    userId: candidate.userId,
  }
  return metadata
}

async function scanForBlockingAuthority(
  stripeClient: Stripe,
  candidate: RecoveryCandidate,
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<boolean> {
  const proPriceIds = new Set([STRIPE_PRICE_IDS.monthly, STRIPE_PRICE_IDS.yearly])
  const apiPriceIds = new Set(
    Object.values(STRIPE_API_PRICE_IDS).filter((priceId): priceId is string =>
      exactIdentifier(priceId, stripePriceIdPattern)
    )
  )
  if (
    proPriceIds.size !== 2 ||
    [...proPriceIds].some((id) => !exactIdentifier(id, stripePriceIdPattern))
  ) {
    throw new Error('Configured Pro Price identities are not exact')
  }
  const subscriptions = await listCompleteCustomerProSubscriptions({
    stripeClient,
    customerId: candidate.customerId,
    livemode: candidate.livemode,
    proPriceIds,
    apiPriceIds,
    resolveHistoricalAuthority: async (subscription, historicalPrice) => {
      const { data, error } = await supabase.rpc('resolve_b2c_recurring_price_authority', {
        p_stripe_subscription_id: subscription.id,
        p_stripe_price_id: historicalPrice.priceId,
        p_livemode: candidate.livemode,
      })
      if (error) throw new Error(`Historical Pro price authority failed: ${error.message}`)
      const authority = record(data)
      if (authority?.status === 'not_found') return
      const plan = authority?.plan ?? authority?.pro_plan
      if (
        authority?.status !== 'resolved' ||
        authority.user_id !== candidate.userId ||
        authority.stripe_customer_id !== candidate.customerId ||
        authority.stripe_price_id !== historicalPrice.priceId ||
        authority.expected_amount !== historicalPrice.unitAmount ||
        authority.currency !== historicalPrice.currency ||
        (plan !== 'monthly' && plan !== 'yearly') ||
        (authority.source_kind !== 'converted_checkout_reservation' &&
          authority.source_kind !== 'verified_invoice_event')
      ) {
        throw new Error('Historical Pro price authority returned uncertain identity')
      }
    },
  })
  return subscriptions.some(
    ({ subscription }) =>
      blockingStatuses.has(subscription.status) ||
      (candidate.trialDays === 7 &&
        (subscription.trial_start !== null || subscription.trial_end !== null))
  )
}

async function expireExactOpenSession(stripeClient: Stripe, sessionId: string): Promise<boolean> {
  try {
    await stripeClient.checkout.sessions.expire(sessionId)
    return true
  } catch {
    return false
  }
}

async function reconcileCandidate(
  stripeClient: Stripe,
  candidate: RecoveryCandidate
): Promise<CandidateOutcome> {
  const supabase = getSupabaseAdmin()
  if (
    candidate.status === 'converted' ||
    candidate.checkoutExpiresAtSeconds <= Math.floor(Date.now() / 1000)
  ) {
    const outcome = await recoverExpiredProCheckoutReservation({
      stripeClient,
      supabaseAdmin: supabase,
      reservation: candidate,
      userId: candidate.userId,
      customerId: candidate.customerId,
      livemode: candidate.livemode,
      metadata: metadataFor(candidate),
      expectedCompletion: candidate.expectedCompletion,
    })
    return outcome === 'released' || outcome === 'converted' || outcome === 'bound'
      ? outcome
      : 'preserved'
  }

  const origin = configuredOrigin()
  if (
    !origin ||
    !hasOrigin(candidate.successUrl, origin) ||
    !hasOrigin(candidate.cancelUrl, origin)
  ) {
    return 'preserved'
  }
  try {
    await assertProPriceReady(candidate.plan, candidate.priceId)
  } catch {
    return 'preserved'
  }

  const customer = await stripeClient.customers.retrieve(candidate.customerId)
  if (
    !stripeCustomerIsExactlyOwned({
      value: customer,
      expectedCustomerId: candidate.customerId,
      expectedUserId: candidate.userId,
      expectedLivemode: candidate.livemode,
    }) ||
    (await scanForBlockingAuthority(stripeClient, candidate, supabase))
  ) {
    return 'preserved'
  }

  let sessionId: string
  try {
    const created = await createCheckoutSession({
      customerId: candidate.customerId,
      priceId: candidate.priceId,
      successUrl: candidate.successUrl,
      cancelUrl: candidate.cancelUrl,
      metadata: metadataFor(candidate),
      allowPromotionCodes: false,
      ...(candidate.trialDays === 7 ? { trialDays: 7 } : {}),
      idempotencyKey: `pro_membership_checkout_${candidate.livemode ? 'live' : 'test'}_${candidate.reservationId}`,
      expiresAt: candidate.checkoutExpiresAtSeconds,
      clientReferenceId: candidate.reservationId,
    })
    if (!exactIdentifier(created.id, /^cs_[A-Za-z0-9_]+$/)) return 'preserved'
    sessionId = created.id
  } catch {
    return 'preserved'
  }

  const verification = await verifyFreshProCheckoutSession({
    stripeClient,
    sessionId,
    userId: candidate.userId,
    customerId: candidate.customerId,
    livemode: candidate.livemode,
    reservation: candidate,
    metadata: metadataFor(candidate),
  })
  if (!verification.ok) {
    if (verification.safeToExpire && (await expireExactOpenSession(stripeClient, sessionId))) {
      return 'expired_unsafe'
    }
    return 'preserved'
  }

  const freshCustomer = await stripeClient.customers.retrieve(candidate.customerId)
  const authorityChanged =
    !stripeCustomerIsExactlyOwned({
      value: freshCustomer,
      expectedCustomerId: candidate.customerId,
      expectedUserId: candidate.userId,
      expectedLivemode: candidate.livemode,
    }) || (await scanForBlockingAuthority(stripeClient, candidate, supabase))
  if (authorityChanged) {
    return (await expireExactOpenSession(stripeClient, sessionId)) ? 'expired_unsafe' : 'preserved'
  }

  let result:
    | { data: unknown; error: { code?: string; message?: string } | null; status?: number }
    | undefined
  try {
    result = await supabase.rpc('bind_pro_membership_checkout_session_atomic', {
      p_reservation_id: candidate.reservationId,
      p_user_id: candidate.userId,
      p_livemode: candidate.livemode,
      p_stripe_customer_id: candidate.customerId,
      p_pro_plan: candidate.plan,
      p_stripe_price_id: candidate.priceId,
      p_unit_amount: candidate.unitAmount,
      p_currency: candidate.currency,
      p_trial_days: candidate.trialDays,
      p_checkout_session_id: sessionId,
      p_checkout_expires_at: candidate.checkoutExpiresAtSeconds,
    })
  } catch {
    return 'preserved'
  }
  const status = record(result.data)?.status
  if (!result.error && (status === 'bound' || status === 'already_bound')) return 'bound'
  const explicitRejection =
    result.error !== null &&
    typeof result.error.code === 'string' &&
    result.error.code.length > 0 &&
    typeof result.status === 'number' &&
    result.status >= 400 &&
    result.status < 600
  if (explicitRejection && (await expireExactOpenSession(stripeClient, sessionId))) {
    return 'expired_unsafe'
  }
  return 'preserved'
}

export async function runProCheckoutRecoveryInline(): Promise<InlineJobResult> {
  const start = Date.now()
  const name = 'pro-checkout-recovery'
  try {
    assertStripePaymentRuntimeReady()
    const livemode = configuredLivemode()
    const origin = configuredOrigin()
    if (livemode === null || !origin)
      throw new Error('Stripe mode or application origin is invalid')

    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase.rpc(
      'claim_pro_membership_checkout_recovery_candidates',
      { p_livemode: livemode, p_limit: candidateLimit }
    )
    if (error) throw new Error(`Recovery candidate query failed: ${error.message}`)
    const candidates = parseCandidates(data, livemode)
    if (!candidates) throw new Error('Recovery candidate query returned uncertain identity')

    const stripeClient = getStripe()
    const outcomes = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          return await reconcileCandidate(stripeClient, candidate)
        } catch {
          return 'preserved' as const
        }
      })
    )
    return {
      name,
      status: 'success',
      durationMs: Date.now() - start,
      detail: {
        attempted: candidates.length,
        bound: outcomes.filter((outcome) => outcome === 'bound').length,
        released: outcomes.filter((outcome) => outcome === 'released').length,
        converted: outcomes.filter((outcome) => outcome === 'converted').length,
        preserved: outcomes.filter((outcome) => outcome === 'preserved').length,
        expiredUnsafe: outcomes.filter((outcome) => outcome === 'expired_unsafe').length,
      },
    }
  } catch (error) {
    return {
      name,
      status: 'error',
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
