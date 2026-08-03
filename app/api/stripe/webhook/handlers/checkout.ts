import Stripe from 'stripe'
import { stripe, API_TIER_LIMITS, getStripe } from '@/lib/stripe'
import { getSupabase, logger, type StripeWebhookEventContext } from './shared'
import {
  applyApiTierStripeEvent,
  resolveApiTierSubscriptionOwner,
  type ApiTierStripeAuthority,
} from './subscription'
import { sendAlert } from '@/lib/alerts/send-alert'
import { fireAndForget } from '@/lib/utils/logger'
import {
  activateLifetimeCheckoutEntitlement,
  lifetimeActivationGranted,
  LIFETIME_RESERVATION_ID_METADATA_KEY,
  LIFETIME_RESERVATION_NONCE_METADATA_KEY,
  recordStripeCheckoutManualReview,
} from '@/lib/stripe/lifetime-entitlement'
import { completeTipCheckout } from '@/lib/stripe/tip-completion'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { Json } from '@/lib/supabase/database.types'
import { activateExactRecurringCheckout } from '@/lib/stripe/recurring-entitlement'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const reservationNoncePattern = /^[A-Za-z0-9_.:-]{8,128}$/
const stripeCheckoutIdPattern = /^cs_[A-Za-z0-9_]+$/
const stripeEventIdPattern = /^evt_[A-Za-z0-9_]+$/
const stripeCustomerIdPattern = /^cus_[A-Za-z0-9_]+$/
const stripeSubscriptionIdPattern = /^sub_[A-Za-z0-9_]+$/
const stripePriceIdPattern = /^price_[A-Za-z0-9_]+$/
const maxStripeUnixSeconds = 253_402_300_799
const delayedPaidProStatuses = new Set<Stripe.Subscription.Status>([
  'active',
  'past_due',
  'unpaid',
  'paused',
  'canceled',
  'incomplete_expired',
])
const delayedTrialProStatuses = new Set<Stripe.Subscription.Status>([
  'trialing',
  ...delayedPaidProStatuses,
])
const apiTierReservationMetadataKey = 'api_tier_reservation_id'
const proMembershipReservationMetadataKey = 'pro_membership_reservation_id'
const proMembershipPriceMetadataKey = 'pro_price_id'
const apiCheckoutMetadataKeys = [
  'api_plan',
  apiTierReservationMetadataKey,
  'supabase_user_id',
  'type',
  'userId',
] as const
const proCheckoutMetadataKeys = [
  'currency',
  'plan',
  proMembershipReservationMetadataKey,
  proMembershipPriceMetadataKey,
  'supabase_user_id',
  'trial_days',
  'type',
  'unit_amount',
  'userId',
] as const
const tipExpiryMetadataKeys = [
  'amount_cents',
  'from_user_id',
  'post_id',
  'tip_id',
  'to_user_id',
  'type',
  'user_id',
] as const

class DeterministicProCheckoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeterministicProCheckoutError'
  }
}

function rpcStatus(value: unknown): string | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? String((value as Record<string, unknown>).status || '')
    : null
}

function exactRpcString(value: unknown, key: string): string | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : null
}

function exactStripeIdentifier(value: unknown, pattern: RegExp): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length <= 255 &&
    pattern.test(value)
  )
}

function canonicalUuid(value: string | null | undefined): string | null {
  const candidate = value?.trim()
  return candidate && uuidPattern.test(candidate) ? candidate.toLowerCase() : null
}

function exactCanonicalLowerUuid(value: string | null | undefined): string | null {
  return value && value === value.trim() && value === value.toLowerCase() && uuidPattern.test(value)
    ? value
    : null
}

function isEmptyStripeCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

function exactStripeUnixSeconds(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maxStripeUnixSeconds
    ? value
    : null
}

type ProCheckoutIdentity = {
  userId: string
  reservationId: string
  customerId: string
  subscriptionId: string
  plan: 'monthly' | 'yearly'
  priceId: string
  unitAmount: number
  currency: 'usd'
  trialDays: 0 | 7
}

function carriesProCheckoutIdentity(metadata: Stripe.Metadata | null | undefined): boolean {
  const candidate = metadata || {}
  return (
    Object.prototype.hasOwnProperty.call(candidate, proMembershipReservationMetadataKey) ||
    Object.prototype.hasOwnProperty.call(candidate, proMembershipPriceMetadataKey)
  )
}

