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
import {
  callRecurringProRpc,
  carriesRecurringProCheckoutMarker,
  parseRecurringProCheckoutMetadata,
  RECURRING_PRO_RESERVATION_METADATA_KEY,
  recurringProRpcStatus,
  verifyRecurringProCheckoutSession,
  verifyRecurringProSubscription,
} from '@/lib/stripe/recurring-pro-checkout'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const reservationNoncePattern = /^[A-Za-z0-9_.:-]{8,128}$/
const stripeCheckoutIdPattern = /^cs_[A-Za-z0-9_]+$/
const stripeEventIdPattern = /^evt_[A-Za-z0-9_]+$/
const stripeCustomerIdPattern = /^cus_[A-Za-z0-9_]+$/
const stripeSubscriptionIdPattern = /^sub_[A-Za-z0-9_]+$/
const maxStripeUnixSeconds = 253_402_300_799
const apiTierReservationMetadataKey = 'api_tier_reservation_id'
const apiCheckoutMetadataKeys = [
  'api_plan',
  apiTierReservationMetadataKey,
  'supabase_user_id',
  'type',
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

function rpcStatus(value: unknown): string | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? String((value as Record<string, unknown>).status || '')
    : null
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
    !stripeCheckoutIdPattern.test(session.id) ||
    !stripeEventIdPattern.test(event.id) ||
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
    !stripeCustomerIdPattern.test(customerId) ||
    !subscriptionId ||
    !stripeSubscriptionIdPattern.test(subscriptionId)
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
  event?: StripeWebhookEventContext
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

  const recurringProIntent =
    carriesRecurringProCheckoutMarker(session.metadata) || plan === 'monthly' || plan === 'yearly'
  if (recurringProIntent) {
    if (!event) {
      throw new Error(`Recurring Pro checkout ${session.id} is missing signed event identity`)
    }
    const identity = parseRecurringProCheckoutMetadata(session.metadata)
    const customerId = typeof session.customer === 'string' ? session.customer : null
    const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null
    const signedIdentityIsExact =
      !!identity &&
      session.object === 'checkout.session' &&
      stripeCheckoutIdPattern.test(session.id) &&
      session.mode === 'subscription' &&
      session.status === 'complete' &&
      session.livemode === event.livemode &&
      stripeEventIdPattern.test(event.id) &&
      Number.isSafeInteger(event.created) &&
      event.created > 0 &&
      event.created <= maxStripeUnixSeconds &&
      customerId === identity.customerId &&
      !!subscriptionId &&
      stripeSubscriptionIdPattern.test(subscriptionId) &&
      session.client_reference_id === identity.reservationId &&
      (identity.trialRequested
        ? session.payment_status === 'no_payment_required'
        : session.payment_status === 'paid')

    if (!signedIdentityIsExact || !identity || !customerId || !subscriptionId) {
      await recordCompletedCheckoutReview({
        reasonKey: 'recurring_checkout_completion_identity_invalid',
        reason:
          'A recurring Pro Checkout completion had missing, legacy, or conflicting exact identity.',
        context: {
          event_id: event.id,
          event_created: event.created,
          session_id: session.id,
          session_mode: session.mode,
          session_status: session.status,
          payment_status: session.payment_status,
          customer_id: customerId,
          subscription_id: subscriptionId,
          client_reference_id: session.client_reference_id,
          metadata_type: session.metadata?.type || null,
          metadata_plan: plan || null,
          reservation_id: session.metadata?.pro_checkout_reservation_id || null,
        },
      })
      throw new Error(`Recurring Pro checkout ${session.id} failed exact signed identity`)
    }

    const supabase = getSupabaseAdmin()
    const checkoutExpiresAt = session.expires_at
    if (
      !Number.isSafeInteger(checkoutExpiresAt) ||
      !checkoutExpiresAt ||
      checkoutExpiresAt <= 0 ||
      checkoutExpiresAt > maxStripeUnixSeconds
    ) {
      await recordCompletedCheckoutReview({
        reasonKey: 'recurring_checkout_completion_expiry_invalid',
        reason: 'A recurring Pro Checkout completion omitted its exact expiry.',
        context: {
          event_id: event.id,
          session_id: session.id,
          reservation_id: identity.reservationId,
          checkout_expires_at: checkoutExpiresAt || null,
        },
      })
      throw new Error(`Recurring Pro checkout ${session.id} has invalid expiry`)
    }

    let exactSession: Stripe.Checkout.Session
    let exactSubscription: ReturnType<typeof verifyRecurringProSubscription>
    try {
      exactSession = await verifyRecurringProCheckoutSession({
        stripe: getStripe(),
        sessionId: session.id,
        identity,
        livemode: event.livemode,
        checkoutExpiresAtSeconds: checkoutExpiresAt,
        phase: 'complete',
        subscriptionId,
      })
      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      exactSubscription = verifyRecurringProSubscription({
        subscription,
        subscriptionId,
        identity,
        livemode: event.livemode,
        eventCreated: event.created,
        phase: 'checkout_completion',
      })
      if (
        exactSession.id !== session.id ||
        exactSession.client_reference_id !== session.client_reference_id
      ) {
        throw new Error('Fresh Checkout Session does not match the signed completion snapshot')
      }
    } catch (verificationError) {
      await recordCompletedCheckoutReview({
        reasonKey: 'recurring_checkout_completion_verification_failed',
        reason: 'A recurring Pro Checkout or Subscription failed fresh exact Stripe verification.',
        context: {
          event_id: event.id,
          session_id: session.id,
          reservation_id: identity.reservationId,
          subscription_id: subscriptionId,
          error:
            verificationError instanceof Error
              ? verificationError.message
              : String(verificationError),
        },
      })
      throw verificationError
    }

    const completion = await callRecurringProRpc(
      supabase,
      'complete_recurring_pro_checkout_atomic',
      {
        p_user_id: identity.userId,
        p_livemode: event.livemode,
        p_stripe_customer_id: identity.customerId,
        p_stripe_subscription_id: subscriptionId,
        p_reservation_id: identity.reservationId,
        p_operation_id: identity.operationId,
        p_reservation_nonce: identity.nonce,
        p_plan: identity.plan,
        p_stripe_price_id: identity.priceId,
        p_trial_requested: identity.trialRequested,
        p_checkout_session_id: session.id,
        p_stripe_event_id: event.id,
        p_stripe_event_created: event.created,
      }
    )
    if (completion.error) {
      throw new Error(`Failed to complete recurring Pro Checkout: ${completion.error.message}`)
    }
    const completionStatus = recurringProRpcStatus(completion.data)
    if (completionStatus !== 'completed' && completionStatus !== 'already_completed') {
      throw new Error(`Recurring Pro Checkout completion returned ${completionStatus || 'missing'}`)
    }

    if (identity.trialRequested) {
      const trialActivation = await callRecurringProRpc(
        supabase,
        'activate_recurring_trial_entitlement_atomic',
        {
          p_user_id: identity.userId,
          p_stripe_customer_id: identity.customerId,
          p_stripe_subscription_id: subscriptionId,
          p_plan: identity.plan,
          p_period_start: exactSubscription.periodStart,
          p_period_end: exactSubscription.periodEnd,
          p_stripe_subscription_status: exactSubscription.subscription.status,
        }
      )
      if (trialActivation.error) {
        throw new Error(
          `Failed to activate exact recurring Pro trial: ${trialActivation.error.message}`
        )
      }
      const trialStatus = recurringProRpcStatus(trialActivation.data)
      if (trialStatus !== 'activated' && trialStatus !== 'already_activated') {
        throw new Error(`Recurring Pro trial activation returned ${trialStatus || 'missing'}`)
      }
    }

    logger.info('Recurring Pro Checkout reached exact durable completion', {
      userId: identity.userId,
      sessionId: session.id,
      subscriptionId,
      reservationId: identity.reservationId,
      trialRequested: identity.trialRequested,
      completionStatus,
    })
    return
  }

  if (!userId) {
    logger.error('No userId in session metadata', { metadata: session.metadata })
    throw new Error(`Checkout ${session.id} cannot be mapped to a user`)
  }

  if (session.mode === 'subscription' && session.payment_status === 'paid') {
    await recordCompletedCheckoutReview({
      reasonKey: 'paid_subscription_checkout_product_unsupported',
      reason: 'A paid subscription Checkout had no exact supported reservation authority.',
      context: {
        event_id: event?.id || null,
        session_id: session.id,
        plan: plan || null,
        customer_id: customerId || null,
      },
    })
    throw new Error(`Paid subscription Checkout ${session.id} has no exact authority`)
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
      stripeCheckoutIdPattern.test(session.id) &&
      stripeEventIdPattern.test(event.id) &&
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

  if (carriesRecurringProCheckoutMarker(sessionMetadata)) {
    const identity = parseRecurringProCheckoutMetadata(sessionMetadata)
    const customerId = typeof session.customer === 'string' ? session.customer : null
    const metadataIsExact =
      !!identity &&
      session.object === 'checkout.session' &&
      stripeCheckoutIdPattern.test(session.id) &&
      stripeEventIdPattern.test(event.id) &&
      Number.isSafeInteger(event.created) &&
      event.created > 0 &&
      event.created <= maxStripeUnixSeconds &&
      session.mode === 'subscription' &&
      session.status === 'expired' &&
      session.payment_status === 'unpaid' &&
      session.subscription === null &&
      typeof session.livemode === 'boolean' &&
      session.livemode === event.livemode &&
      customerId === identity.customerId &&
      session.client_reference_id === identity.reservationId &&
      Number.isSafeInteger(session.expires_at) &&
      !!session.expires_at &&
      session.expires_at > 0 &&
      session.expires_at <= maxStripeUnixSeconds

    if (!metadataIsExact || !identity || !customerId) {
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        sessionId: session.id || 'unknown_checkout_session',
        userId: identity?.userId || null,
        reasonKey: 'recurring_checkout_expiry_identity_invalid',
        reason:
          'A signed recurring Pro Checkout expiration had malformed or conflicting exact identity.',
        context: {
          event_id: event.id,
          event_created: event.created,
          event_livemode: event.livemode,
          session_id: session.id,
          session_livemode: session.livemode ?? null,
          session_mode: session.mode,
          session_status: session.status,
          payment_status: session.payment_status,
          customer_id: customerId,
          subscription_present: session.subscription !== null,
          client_reference_id: session.client_reference_id,
          metadata_type: sessionMetadata.type || null,
          reservation_id: sessionMetadata[RECURRING_PRO_RESERVATION_METADATA_KEY] || null,
        },
      })
      throw new Error(`Recurring Pro checkout ${session.id} expiry identity is invalid`)
    }

    const release = await callRecurringProRpc(
      getSupabaseAdmin(),
      'release_recurring_pro_checkout_atomic',
      {
        p_user_id: identity.userId,
        p_livemode: event.livemode,
        p_stripe_customer_id: identity.customerId,
        p_reservation_id: identity.reservationId,
        p_operation_id: identity.operationId,
        p_reservation_nonce: identity.nonce,
        p_plan: identity.plan,
        p_stripe_price_id: identity.priceId,
        p_trial_requested: identity.trialRequested,
        p_checkout_session_id: session.id,
        p_stripe_event_id: event.id,
        p_stripe_event_created: event.created,
      }
    )
    if (release.error) {
      throw new Error(`Failed to release recurring Pro Checkout: ${release.error.message}`)
    }
    const releaseStatus = recurringProRpcStatus(release.data)
    if (
      releaseStatus !== 'released' &&
      releaseStatus !== 'already_released' &&
      releaseStatus !== 'already_completed'
    ) {
      throw new Error(`Recurring Pro Checkout release returned ${releaseStatus || 'missing'}`)
    }
    logger.info('Recurring Pro Checkout reservation reached signed expiry terminal state', {
      userId: identity.userId,
      reservationId: identity.reservationId,
      sessionId: session.id,
      eventId: event.id,
      releaseStatus,
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
      stripeCheckoutIdPattern.test(session.id) &&
      stripeEventIdPattern.test(event.id) &&
      eventCreatedIsValid &&
      checkoutExpiresAtIsValid &&
      session.client_reference_id === reservationId &&
      !!customerId &&
      stripeCustomerIdPattern.test(customerId)
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
