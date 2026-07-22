import Stripe from 'stripe'
import { stripe, API_TIER_LIMITS, getStripe } from '@/lib/stripe'
import { joinProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger, type StripeWebhookEventContext } from './shared'
import { getProPlanFromPriceId, updateUserSubscription } from './subscription'
import { mintNFTForUser } from './nft'
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

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const reservationNoncePattern = /^[A-Za-z0-9_.:-]{8,128}$/
const stripeCheckoutIdPattern = /^cs_[A-Za-z0-9_]+$/
const stripeEventIdPattern = /^evt_[A-Za-z0-9_]+$/
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

export async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
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

  if (!userId) {
    logger.error('No userId in session metadata', { metadata: session.metadata })
    throw new Error(`Checkout ${session.id} cannot be mapped to a user`)
  }

  // API tier subscription checkout
  if (session.metadata?.type === 'api_tier') {
    const apiPlan = session.metadata.api_plan
    if (!apiPlan || !['starter', 'pro'].includes(apiPlan)) {
      logger.error('Invalid api_plan in metadata', { metadata: session.metadata })
      throw new Error(`Checkout ${session.id} has invalid API plan metadata`)
    }
    const subscriptionId = session.subscription as string
    if (!subscriptionId || session.payment_status !== 'paid') {
      logger.warn('API checkout completed without a paid subscription', {
        sessionId: session.id,
        subscriptionId,
        paymentStatus: session.payment_status,
      })
      return
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    if (subscription.status !== 'active') {
      logger.warn('API checkout subscription is not active', {
        subscriptionId,
        status: subscription.status,
      })
      return
    }
    await handleApiTierActivation(userId, apiPlan, subscriptionId)
    return
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

  // If user already has an active subscription with a DIFFERENT stripe_subscription_id,
  // cancel the new one automatically to prevent double billing
  const { data: existingSub, error: existingSubError } = await getSupabase()
    .from('subscriptions')
    .select('stripe_subscription_id, status')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .maybeSingle()

  if (existingSubError) {
    throw new Error(`Failed to check existing subscription: ${existingSubError.message}`)
  }

  if (
    existingSub?.stripe_subscription_id &&
    existingSub.stripe_subscription_id !== subscriptionId
  ) {
    // Cancel the NEW subscription to keep the existing one
    await stripe.subscriptions.cancel(subscriptionId)
    logger.warn('Duplicate subscription detected and cancelled', {
      userId,
      existing: existingSub.stripe_subscription_id,
      cancelled: subscriptionId,
    })
    return // Don't update DB with the cancelled subscription
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)

    if (subscription.status !== 'active' && subscription.status !== 'trialing') {
      logger.warn(`Subscription ${subscriptionId} is not active`, { status: subscription.status })
      return
    }

    const priceId = subscription.items.data[0]?.price.id
    const authoritativePlan = getProPlanFromPriceId(priceId)
    if (!authoritativePlan || authoritativePlan === 'lifetime') {
      throw new Error(`Cannot map Stripe price ${priceId || 'missing'} to a subscription plan`)
    }
    if (plan && plan !== authoritativePlan) {
      throw new Error(
        `Checkout plan metadata ${plan} does not match Stripe price plan ${authoritativePlan}`
      )
    }

    await updateUserSubscription(userId, subscription, authoritativePlan)

    try {
      const joinResult = await joinProOfficialGroup(userId)
      if (joinResult.success) {
        logger.info(`User ${userId} joined Pro official group`, { groupId: joinResult.groupId })
      } else {
        throw new Error(`Failed to join Pro official group: ${joinResult.message}`)
      }
    } catch (joinError) {
      logger.error('Error joining Pro official group', { error: joinError })
      throw joinError
    }

    await mintNFTForUser(userId, plan || 'monthly')

    logger.info(`Checkout completed for user ${userId}`, { plan, subscriptionId })

    // Celebrate every new paying subscriber on Telegram. Fire-and-forget so
    // this can never break the checkout flow. Retro 2026-04-09: CEO review
    // flagged that the first paying signal was invisible — this is the fix.
    fireAndForget(
      sendAlert({
        title: '🎉 New paying subscriber',
        message: `Plan: ${plan || 'monthly'} · Subscription: ${subscriptionId}`,
        level: 'info',
        details: {
          userId,
          plan: plan || 'monthly',
          subscriptionId,
          status: subscription.status,
        },
      }),
      'stripe-new-subscriber-alert'
    )
  } catch (err: unknown) {
    logger.error('Failed to process checkout completion', { error: err })
    // Never convert a technical failure into Pro access. Re-throw so the
    // route marks this event failed and Stripe can retry the authoritative
    // subscription lookup and atomic DB update.
    throw err
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
  userId: string,
  apiPlan: string,
  stripeSubscriptionId: string
) {
  const dailyLimit = API_TIER_LIMITS[apiPlan] ?? 100

  logger.info('Activating API tier', { userId, apiPlan, dailyLimit, stripeSubscriptionId })

  await withRetry(async () => {
    const { error } = await getSupabase().rpc('update_user_api_tier', {
      p_user_id: userId,
      p_api_tier: apiPlan,
      p_stripe_subscription_id: stripeSubscriptionId,
      p_daily_limit: dailyLimit,
    })

    if (error) {
      throw new Error(`Failed to update API tier: ${error.message}`)
    }
  })

  logger.info(`API tier activated for user ${userId}`, { apiPlan })

  fireAndForget(
    sendAlert({
      title: '🎉 New API subscriber',
      message: `Plan: ${apiPlan} · User: ${userId}`,
      level: 'info',
      details: { userId, apiPlan, stripeSubscriptionId },
    }),
    'stripe-new-api-subscriber-alert'
  )
}