function parseProCheckoutCompletionIdentity(
  session: Stripe.Checkout.Session,
  event: StripeWebhookEventContext
): ProCheckoutIdentity {
  const metadata = session.metadata || {}
  const metadataKeys = Object.keys(metadata).sort()
  const metadataUserId = exactCanonicalLowerUuid(metadata.userId)
  const metadataSupabaseUserId = exactCanonicalLowerUuid(metadata.supabase_user_id)
  const reservationId = exactCanonicalLowerUuid(metadata[proMembershipReservationMetadataKey])
  const customerId = typeof session.customer === 'string' ? session.customer : null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
  const trialDays = metadata.trial_days === '7' ? 7 : metadata.trial_days === '0' ? 0 : null
  const unitAmount = Number(metadata.unit_amount)
  const eventCreatedIsValid =
    Number.isSafeInteger(event.created) &&
    event.created > 0 &&
    event.created <= maxStripeUnixSeconds

  if (
    session.object !== 'checkout.session' ||
    session.mode !== 'subscription' ||
    session.status !== 'complete' ||
    (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') ||
    typeof session.livemode !== 'boolean' ||
    session.livemode !== event.livemode ||
    !exactStripeIdentifier(session.id, stripeCheckoutIdPattern) ||
    !exactStripeIdentifier(event.id, stripeEventIdPattern) ||
    !eventCreatedIsValid ||
    metadataKeys.length !== proCheckoutMetadataKeys.length ||
    !proCheckoutMetadataKeys.every((key, index) => metadataKeys[index] === key) ||
    metadata.type !== 'pro_membership' ||
    (metadata.plan !== 'monthly' && metadata.plan !== 'yearly') ||
    !metadataUserId ||
    !metadataSupabaseUserId ||
    metadataUserId !== metadataSupabaseUserId ||
    Object.prototype.hasOwnProperty.call(metadata, 'user_id') ||
    !reservationId ||
    session.client_reference_id !== reservationId ||
    !customerId ||
    !exactStripeIdentifier(customerId, stripeCustomerIdPattern) ||
    !subscriptionId ||
    !exactStripeIdentifier(subscriptionId, stripeSubscriptionIdPattern) ||
    !exactStripeIdentifier(metadata[proMembershipPriceMetadataKey], stripePriceIdPattern) ||
    metadata.currency !== 'usd' ||
    !/^[1-9][0-9]{0,11}$/.test(metadata.unit_amount || '') ||
    !Number.isSafeInteger(unitAmount) ||
    trialDays === null
  ) {
    throw new DeterministicProCheckoutError(
      `Pro checkout ${session.id} has invalid exact reservation identity`
    )
  }

  return {
    userId: metadataUserId,
    reservationId,
    customerId,
    subscriptionId,
    plan: metadata.plan,
    priceId: metadata[proMembershipPriceMetadataKey],
    unitAmount,
    currency: 'usd',
    trialDays,
  }
}

async function convertExactProCheckout(
  session: Stripe.Checkout.Session,
  event: StripeWebhookEventContext
) {
  const identity = parseProCheckoutCompletionIdentity(session, event)
  const stripeClient = getStripe()
  const subscription = await stripeClient.subscriptions.retrieve(identity.subscriptionId)
  const subscriptionCustomerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
  const sessionCreated = exactStripeUnixSeconds(session.created)
  const subscriptionCreatedIsValid =
    Number.isSafeInteger(subscription.created) &&
    subscription.created > 0 &&
    sessionCreated !== null &&
    subscription.created >= sessionCreated &&
    subscription.created <= event.created
  const expectedAmount = identity.unitAmount
  const dueNow = identity.trialDays === 7 ? 0 : expectedAmount
  const trialStart = exactStripeUnixSeconds(subscription.trial_start)
  const trialEnd = exactStripeUnixSeconds(subscription.trial_end)
  const completionTermsMatch =
    identity.trialDays === 7
      ? session.payment_status === 'no_payment_required' &&
        delayedTrialProStatuses.has(subscription.status) &&
        trialStart !== null &&
        trialEnd !== null &&
        trialEnd - trialStart === 7 * 24 * 60 * 60
      : session.payment_status === 'paid' && delayedPaidProStatuses.has(subscription.status)
  // Current Subscription product/metadata/cancellation fields are mutable.
  // The signed Session plus its exact durable reservation are the immutable
  // purchase identity; downstream authority re-fetches that Session, its line
  // item, and the initial paid Invoice before granting anything.
  const exact =
    subscription.id === identity.subscriptionId &&
    subscription.object === 'subscription' &&
    exactStripeIdentifier(subscription.id, stripeSubscriptionIdPattern) &&
    subscription.livemode === event.livemode &&
    subscriptionCustomerId === identity.customerId &&
    subscriptionCreatedIsValid &&
    completionTermsMatch &&
    session.currency === identity.currency &&
    session.amount_subtotal === dueNow &&
    session.amount_total === dueNow &&
    session.total_details?.amount_discount === 0 &&
    session.total_details.amount_shipping === 0 &&
    session.total_details.amount_tax === 0 &&
    session.allow_promotion_codes === false &&
    session.automatic_tax?.enabled === false &&
    session.adaptive_pricing?.enabled !== true &&
    session.after_expiration === null &&
    session.recovered_from === null &&
    isEmptyStripeCollection(session.discounts) &&
    isEmptyStripeCollection(session.optional_items) &&
    Array.isArray(session.custom_fields) &&
    session.custom_fields.length === 0

  if (!exact) {
    throw new DeterministicProCheckoutError(
      `Pro subscription ${subscription.id} does not match its exact checkout`
    )
  }

  const { data, error } = await getSupabaseAdmin().rpc(
    'convert_pro_membership_checkout_reservation_atomic',
    {
      p_reservation_id: identity.reservationId,
      p_user_id: identity.userId,
      p_livemode: event.livemode,
      p_stripe_customer_id: identity.customerId,
      p_pro_plan: identity.plan,
      p_stripe_price_id: identity.priceId,
      p_unit_amount: identity.unitAmount,
      p_currency: identity.currency,
      p_trial_days: identity.trialDays,
      p_checkout_session_id: session.id,
      p_stripe_subscription_id: identity.subscriptionId,
      p_payment_status: session.payment_status,
      p_subscription_status: subscription.status,
      p_trial_start: identity.trialDays === 7 ? trialStart : null,
      p_trial_end: identity.trialDays === 7 ? trialEnd : null,
      p_stripe_event_id: event.id,
      p_stripe_event_created: event.created,
    }
  )
  if (error) {
    if (
      error.code === '40001' ||
      error.code === '22023' ||
      error.code === '23505' ||
      error.code === '23514'
    ) {
      throw new DeterministicProCheckoutError(
        `Pro Checkout reservation identity conflicted: ${error.message}`
      )
    }
    throw new Error(`Failed to convert Pro Checkout reservation: ${error.message}`)
  }
  const status = rpcStatus(data)
  const effectiveSubscriptionStatus = exactRpcString(data, 'effective_subscription_status')
  const observation = exactRpcString(data, 'observation')
  const exactResult =
    (status === 'converted' && observation === 'recorded') ||
    (status === 'already_converted' &&
      (observation === 'replayed' || observation === 'observed' || observation === 'tightened'))
  if (!exactResult || effectiveSubscriptionStatus !== subscription.status) {
    throw new DeterministicProCheckoutError(
      `Pro Checkout reservation conversion returned an uncertain effective state (${status || 'missing'}, ${effectiveSubscriptionStatus || 'missing'})`
    )
  }
  return identity
}

type ApiCheckoutIdentity = {
  userId: string
  reservationId: string
  customerId: string
  subscriptionId: string
  metadataPlan: 'starter' | 'pro'
}

function carriesApiCheckoutIdentity(metadata: Stripe.Metadata | null | undefined): boolean {
  const candidate = metadata || {}
  return (
    candidate.type === 'api_tier' ||
    Object.prototype.hasOwnProperty.call(candidate, 'api_plan') ||
    Object.prototype.hasOwnProperty.call(candidate, apiTierReservationMetadataKey)
  )
}

function parseApiCheckoutCompletionIdentity(
  session: Stripe.Checkout.Session,
  event: StripeWebhookEventContext
): ApiCheckoutIdentity {
  const metadata = session.metadata || {}
  const metadataKeys = Object.keys(metadata).sort()
  const metadataUserId = exactCanonicalLowerUuid(metadata.userId)
  const metadataSupabaseUserId = exactCanonicalLowerUuid(metadata.supabase_user_id)
  const reservationId = exactCanonicalLowerUuid(metadata[apiTierReservationMetadataKey])
  const customerId = typeof session.customer === 'string' ? session.customer : null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
  const eventCreatedIsValid =
    Number.isSafeInteger(event.created) &&
    event.created > 0 &&
    event.created <= maxStripeUnixSeconds

  if (
    session.object !== 'checkout.session' ||
    session.mode !== 'subscription' ||
    session.status !== 'complete' ||
    session.payment_status !== 'paid' ||
    session.livemode !== event.livemode ||
    !exactStripeIdentifier(session.id, stripeCheckoutIdPattern) ||
    !exactStripeIdentifier(event.id, stripeEventIdPattern) ||
    !eventCreatedIsValid ||
    metadataKeys.length !== apiCheckoutMetadataKeys.length ||
    !apiCheckoutMetadataKeys.every((key, index) => metadataKeys[index] === key) ||
    metadata.type !== 'api_tier' ||
    (metadata.api_plan !== 'starter' && metadata.api_plan !== 'pro') ||
    !metadataUserId ||
    !metadataSupabaseUserId ||
    metadataUserId !== metadataSupabaseUserId ||
    Object.prototype.hasOwnProperty.call(metadata, 'user_id') ||
    !reservationId ||
    session.client_reference_id !== reservationId ||
    !customerId ||
    !exactStripeIdentifier(customerId, stripeCustomerIdPattern) ||
    !subscriptionId ||
    !exactStripeIdentifier(subscriptionId, stripeSubscriptionIdPattern)
  ) {
    throw new Error(`API checkout ${session.id} has invalid exact entitlement identity`)
  }

  return {
    userId: metadataUserId,
    reservationId,
    customerId,
    subscriptionId,
    metadataPlan: metadata.api_plan,
  }
}

export function carriesTipCheckoutIdentity(metadata: Stripe.Metadata | null | undefined): boolean {
  const candidate = metadata || {}
  return (
    candidate.type === 'tip' ||
    Object.prototype.hasOwnProperty.call(candidate, 'tip_id') ||
    (Object.prototype.hasOwnProperty.call(candidate, 'from_user_id') &&
      Object.prototype.hasOwnProperty.call(candidate, 'post_id') &&
      Object.prototype.hasOwnProperty.call(candidate, 'to_user_id'))
  )
}

export async function handleCheckoutComplete(
  session: Stripe.Checkout.Session,
  event?: StripeWebhookEventContext,
  options?: { reportProReservationConversion?: boolean }
) {
  const rawUserId = session.metadata?.userId
  const rawSupabaseUserId = session.metadata?.supabase_user_id
  const metadataUserId = canonicalUuid(rawUserId)
  const metadataSupabaseUserId = canonicalUuid(rawSupabaseUserId)
  const canonicalAliasesMatch =
    !!metadataUserId && !!metadataSupabaseUserId && metadataUserId === metadataSupabaseUserId
  const canonicalPaymentUserId = canonicalAliasesMatch ? metadataUserId : null
  const userId = rawUserId || rawSupabaseUserId
  const plan = session.metadata?.plan
  const customerId = session.customer as string
  const paidOneTime = session.mode === 'payment' && session.payment_status === 'paid'
  const hasLifetimeReservationMarker =
    Object.prototype.hasOwnProperty.call(
      session.metadata || {},
      LIFETIME_RESERVATION_ID_METADATA_KEY
    ) ||
    Object.prototype.hasOwnProperty.call(
      session.metadata || {},
      LIFETIME_RESERVATION_NONCE_METADATA_KEY
    )
  const lifetimeIntent =
    session.mode === 'payment' && (plan === 'lifetime' || hasLifetimeReservationMarker)

  logger.info('Checkout completed', {
    userId,
    plan,
    customerId,
    sessionId: session.id,
    paymentStatus: session.payment_status,
    mode: session.mode,
    subscription: session.subscription,
  })

  const recordCompletedCheckoutReview = async (params: {
    reasonKey: string
    reason: string
    context: Json
  }) =>
    recordStripeCheckoutManualReview({
      supabase: getSupabaseAdmin(),
      sessionId: session.id || 'unknown_checkout_session',
      userId: canonicalPaymentUserId,
      reasonKey: params.reasonKey,
      reason: params.reason,
      context: params.context,
    })

  if (lifetimeIntent) {
    if (!paidOneTime) {
      logger.warn('Lifetime checkout completed without payment', {
        sessionId: session.id,
        paymentStatus: session.payment_status,
      })
      return
    }

    const reservationId = canonicalUuid(session.metadata?.[LIFETIME_RESERVATION_ID_METADATA_KEY])
    const reservationNonce =
      session.metadata?.[LIFETIME_RESERVATION_NONCE_METADATA_KEY]?.trim() || null
    const lifetimeMetadataIsExact =
      canonicalAliasesMatch &&
      plan === 'lifetime' &&
      !!reservationId &&
      !!reservationNonce &&
      reservationNoncePattern.test(reservationNonce)

    if (!lifetimeMetadataIsExact || !canonicalPaymentUserId) {
      await recordCompletedCheckoutReview({
        reasonKey: 'lifetime_checkout_metadata_invalid',
        reason:
          'A paid lifetime Checkout Session had missing, malformed, or conflicting entitlement metadata.',
        context: {
          session_id: session.id,
          mode: session.mode,
          payment_status: session.payment_status,
          plan: plan || null,
          metadata_user_id: rawUserId || null,
          metadata_supabase_user_id: rawSupabaseUserId || null,
          reservation_id: session.metadata?.[LIFETIME_RESERVATION_ID_METADATA_KEY] || null,
          reservation_nonce: session.metadata?.[LIFETIME_RESERVATION_NONCE_METADATA_KEY] || null,
        },
      })
      return
    }

    const outcome = await handleLifetimePayment(session, canonicalPaymentUserId)
    if (!lifetimeActivationGranted(outcome.status)) {
      logger.warn('Lifetime checkout reached a safe non-grant terminal state', {
        userId: canonicalPaymentUserId,
        sessionId: session.id,
        status: outcome.status,
        reviewCode: outcome.reviewCode,
      })
    }
    return
  }

  if (paidOneTime) {
    await recordCompletedCheckoutReview({
      reasonKey: 'paid_checkout_product_unsupported',
      reason: 'A paid one-time Checkout Session had no supported exact product mapping.',
      context: {
        session_id: session.id,
        mode: session.mode,
        payment_status: session.payment_status,
        plan: plan || null,
        metadata_type: session.metadata?.type || null,
        metadata_user_id: rawUserId || null,
        metadata_supabase_user_id: rawSupabaseUserId || null,
      },
    })
    return
  }

  // API tier subscription checkout
  if (carriesApiCheckoutIdentity(session.metadata)) {
    if (session.payment_status !== 'paid') {
      logger.warn('API checkout completed without a paid subscription', {
        sessionId: session.id,
        subscriptionId: session.subscription,
        paymentStatus: session.payment_status,
      })
      return
    }
    if (!event) {
      throw new Error(`API checkout ${session.id} is missing its signed event identity`)
    }
    const checkoutIdentity = parseApiCheckoutCompletionIdentity(session, event)
    const subscription = await stripe.subscriptions.retrieve(checkoutIdentity.subscriptionId)
    if (subscription.status !== 'active') {
      logger.warn('API checkout subscription is not active', {
        subscriptionId: checkoutIdentity.subscriptionId,
        status: subscription.status,
      })
      return
    }
    const { authority } = await resolveApiTierSubscriptionOwner(subscription)
    if (
      subscription.id !== checkoutIdentity.subscriptionId ||
      subscription.livemode !== session.livemode ||
      authority.userId !== checkoutIdentity.userId ||
      authority.stripeCustomerId !== checkoutIdentity.customerId ||
      authority.checkoutReservationId !== checkoutIdentity.reservationId ||
      subscription.metadata.api_plan !== checkoutIdentity.metadataPlan
    ) {
      throw new Error(`API subscription ${subscription.id} identity does not match its checkout`)
    }
    await handleApiTierActivation(authority, subscription, event)
    return
  }

  // Ordinary B2C Pro Checkout first consumes the durable reservation that
  // admitted the Session. It then enters the one atomic recurring authority;
  // no direct projection write, cancellation, group mutation, or NFT side
  // effect is allowed on this webhook path.
  let exactRecurringUserId = canonicalPaymentUserId
  let proReservationConverted = false
  if (carriesProCheckoutIdentity(session.metadata)) {
    if (!event) {
      throw new Error(`Pro checkout ${session.id} is missing its signed event identity`)
    }
    let identity: ProCheckoutIdentity
    try {
      identity = await convertExactProCheckout(session, event)
    } catch (error) {
      if (!(error instanceof DeterministicProCheckoutError)) throw error
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        sessionId: session.id || event.id,
        userId: canonicalPaymentUserId,
        reasonKey: 'pro_checkout_completion_identity_invalid',
        reason: error.message,
        context: {
          event_id: event.id,
          event_created: event.created,
          event_livemode: event.livemode,
          session_id: session.id,
          session_mode: session.mode,
          session_status: session.status,
          session_payment_status: session.payment_status,
          session_livemode: session.livemode,
          session_amount_subtotal: session.amount_subtotal ?? null,
          session_amount_total: session.amount_total ?? null,
          session_customer_id:
            typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
          session_subscription_id:
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription?.id || null,
          metadata: (session.metadata || {}) as Json,
        },
      })
      logger.warn('Pro checkout deterministic identity conflict was durably reviewed', {
        sessionId: session.id,
        eventId: event.id,
      })
      return
    }
    exactRecurringUserId = identity.userId
    proReservationConverted = true
  }

  if (!userId || !exactRecurringUserId) {
    logger.error('No userId in session metadata', { metadata: session.metadata })
    throw new Error(`Checkout ${session.id} cannot be mapped to a user`)
  }

  if (session.mode !== 'subscription') {
    logger.warn(`Session ${session.id} is not a subscription`, { mode: session.mode })
    return
  }

  const subscriptionId = session.subscription as string
  if (!subscriptionId) {
    logger.error('No subscription ID in checkout session')
    throw new Error(`Checkout ${session.id} is missing its subscription ID`)
  }
  if (!event) {
    throw new Error(`Recurring checkout ${session.id} is missing its signed event identity`)
  }

  const outcome = await activateExactRecurringCheckout({
    stripe: getStripe(),
    supabase: getSupabaseAdmin(),
    session,
    event,
    expectedUserId: exactRecurringUserId,
  })
  logger.info('Recurring checkout reached durable atomic authority', {
    userId: exactRecurringUserId,
    sessionId: session.id,
    subscriptionId,
    status: outcome.status,
    reviewCode: outcome.reviewCode,
  })
  if (options?.reportProReservationConversion) {
    return {
      status: proReservationConverted
        ? ('pro_reservation_converted' as const)
        : ('not_pro' as const),
    }
  }
}

export async function handleTipPaymentCompleted(
  session: Stripe.Checkout.Session,
  event: StripeWebhookEventContext
) {
  const outcome = await completeTipCheckout({
    stripe: getStripe(),
    supabase: getSupabaseAdmin(),
    sessionId: session.id,
    eventId: event.id,
    eventLivemode: event.livemode,
    snapshotLivemode: session.livemode,
  })
  logger.info('Tip checkout reached a durable terminal state', {
    sessionId: session.id,
    eventId: event.id,
    status: outcome.status,
    reviewCode: outcome.reviewCode,
  })
  return outcome
}

export async function handleCheckoutExpired(
  session: Stripe.Checkout.Session,
  event: StripeWebhookEventContext
) {
  const sessionMetadata = session.metadata || {}

  // Tip expiration is a signed financial lifecycle transition. Handle it
  // before generic funnel abandonment so it cannot be reduced to analytics.
  if (carriesTipCheckoutIdentity(sessionMetadata)) {
    const tipId = exactCanonicalLowerUuid(sessionMetadata.tip_id)
    const userId = exactCanonicalLowerUuid(sessionMetadata.user_id)
    const fromUserId = exactCanonicalLowerUuid(sessionMetadata.from_user_id)
    const postId = exactCanonicalLowerUuid(sessionMetadata.post_id)
    const toUserId = exactCanonicalLowerUuid(sessionMetadata.to_user_id)
    const amountCents = Number(sessionMetadata.amount_cents)
    const metadataKeys = Object.keys(sessionMetadata).sort()
    const eventCreatedIsValid =
      Number.isSafeInteger(event.created) && event.created > 0 && event.created <= 253_402_300_799
    const sessionExpiresAtIsValid =
      Number.isSafeInteger(session.expires_at) &&
      Number(session.expires_at) > 0 &&
      Number(session.expires_at) <= 253_402_300_799
    const metadataIsExact =
      metadataKeys.length === tipExpiryMetadataKeys.length &&
      tipExpiryMetadataKeys.every((key, index) => metadataKeys[index] === key) &&
      sessionMetadata.type === 'tip' &&
      !!tipId &&
      !!userId &&
      !!fromUserId &&
      userId === fromUserId &&
      !!postId &&
      !!toUserId &&
      Number.isSafeInteger(amountCents) &&
      amountCents >= 100 &&
      amountCents <= 50000 &&
      sessionMetadata.amount_cents === String(amountCents) &&
      session.object === 'checkout.session' &&
      session.mode === 'payment' &&
      session.status === 'expired' &&
      session.payment_status === 'unpaid' &&
      session.subscription === null &&
      session.livemode === true &&
      event.livemode === true &&
      session.livemode === event.livemode &&
      exactStripeIdentifier(session.id, stripeCheckoutIdPattern) &&
      exactStripeIdentifier(event.id, stripeEventIdPattern) &&
      eventCreatedIsValid &&
      sessionExpiresAtIsValid &&
      session.client_reference_id === tipId

    if (!metadataIsExact || !tipId || !fromUserId || !postId || !toUserId || !session.expires_at) {
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        sessionId: session.id || 'unknown_checkout_session',
        userId: userId && userId === fromUserId ? userId : null,
        reasonKey: 'tip_checkout_expiry_metadata_invalid',
        reason: 'An expired Tip Checkout Session had incomplete or malformed exact identity.',
        context: {
          event_id: event.id,
          event_created: event.created,
          event_livemode: event.livemode,
          session_id: session.id,
          session_livemode: session.livemode ?? null,
          session_mode: session.mode ?? null,
          session_status: session.status ?? null,
          session_payment_status: session.payment_status ?? null,
          session_subscription_present: session.subscription !== null,
          client_reference_id: session.client_reference_id || null,
          checkout_expires_at: session.expires_at || null,
          metadata_type: sessionMetadata.type || null,
          metadata_tip_id: sessionMetadata.tip_id || null,
          metadata_user_id: sessionMetadata.user_id || null,
          metadata_from_user_id: sessionMetadata.from_user_id || null,
          metadata_post_id: sessionMetadata.post_id || null,
          metadata_to_user_id: sessionMetadata.to_user_id || null,
          metadata_amount_cents: sessionMetadata.amount_cents || null,
        },
      })
      return
    }

    const { data, error } = await getSupabaseAdmin().rpc('expire_pending_tip_checkout_atomic', {
      p_tip_id: tipId,
      p_from_user_id: fromUserId,
      p_post_id: postId,
      p_to_user_id: toUserId,
      p_amount_cents: amountCents,
      p_checkout_session_id: session.id,
      p_checkout_expires_at: new Date(session.expires_at * 1000).toISOString(),
      p_event_id: event.id,
      p_event_created_at: new Date(event.created * 1000).toISOString(),
    })
    if (error) {
      throw new Error(`Failed to expire pending Tip checkout: ${error.message}`)
    }
    const status = rpcStatus(data)
    const acceptedStatuses = new Set([
      'expired',
      'already_expired',
      'identity_conflict',
      'already_terminal',
      'not_found',
    ])
    if (!acceptedStatuses.has(String(status))) {
      throw new Error(`Tip checkout expiry returned unexpected status ${status || 'missing'}`)
    }
    logger.info('Tip checkout expiry reached a durable terminal state', {
      sessionId: session.id,
      eventId: event.id,
      tipId,
      status,
    })
    return
  }

  // API Checkout reservation expiration is also a signed entitlement
  // lifecycle transition. It must release the exact reservation instead of
  // falling through to generic abandonment analytics.
  if (carriesApiCheckoutIdentity(sessionMetadata)) {
    const metadataKeys = Object.keys(sessionMetadata).sort()
    const metadataUserId = exactCanonicalLowerUuid(sessionMetadata.userId)
    const metadataSupabaseUserId = exactCanonicalLowerUuid(sessionMetadata.supabase_user_id)
    const reservationId = exactCanonicalLowerUuid(sessionMetadata[apiTierReservationMetadataKey])
    const customerId = typeof session.customer === 'string' ? session.customer : null
    const eventCreatedIsValid =
      Number.isSafeInteger(event.created) &&
      event.created > 0 &&
      event.created <= maxStripeUnixSeconds
    const checkoutExpiresAtIsValid =
      Number.isSafeInteger(session.expires_at) &&
      Number(session.expires_at) > 0 &&
      Number(session.expires_at) <= maxStripeUnixSeconds
    const identityIsExact =
      metadataKeys.length === apiCheckoutMetadataKeys.length &&
      apiCheckoutMetadataKeys.every((key, index) => metadataKeys[index] === key) &&
      sessionMetadata.type === 'api_tier' &&
      (sessionMetadata.api_plan === 'starter' || sessionMetadata.api_plan === 'pro') &&
      !!metadataUserId &&
      metadataUserId === metadataSupabaseUserId &&
      !Object.prototype.hasOwnProperty.call(sessionMetadata, 'user_id') &&
      !!reservationId &&
      session.object === 'checkout.session' &&
      session.mode === 'subscription' &&
      session.status === 'expired' &&
      session.payment_status === 'unpaid' &&
      session.subscription === null &&
      typeof session.livemode === 'boolean' &&
      session.livemode === event.livemode &&
      exactStripeIdentifier(session.id, stripeCheckoutIdPattern) &&
      exactStripeIdentifier(event.id, stripeEventIdPattern) &&
      eventCreatedIsValid &&
      checkoutExpiresAtIsValid &&
      session.client_reference_id === reservationId &&
      !!customerId &&
      exactStripeIdentifier(customerId, stripeCustomerIdPattern)
    const reviewUserId =
      metadataUserId && metadataUserId === metadataSupabaseUserId ? metadataUserId : null

    const recordApiExpiryReview = async (reasonKey: string, reason: string) => {
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        sessionId: session.id || 'unknown_checkout_session',
        userId: reviewUserId,
        reasonKey,
        reason,
        context: {
          event_id: event.id,
          event_created: event.created,
          event_livemode: event.livemode,
          session_id: session.id,
          session_livemode: session.livemode ?? null,
          session_mode: session.mode ?? null,
          session_status: session.status ?? null,
          session_payment_status: session.payment_status ?? null,
          session_subscription_present: session.subscription !== null,
          checkout_expires_at: session.expires_at || null,
          client_reference_id: session.client_reference_id || null,
          stripe_customer_id: customerId,
          metadata_type: sessionMetadata.type || null,
          metadata_api_plan: sessionMetadata.api_plan || null,
          metadata_user_id: sessionMetadata.userId || null,
          metadata_supabase_user_id: sessionMetadata.supabase_user_id || null,
          reservation_id: sessionMetadata[apiTierReservationMetadataKey] || null,
        },
      })
    }

    if (!identityIsExact || !metadataUserId || !reservationId || !customerId) {
      await recordApiExpiryReview(
        'api_tier_expiry_identity_invalid',
        'An expired API tier Checkout Session had incomplete or malformed exact identity.'
      )
      return
    }

    const { data: profile, error: profileError } = await getSupabase()
      .from('user_profiles')
      .select('id, stripe_customer_id')
      .eq('id', metadataUserId)
      .maybeSingle()
    if (profileError) {
      throw new Error(`Failed to verify expired API checkout owner: ${profileError.message}`)
    }
    if (!profile || profile.id !== metadataUserId || profile.stripe_customer_id !== customerId) {
      await recordApiExpiryReview(
        'api_tier_expiry_customer_mismatch',
        'An expired API tier Checkout Session did not match its persisted Stripe customer owner.'
      )
      return
    }

    const { data, error } = await getSupabaseAdmin().rpc(
      'release_api_tier_checkout_reservation_atomic',
      {
        p_reservation_id: reservationId,
        p_user_id: metadataUserId,
        p_livemode: event.livemode,
        p_stripe_customer_id: customerId,
        p_checkout_session_id: session.id,
        p_stripe_event_id: event.id,
        p_stripe_event_created: event.created,
      }
    )
    if (error) {
      throw new Error(`Failed to release expired API tier reservation: ${error.message}`)
    }
    const status = rpcStatus(data)
    if (status !== 'released' && status !== 'already_released') {
      throw new Error(
        `API tier checkout reservation release returned unexpected status ${status || 'missing'}`
      )
    }
    logger.info('API tier Checkout reservation reached a released state', {
      userId: metadataUserId,
      reservationId,
      sessionId: session.id,
      eventId: event.id,
      status,
    })
    return
  }

  // Ordinary Pro reservation expiration is accepted only from the exact
  // signed Stripe snapshot. This also handles the safe case where Stripe
  // created/expired a Session but the database bind response was lost.
  if (carriesProCheckoutIdentity(sessionMetadata)) {
    const metadataKeys = Object.keys(sessionMetadata).sort()
    const metadataUserId = exactCanonicalLowerUuid(sessionMetadata.userId)
    const metadataSupabaseUserId = exactCanonicalLowerUuid(sessionMetadata.supabase_user_id)
    const reservationId = exactCanonicalLowerUuid(
      sessionMetadata[proMembershipReservationMetadataKey]
    )
    const customerId = typeof session.customer === 'string' ? session.customer : null
    const plan = sessionMetadata.plan
    const priceId = sessionMetadata[proMembershipPriceMetadataKey]
    const unitAmount = Number(sessionMetadata.unit_amount)
    const currency = sessionMetadata.currency
    const trialDays =
      sessionMetadata.trial_days === '7' ? 7 : sessionMetadata.trial_days === '0' ? 0 : null
    const eventCreatedIsValid =
      Number.isSafeInteger(event.created) &&
      event.created > 0 &&
      event.created <= maxStripeUnixSeconds
    const checkoutExpiresAtIsValid =
      Number.isSafeInteger(session.expires_at) &&
      Number(session.expires_at) > 0 &&
      Number(session.expires_at) <= maxStripeUnixSeconds
    const identityIsExact =
      metadataKeys.length === proCheckoutMetadataKeys.length &&
      proCheckoutMetadataKeys.every((key, index) => metadataKeys[index] === key) &&
      sessionMetadata.type === 'pro_membership' &&
      (plan === 'monthly' || plan === 'yearly') &&
      !!metadataUserId &&
      metadataUserId === metadataSupabaseUserId &&
      !Object.prototype.hasOwnProperty.call(sessionMetadata, 'user_id') &&
      !!reservationId &&
      !!priceId &&
      exactStripeIdentifier(priceId, stripePriceIdPattern) &&
      currency === 'usd' &&
      /^[1-9][0-9]{0,11}$/.test(sessionMetadata.unit_amount || '') &&
      Number.isSafeInteger(unitAmount) &&
      trialDays !== null &&
      session.object === 'checkout.session' &&
      session.mode === 'subscription' &&
      session.status === 'expired' &&
      session.payment_status === 'unpaid' &&
      session.subscription === null &&
      typeof session.livemode === 'boolean' &&
      session.livemode === event.livemode &&
      exactStripeIdentifier(session.id, stripeCheckoutIdPattern) &&
      exactStripeIdentifier(event.id, stripeEventIdPattern) &&
      eventCreatedIsValid &&
      checkoutExpiresAtIsValid &&
      session.client_reference_id === reservationId &&
      !!customerId &&
      exactStripeIdentifier(customerId, stripeCustomerIdPattern)

    if (
      !identityIsExact ||
      !metadataUserId ||
      !reservationId ||
      !customerId ||
      (plan !== 'monthly' && plan !== 'yearly') ||
      !priceId ||
      currency !== 'usd' ||
      !Number.isSafeInteger(unitAmount) ||
      trialDays === null ||
      !session.expires_at
    ) {
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        sessionId: session.id || 'unknown_checkout_session',
        userId: metadataUserId && metadataUserId === metadataSupabaseUserId ? metadataUserId : null,
        reasonKey: 'pro_checkout_expiry_identity_invalid',
        reason:
          'An expired ordinary Pro Checkout Session had incomplete or malformed exact identity.',
        context: {
          event_id: event.id,
          event_created: event.created,
          event_livemode: event.livemode,
          session_id: session.id,
          session_livemode: session.livemode ?? null,
          session_mode: session.mode ?? null,
          session_status: session.status ?? null,
          session_payment_status: session.payment_status ?? null,
          session_subscription_present: session.subscription !== null,
          checkout_expires_at: session.expires_at || null,
          client_reference_id: session.client_reference_id || null,
          stripe_customer_id: customerId,
          metadata_type: sessionMetadata.type || null,
          metadata_plan: plan || null,
          metadata_price_id: priceId || null,
          metadata_unit_amount: sessionMetadata.unit_amount || null,
          metadata_currency: currency || null,
          metadata_trial_days: sessionMetadata.trial_days || null,
          metadata_user_id: sessionMetadata.userId || null,
          metadata_supabase_user_id: sessionMetadata.supabase_user_id || null,
          reservation_id: sessionMetadata[proMembershipReservationMetadataKey] || null,
        },
      })
      return
    }

    const { data, error } = await getSupabaseAdmin().rpc(
      'release_pro_membership_checkout_reservation_atomic',
      {
        p_reservation_id: reservationId,
        p_user_id: metadataUserId,
        p_livemode: event.livemode,
        p_stripe_customer_id: customerId,
        p_pro_plan: plan,
        p_stripe_price_id: priceId,
        p_unit_amount: unitAmount,
        p_currency: currency,
        p_trial_days: trialDays,
        p_checkout_session_id: session.id,
        p_checkout_expires_at: session.expires_at,
        p_stripe_event_id: event.id,
        p_stripe_event_created: event.created,
      }
    )
    if (error) {
      throw new Error(`Failed to release expired Pro Checkout reservation: ${error.message}`)
    }
    const status = rpcStatus(data)
    if (status !== 'released' && status !== 'already_released') {
      throw new Error(
        `Pro Checkout reservation release returned unexpected status ${status || 'missing'}`
      )
    }
    logger.info('Pro Checkout reservation reached a signed released state', {
      userId: metadataUserId,
      reservationId,
      sessionId: session.id,
      eventId: event.id,
      status,
    })
    return
  }

  const userId = session.metadata?.userId || session.metadata?.supabase_user_id
  const plan = session.metadata?.plan

  logger.warn('Checkout session expired (abandoned)', {
    userId,
    plan,
    sessionId: session.id,
    customerEmail: session.customer_details?.email,
    amountTotal: session.amount_total,
  })

  const carriesLifetimeReservationIdentity =
    Object.prototype.hasOwnProperty.call(sessionMetadata, LIFETIME_RESERVATION_ID_METADATA_KEY) ||
    Object.prototype.hasOwnProperty.call(sessionMetadata, LIFETIME_RESERVATION_NONCE_METADATA_KEY)

  if (plan === 'lifetime' || carriesLifetimeReservationIdentity) {
    const metadataUserId = canonicalUuid(session.metadata?.userId)
    const metadataSupabaseUserId = canonicalUuid(session.metadata?.supabase_user_id)
    const reviewUserId =
      metadataUserId && metadataUserId === metadataSupabaseUserId ? metadataUserId : null
    const reservationId = canonicalUuid(session.metadata?.[LIFETIME_RESERVATION_ID_METADATA_KEY])
    const requestNonce = session.metadata?.[LIFETIME_RESERVATION_NONCE_METADATA_KEY]?.trim() || null
    const eventCreatedIsValid =
      Number.isSafeInteger(event.created) && event.created > 0 && event.created <= 253_402_300_799
    const metadataIsValid =
      plan === 'lifetime' &&
      !!metadataUserId &&
      metadataUserId === metadataSupabaseUserId &&
      !!reservationId &&
      !!requestNonce &&
      reservationNoncePattern.test(requestNonce) &&
      session.id.startsWith('cs_') &&
      event.id.startsWith('evt_') &&
      eventCreatedIsValid

    const recordExpiryReview = async (params: {
      reasonKey: string
      reason: string
      context: Json
    }) => {
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        sessionId: session.id || 'unknown_checkout_session',
        userId: reviewUserId,
        reasonKey: params.reasonKey,
        reason: params.reason,
        context: params.context,
      })
    }

    if (!metadataIsValid) {
      await recordExpiryReview({
        reasonKey: 'lifetime_expiry_metadata_invalid',
        reason: 'An expired lifetime Checkout Session had incomplete or malformed identity.',
        context: {
          event_id: event.id,
          event_created: event.created,
          session_id: session.id,
          plan: plan || null,
          metadata_user_id: session.metadata?.userId || null,
          metadata_supabase_user_id: session.metadata?.supabase_user_id || null,
          reservation_id: session.metadata?.[LIFETIME_RESERVATION_ID_METADATA_KEY] || null,
          request_nonce: session.metadata?.[LIFETIME_RESERVATION_NONCE_METADATA_KEY] || null,
        },
      })
      return
    }
    if (!metadataUserId || !reservationId || !requestNonce) {
      throw new Error('Validated lifetime expiry identity unexpectedly became incomplete')
    }

    const supabaseAdmin = getSupabaseAdmin()
    const exactReleaseArgs = {
      p_user_id: metadataUserId,
      p_reservation_id: reservationId,
      p_request_nonce: requestNonce,
      p_checkout_session_id: session.id,
      p_release_reason: 'stripe_checkout_session_expired',
      p_event_id: event.id,
      p_event_created_at: new Date(event.created * 1000).toISOString(),
    }
    const { data, error } = await supabaseAdmin.rpc(
      'release_lifetime_membership_reservation_atomic',
      exactReleaseArgs
    )
    if (error) {
      throw new Error(`Failed to release expired lifetime reservation: ${error.message}`)
    }

    const acceptedReleaseStatuses = new Set(['released', 'already_released', 'already_expired'])
    const status = rpcStatus(data)
    if (!acceptedReleaseStatuses.has(String(status))) {
      let remediationStatus: string | null = null
      let retryExactStatus: string | null = null
      if (status === 'release_not_verified') {
        const { data: remediationData, error: remediationError } = await supabaseAdmin.rpc(
          'release_lifetime_membership_reservation_atomic',
          {
            p_user_id: metadataUserId,
            p_reservation_id: reservationId,
            p_request_nonce: requestNonce,
            p_checkout_session_id: null,
            p_release_reason: 'stripe_checkout_abandoned',
            p_event_id: null,
            p_event_created_at: null,
          }
        )
        if (remediationError) {
          throw new Error(
            `Failed to remediate an unbound expired lifetime reservation: ${remediationError.message}`
          )
        }
        remediationStatus = rpcStatus(remediationData)
        if (acceptedReleaseStatuses.has(String(remediationStatus))) {
          return
        }
        if (remediationStatus === 'release_not_verified') {
          // The reservation can bind between the first exact transaction and
          // the reserved-state remediation transaction. Replay the same signed
          // identity once so that newly-bound row is released, too.
          const { data: retryExactData, error: retryExactError } = await supabaseAdmin.rpc(
            'release_lifetime_membership_reservation_atomic',
            exactReleaseArgs
          )
          if (retryExactError) {
            throw new Error(
              `Failed to retry exact expired lifetime reservation release: ${retryExactError.message}`
            )
          }
          retryExactStatus = rpcStatus(retryExactData)
          if (acceptedReleaseStatuses.has(String(retryExactStatus))) {
            return
          }
        }
      }

      await recordExpiryReview({
        reasonKey: 'lifetime_expiry_release_conflict',
        reason: 'A signed lifetime Checkout expiration could not release its exact reservation.',
        context: {
          event_id: event.id,
          event_created: event.created,
          session_id: session.id,
          reservation_id: reservationId,
          request_nonce: requestNonce,
          release_status: status,
          remediation_status: remediationStatus,
          retry_exact_status: retryExactStatus,
        },
      })
      return
    }
  }

  // Record abandonment for funnel analysis
  if (userId) {
    const supabase = getSupabase()
    await supabase
      .from('payment_history')
      .insert({
        user_id: userId,
        status: 'abandoned',
        amount: session.amount_total ?? 0,
        currency: session.currency ?? 'usd',
      })
      .then(({ error }) => {
        if (error) logger.warn('Failed to record checkout abandonment', { error: error.message })
      })
  }

  // Alert team about abandoned checkout
  fireAndForget(
    sendAlert({
      title: '⚠️ Checkout abandoned',
      message: `Plan: ${plan || 'unknown'} · User: ${userId || 'anonymous'} · Amount: $${((session.amount_total ?? 0) / 100).toFixed(2)}`,
      level: 'warning',
      details: {
        userId,
        plan: plan || 'unknown',
        sessionId: session.id,
        email: session.customer_details?.email,
      },
    }),
    'stripe-checkout-abandoned-alert'
  )
}

async function handleLifetimePayment(session: Stripe.Checkout.Session, userId: string) {
  logger.info('Processing exact lifetime payment authority', {
    userId,
    sessionId: session.id,
  })
  return activateLifetimeCheckoutEntitlement({
    stripe: getStripe(),
    supabase: getSupabaseAdmin(),
    session,
    expectedUserId: userId,
  })
}

export async function handleApiTierActivation(
  authority: ApiTierStripeAuthority,
  subscription: Stripe.Subscription,
  event: StripeWebhookEventContext
) {
  logger.info('Activating API tier from Checkout', {
    userId: authority.userId,
    apiPlan: authority.plan,
    stripeSubscriptionId: subscription.id,
  })

  await applyApiTierStripeEvent({
    authority,
    plan: authority.plan,
    dailyLimit: API_TIER_LIMITS[authority.plan] ?? API_TIER_LIMITS.free,
    subscription,
    event,
    isActive: true,
    isTerminal: false,
  })

  logger.info(`API tier activated for user ${authority.userId}`, { apiPlan: authority.plan })

  fireAndForget(
    sendAlert({
      title: '🎉 New API subscriber',
      message: `Plan: ${authority.plan} · User: ${authority.userId}`,
      level: 'info',
      details: {
        userId: authority.userId,
        apiPlan: authority.plan,
        stripeSubscriptionId: subscription.id,
      },
    }),
    'stripe-new-api-subscriber-alert'
  )
}
