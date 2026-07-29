import Stripe from 'stripe'
import { SUBSCRIPTION_STATUS_MAP, API_TIER_LIMITS, stripe } from '@/lib/stripe'
import { leaveProOfficialGroup } from '@/app/api/pro-official-group/route'
import { getSupabase, withRetry, logger, type StripeWebhookEventContext } from './shared'
import { sendNotification } from '@/lib/data/notifications'
import {
  API_TIER_RESERVATION_METADATA_KEY,
  carriesApiTierSubscriptionIdentity,
  hasOwnMetadataKey,
} from './api-tier-identity'
import { getApiPlanFromPriceId, getProPlanFromPriceId } from './stripe-price-identity'
import { API_PRICING } from '@/app/(app)/user-center/membership-config'
import {
  assertRecurringProCheckoutCompleted,
  carriesRecurringProCheckoutMarker,
  parseRecurringProCheckoutMetadata,
  verifyRecurringProSubscription,
} from '@/lib/stripe/recurring-pro-checkout'
import { recordStripeCheckoutManualReview } from '@/lib/stripe/lifetime-entitlement'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export { carriesApiTierSubscriptionIdentity } from './api-tier-identity'
export { getProPlanFromPriceId } from './stripe-price-identity'

export type ApiTierPlan = 'starter' | 'pro'

type ApiTierProfile = {
  id: string
  stripe_customer_id: string | null
}

export type ApiTierStripeAuthority = {
  userId: string
  metadataUserId: string
  metadataSupabaseUserId: string
  stripeCustomerId: string
  checkoutReservationId: string | null
  stripePriceId: string
  plan: ApiTierPlan
}

const API_TIER_RPC_SUCCESS = new Set([
  'applied',
  'stale',
  'idempotent',
  'not_current',
  'subject_deleted',
  'blocked',
])
const API_TIER_PERSISTED_RPC_SUCCESS = new Set([...API_TIER_RPC_SUCCESS, 'not_api'])
const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799
const API_ACTIVE_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing'])
const API_GRACE_STATUSES = new Set<Stripe.Subscription.Status>(['past_due'])
const API_SUSPENDED_STATUSES = new Set<Stripe.Subscription.Status>([
  'incomplete',
  'paused',
  'unpaid',
])
const API_TERMINAL_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const STRIPE_CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/
const STRIPE_PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]+$/
const API_CHECKOUT_METADATA_KEYS = [
  'api_plan',
  API_TIER_RESERVATION_METADATA_KEY,
  'supabase_user_id',
  'type',
  'userId',
] as const

function exactCanonicalUuid(value: string | null | undefined): string | null {
  return value &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    UUID_PATTERN.test(value)
    ? value
    : null
}

export function parseApiTierSubscriptionAuthority(
  subscription: Stripe.Subscription,
  options: { allowHistoricalPriceForNonGrant?: boolean } = {}
): ApiTierStripeAuthority {
  const metadata = subscription.metadata || {}
  const metadataKeys = Object.keys(metadata).sort()
  const metadataUserId = exactCanonicalUuid(metadata.userId)
  const metadataSupabaseUserId = exactCanonicalUuid(metadata.supabase_user_id)
  const hasReservationIdentity = hasOwnMetadataKey(metadata, API_TIER_RESERVATION_METADATA_KEY)
  const checkoutReservationId = hasReservationIdentity
    ? exactCanonicalUuid(metadata[API_TIER_RESERVATION_METADATA_KEY])
    : null
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : null
  const item = subscription.items.data.length === 1 ? subscription.items.data[0] : null
  const priceId = item?.price.id
  const pricePlan = getApiPlanFromPriceId(priceId)

  if (
    metadataKeys.length !== API_CHECKOUT_METADATA_KEYS.length ||
    !API_CHECKOUT_METADATA_KEYS.every((key, index) => metadataKeys[index] === key) ||
    metadata.type !== 'api_tier' ||
    (metadata.api_plan !== 'starter' && metadata.api_plan !== 'pro') ||
    !metadataUserId ||
    !metadataSupabaseUserId ||
    metadataUserId !== metadataSupabaseUserId ||
    hasOwnMetadataKey(metadata, 'user_id') ||
    (hasReservationIdentity && !checkoutReservationId) ||
    !customerId ||
    !STRIPE_CUSTOMER_ID_PATTERN.test(customerId) ||
    customerId.length > 255 ||
    !item ||
    item.quantity !== 1 ||
    !priceId ||
    !STRIPE_PRICE_ID_PATTERN.test(priceId) ||
    priceId.length > 255 ||
    (!pricePlan && !options.allowHistoricalPriceForNonGrant) ||
    (!options.allowHistoricalPriceForNonGrant &&
      pricePlan !== null &&
      pricePlan !== metadata.api_plan)
  ) {
    throw new Error(`API subscription ${subscription.id} has invalid exact entitlement identity`)
  }

  return {
    userId: metadataUserId,
    metadataUserId,
    metadataSupabaseUserId,
    stripeCustomerId: customerId,
    checkoutReservationId,
    stripePriceId: priceId,
    // Active quota can only use the exact original plan. Plan changes require
    // a separate paid-invoice authority that this handler intentionally lacks.
    plan: pricePlan ?? metadata.api_plan,
  }
}

export async function resolveApiTierSubscriptionOwner(
  subscription: Stripe.Subscription,
  options: { allowHistoricalPriceForNonGrant?: boolean } = {}
): Promise<{ authority: ApiTierStripeAuthority; profile: ApiTierProfile | null }> {
  const authority = parseApiTierSubscriptionAuthority(subscription, options)
  const profile = await resolveApiTierAuthorityOwner(authority, subscription.id)
  return { authority, profile }
}

async function resolveApiTierAuthorityOwner(
  authority: ApiTierStripeAuthority,
  subscriptionId: string
): Promise<ApiTierProfile | null> {
  const { data: profile, error } = await getSupabase()
    .from('user_profiles')
    .select('id, stripe_customer_id')
    .eq('id', authority.userId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to find API subscription owner: ${error.message}`)
  }
  if (!profile) {
    // A late, signed Stripe event can outlive a hard-deleted profile. Do not
    // treat the untrusted metadata as authority here: the exact reservation or
    // sealed subscription ledger is still verified atomically by the apply
    // RPC. Existing profiles remain subject to the strict Customer check below.
    return null
  }
  if (
    profile.id !== authority.userId ||
    profile.stripe_customer_id !== authority.stripeCustomerId
  ) {
    throw new Error(`API subscription ${subscriptionId} customer ownership does not match`)
  }

  return profile
}

function assertStripeApiEventIdentity(
  subscription: Stripe.Subscription,
  event: StripeWebhookEventContext
) {
  if (
    !Number.isSafeInteger(subscription.created) ||
    subscription.created <= 0 ||
    subscription.created > MAX_STRIPE_UNIX_SECONDS ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0 ||
    event.created > MAX_STRIPE_UNIX_SECONDS ||
    subscription.created > event.created ||
    !/^sub_[A-Za-z0-9_]+$/.test(subscription.id) ||
    subscription.id.length > 255 ||
    !/^evt_[A-Za-z0-9_]+$/.test(event.id) ||
    event.id.length > 255 ||
    typeof subscription.livemode !== 'boolean' ||
    subscription.livemode !== event.livemode
  ) {
    throw new Error(`API subscription ${subscription.id} has invalid Stripe event identity`)
  }
}

type ApiTierCheckoutConfirmation = {
  sessionId: string
  checkoutPlan: ApiTierPlan
  checkoutPriceId: string
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value
  return value && !Array.isArray(value) && typeof value === 'object'
    ? typeof (value as { id?: unknown }).id === 'string'
      ? ((value as { id: string }).id ?? null)
      : null
    : null
}

type PersistedApiTierNonGrantIdentity = {
  stripeCustomerId: string
  stripePriceId: string
}

function parsePersistedApiTierNonGrantIdentity(
  subscription: Stripe.Subscription,
  event: StripeWebhookEventContext
): PersistedApiTierNonGrantIdentity | null {
  try {
    assertStripeApiEventIdentity(subscription, event)
  } catch {
    return null
  }
  const stripeCustomerId = stripeObjectId(subscription.customer)
  const items = subscription.items?.data || []
  const item = items.length === 1 ? items[0] : null
  const stripePriceId = item?.price?.id

  if (
    !stripeCustomerId ||
    !STRIPE_CUSTOMER_ID_PATTERN.test(stripeCustomerId) ||
    stripeCustomerId.length > 255 ||
    item?.quantity !== 1 ||
    !stripePriceId ||
    !STRIPE_PRICE_ID_PATTERN.test(stripePriceId) ||
    stripePriceId.length > 255
  ) {
    return null
  }

  return { stripeCustomerId, stripePriceId }
}

async function applyPersistedApiTierNonGrantEvent(params: {
  subscription: Stripe.Subscription
  event: StripeWebhookEventContext
  isTerminal: boolean
  identity?: PersistedApiTierNonGrantIdentity
}): Promise<string> {
  const identity =
    params.identity ?? parsePersistedApiTierNonGrantIdentity(params.subscription, params.event)
  if (!identity) {
    throw new Error(
      `API subscription ${params.subscription.id} has invalid persisted non-grant identity`
    )
  }

  return withRetry(async () => {
    const { data: status, error } = await getSupabase().rpc(
      'apply_user_api_tier_persisted_non_grant_event',
      {
        p_stripe_customer_id: identity.stripeCustomerId,
        p_stripe_price_id: identity.stripePriceId,
        p_stripe_subscription_id: params.subscription.id,
        p_subscription_created: params.subscription.created,
        p_stripe_event_id: params.event.id,
        p_event_created: params.event.created,
        p_is_terminal: params.isTerminal,
        p_livemode: params.event.livemode,
      }
    )
    if (error) {
      throw new Error(`Failed to apply persisted API tier non-grant event: ${error.message}`)
    }
    if (typeof status !== 'string' || !API_TIER_PERSISTED_RPC_SUCCESS.has(status)) {
      throw new Error(
        `Persisted API tier non-grant event returned unexpected status ${String(
          status || 'missing'
        )}`
      )
    }
    logger.info('Persisted API tier non-grant event reached a durable state', {
      subscriptionId: params.subscription.id,
      eventId: params.event.id,
      status,
      isTerminal: params.isTerminal,
    })
    return status
  })
}

async function tryApplyPersistedApiTierNonGrantEvent(params: {
  subscription: Stripe.Subscription
  event: StripeWebhookEventContext
  isTerminal: boolean
}): Promise<boolean> {
  const identity = parsePersistedApiTierNonGrantIdentity(params.subscription, params.event)
  if (!identity) {
    return false
  }
  const status = await applyPersistedApiTierNonGrantEvent({ ...params, identity })
  return status !== 'not_api'
}

function exactApiCheckoutConfirmation(
  session: Stripe.Checkout.Session,
  subscription: Stripe.Subscription,
  authority: ApiTierStripeAuthority,
  event: StripeWebhookEventContext
): ApiTierCheckoutConfirmation {
  const metadata = session.metadata || {}
  const metadataKeys = Object.keys(metadata).sort()
  const lineItems = session.line_items?.data || []
  const item = lineItems.length === 1 ? lineItems[0] : null
  const priceId = item?.price?.id
  const checkoutPlan = metadata.api_plan
  const totalDetails =
    session.total_details && typeof session.total_details === 'object'
      ? session.total_details
      : null
  const expectedAmountCents =
    checkoutPlan === 'starter' || checkoutPlan === 'pro'
      ? Math.round(API_PRICING[checkoutPlan].price * 100)
      : null

  if (
    session.object !== 'checkout.session' ||
    session.mode !== 'subscription' ||
    session.status !== 'complete' ||
    session.payment_status !== 'paid' ||
    session.allow_promotion_codes !== false ||
    !Array.isArray(session.discounts) ||
    session.discounts.length !== 0 ||
    session.currency !== 'usd' ||
    expectedAmountCents === null ||
    session.amount_subtotal !== expectedAmountCents ||
    session.amount_total !== expectedAmountCents ||
    totalDetails?.amount_discount !== 0 ||
    totalDetails.amount_shipping !== 0 ||
    totalDetails.amount_tax !== 0 ||
    session.livemode !== event.livemode ||
    !STRIPE_CHECKOUT_SESSION_ID_PATTERN.test(session.id) ||
    stripeObjectId(session.customer) !== authority.stripeCustomerId ||
    stripeObjectId(session.subscription) !== subscription.id ||
    session.client_reference_id !== authority.checkoutReservationId ||
    metadataKeys.length !== API_CHECKOUT_METADATA_KEYS.length ||
    !API_CHECKOUT_METADATA_KEYS.every((key, index) => metadataKeys[index] === key) ||
    metadata.type !== 'api_tier' ||
    (checkoutPlan !== 'starter' && checkoutPlan !== 'pro') ||
    checkoutPlan !== subscription.metadata.api_plan ||
    metadata.userId !== authority.metadataUserId ||
    metadata.supabase_user_id !== authority.metadataSupabaseUserId ||
    metadata[API_TIER_RESERVATION_METADATA_KEY] !== authority.checkoutReservationId ||
    session.line_items?.has_more !== false ||
    item?.quantity !== 1 ||
    !priceId ||
    !STRIPE_PRICE_ID_PATTERN.test(priceId) ||
    priceId.length > 255
  ) {
    throw new Error(
      `API subscription ${subscription.id} has no exact paid Checkout Session authority`
    )
  }

  return {
    sessionId: session.id,
    checkoutPlan,
    checkoutPriceId: priceId,
  }
}

async function resolveApiTierCheckoutConfirmation(
  subscription: Stripe.Subscription,
  authority: ApiTierStripeAuthority,
  event: StripeWebhookEventContext
): Promise<ApiTierCheckoutConfirmation | null> {
  if (!authority.checkoutReservationId) return null

  const sessions = await stripe.checkout.sessions.list({
    subscription: subscription.id,
    limit: 2,
    expand: ['data.line_items'],
  })

  if (sessions.has_more || sessions.data.length !== 1) {
    throw new Error(
      `API subscription ${subscription.id} does not map to one exact Checkout Session`
    )
  }

  return exactApiCheckoutConfirmation(sessions.data[0], subscription, authority, event)
}

export async function applyApiTierStripeEvent(params: {
  authority: ApiTierStripeAuthority
  plan: ApiTierPlan | 'free'
  dailyLimit: number
  subscription: Stripe.Subscription
  event: StripeWebhookEventContext
  isActive: boolean
  isTerminal: boolean
}) {
  assertStripeApiEventIdentity(params.subscription, params.event)
  const checkoutConfirmation = await resolveApiTierCheckoutConfirmation(
    params.subscription,
    params.authority,
    params.event
  )

  if (
    params.isActive &&
    checkoutConfirmation &&
    (checkoutConfirmation.checkoutPlan !== params.authority.plan ||
      checkoutConfirmation.checkoutPriceId !== params.authority.stripePriceId)
  ) {
    const handledAsNonGrant = await tryApplyPersistedApiTierNonGrantEvent({
      subscription: params.subscription,
      event: params.event,
      isTerminal: false,
    })
    if (handledAsNonGrant) {
      logger.warn('Unpaid API plan or price change was durably suspended', {
        subscriptionId: params.subscription.id,
        checkoutPlan: checkoutConfirmation.checkoutPlan,
        checkoutPriceId: checkoutConfirmation.checkoutPriceId,
        currentPlan: params.authority.plan,
        currentPriceId: params.authority.stripePriceId,
      })
      return
    }
    throw new Error(
      `API subscription ${params.subscription.id} changed plan or price without paid authority`
    )
  }

  await withRetry(async () => {
    if (params.authority.checkoutReservationId && !checkoutConfirmation) {
      throw new Error(`API subscription ${params.subscription.id} is missing Checkout confirmation`)
    }

    const { data: status, error } = await getSupabase().rpc('apply_user_api_tier_stripe_event', {
      p_user_id: params.authority.userId,
      p_metadata_user_id: params.authority.metadataUserId,
      p_metadata_supabase_user_id: params.authority.metadataSupabaseUserId,
      p_stripe_customer_id: params.authority.stripeCustomerId,
      p_checkout_reservation_id: params.authority.checkoutReservationId,
      p_stripe_price_id: params.authority.stripePriceId,
      p_api_tier: params.plan,
      p_daily_limit: params.dailyLimit,
      p_stripe_subscription_id: params.subscription.id,
      p_subscription_created: params.subscription.created,
      p_stripe_event_id: params.event.id,
      p_event_created: params.event.created,
      p_is_active: params.isActive,
      p_is_terminal: params.isTerminal,
      p_livemode: params.event.livemode,
      p_checkout_session_id: checkoutConfirmation?.sessionId ?? null,
      p_checkout_api_plan: checkoutConfirmation?.checkoutPlan ?? null,
      p_checkout_price_id: checkoutConfirmation?.checkoutPriceId ?? null,
      p_identity_source: 'signed_metadata',
    })
    if (error) {
      throw new Error(`Failed to apply API tier Stripe event: ${error.message}`)
    }
    if (typeof status !== 'string' || !API_TIER_RPC_SUCCESS.has(status)) {
      throw new Error(
        `API tier Stripe event returned unexpected status ${String(status || 'missing')}`
      )
    }
    logger.info('API tier Stripe event reached a durable state', {
      userId: params.authority.userId,
      subscriptionId: params.subscription.id,
      eventId: params.event.id,
      status,
      isActive: params.isActive,
      isTerminal: params.isTerminal,
    })
  })
}

export async function handleSubscriptionUpdate(
  subscription: Stripe.Subscription,
  event: StripeWebhookEventContext
) {
  if (carriesApiTierSubscriptionIdentity(subscription)) {
    let authority: ApiTierStripeAuthority
    try {
      authority = parseApiTierSubscriptionAuthority(subscription, {
        // Only a currently configured price may grant paid quota. Non-grant
        // states must still be able to revoke a subscription whose price was
        // rotated out after the original purchase.
        allowHistoricalPriceForNonGrant: !API_ACTIVE_STATUSES.has(subscription.status),
      })
    } catch (identityError) {
      const hasKnownStatus =
        API_ACTIVE_STATUSES.has(subscription.status) ||
        API_GRACE_STATUSES.has(subscription.status) ||
        API_SUSPENDED_STATUSES.has(subscription.status) ||
        API_TERMINAL_STATUSES.has(subscription.status)
      if (
        hasKnownStatus &&
        (await tryApplyPersistedApiTierNonGrantEvent({
          subscription,
          event,
          isTerminal: API_TERMINAL_STATUSES.has(subscription.status),
        }))
      ) {
        logger.warn('Invalid API subscription identity was durably suspended or revoked', {
          subscriptionId: subscription.id,
          status: subscription.status,
        })
        return
      }
      throw identityError
    }
    const profile = await resolveApiTierAuthorityOwner(authority, subscription.id)

    if (API_ACTIVE_STATUSES.has(subscription.status)) {
      const dailyLimit = API_TIER_LIMITS[authority.plan] ?? API_TIER_LIMITS.free
      await applyApiTierStripeEvent({
        authority,
        plan: authority.plan,
        dailyLimit,
        subscription,
        event,
        isActive: true,
        isTerminal: false,
      })
      logger.info(`API tier updated for user ${profile?.id ?? authority.userId}`, {
        apiPlan: authority.plan,
        status: subscription.status,
      })
      return
    }

    // Keep the explicit payment-retry grace policy. Stripe will subsequently
    // recover the subscription or move it to an unpaid suspension/cancellation.
    if (API_GRACE_STATUSES.has(subscription.status)) {
      logger.info(
        `API tier kept during payment-retry grace for user ${profile?.id ?? authority.userId}`,
        {
          status: subscription.status,
          subscriptionId: subscription.id,
        }
      )
      return
    }

    if (
      API_SUSPENDED_STATUSES.has(subscription.status) ||
      API_TERMINAL_STATUSES.has(subscription.status)
    ) {
      const isTerminal = API_TERMINAL_STATUSES.has(subscription.status)
      await applyApiTierStripeEvent({
        authority,
        plan: 'free',
        dailyLimit: API_TIER_LIMITS.free,
        subscription,
        event,
        isActive: false,
        isTerminal,
      })
      logger.info(`API tier inactive state recorded for user ${profile?.id ?? authority.userId}`, {
        status: subscription.status,
        subscriptionId: subscription.id,
        isTerminal,
      })
      return
    }

    throw new Error(
      `API subscription ${subscription.id} has unsupported status ${subscription.status}`
    )
  }

  if (carriesRecurringProCheckoutMarker(subscription.metadata)) {
    const identity = parseRecurringProCheckoutMetadata(subscription.metadata)
    if (!identity) {
      await recordStripeCheckoutManualReview({
        supabase: getSupabaseAdmin(),
        objectType: 'subscription',
        sessionId: subscription.id,
        userId: null,
        reasonKey: 'recurring_subscription_metadata_invalid',
        reason:
          'A recurring Pro subscription event carried malformed or conflicting Checkout identity.',
        context: {
          event_id: event.id,
          event_created: event.created,
          subscription_id: subscription.id,
          subscription_status: subscription.status,
          customer_id:
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer?.id || null,
          metadata_type: subscription.metadata?.type || null,
        },
      })
      throw new Error(`Recurring Pro subscription ${subscription.id} has invalid metadata`)
    }

    if (subscription.status === 'active' || subscription.status === 'trialing') {
      try {
        verifyRecurringProSubscription({
          subscription,
          subscriptionId: subscription.id,
          identity,
          livemode: event.livemode,
          eventCreated: event.created,
          phase: 'subscription_lifecycle',
        })
      } catch (verificationError) {
        await recordStripeCheckoutManualReview({
          supabase: getSupabaseAdmin(),
          objectType: 'subscription',
          sessionId: subscription.id,
          userId: identity.userId,
          reasonKey: 'recurring_subscription_verification_failed',
          reason:
            'A recurring Pro subscription event failed exact Stripe identity and price verification.',
          context: {
            event_id: event.id,
            event_created: event.created,
            subscription_id: subscription.id,
            subscription_status: subscription.status,
            reservation_id: identity.reservationId,
            error:
              verificationError instanceof Error
                ? verificationError.message
                : String(verificationError),
          },
        })
        throw verificationError
      }
    }
    await assertRecurringProCheckoutCompleted({
      supabase: getSupabaseAdmin(),
      identity,
      livemode: event.livemode,
      subscriptionId: subscription.id,
    })

    if (subscription.status === 'active' || subscription.status === 'trialing') {
      // Paid authority belongs to invoice.paid; trial authority belongs to the
      // exact checkout.session.completed handler. Subscription event ordering
      // can no longer grant either entitlement ahead of Checkout completion.
      logger.info('Exact recurring Pro subscription left to Checkout/invoice authority', {
        userId: identity.userId,
        subscriptionId: subscription.id,
        status: subscription.status,
        reservationId: identity.reservationId,
      })
      return
    }
  }

  if (
    API_ACTIVE_STATUSES.has(subscription.status) ||
    API_GRACE_STATUSES.has(subscription.status) ||
    API_SUSPENDED_STATUSES.has(subscription.status) ||
    API_TERMINAL_STATUSES.has(subscription.status)
  ) {
    const handledAsApiTier = await tryApplyPersistedApiTierNonGrantEvent({
      subscription,
      event,
      isTerminal: API_TERMINAL_STATUSES.has(subscription.status),
    })
    if (handledAsApiTier) {
      logger.info('Metadata-free API subscription state durably converged', {
        subscriptionId: subscription.id,
        status: subscription.status,
      })
      return
    }
  }

  const customerId = subscription.customer as string

  const { data: profile, error: profileError } = await getSupabase()
    .from('user_profiles')
    .select('id, api_stripe_subscription_id, api_tier')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (profileError) {
    throw new Error(`Failed to find subscription owner: ${profileError.message}`)
  }
  if (!profile) {
    logger.warn('Subscription update: no user found for stripe_customer_id', { customerId })
    return
  }

  const priceId = subscription.items.data[0]?.price.id

  // Regular Pro membership subscription — 显式白名单匹配,不再"未知 price 默认
  // monthly"(2026-07-11 审计:此前任何未知/误建/测试 price 都静默授 Pro monthly)。
  const plan = getProPlanFromPriceId(priceId)

  if (!plan) {
    // 未命中任何已知 price → 不授权,critical 告警人工核查(先 observe;确认 env
    // 无遗漏后可改为硬拒)。防误建/测试 price 静默铸造 Pro。
    logger.error('Subscription with UNKNOWN price — not granting Pro', {
      priceId,
      userId: profile.id,
      subscriptionId: subscription.id,
    })
    try {
      const { sendAlert } = await import('@/lib/alerts/send-alert')
      await sendAlert({
        level: 'critical',
        source: 'stripe',
        title: 'Unknown Stripe price — Pro NOT granted',
        message: `订阅 price ${priceId} 不在已知白名单(monthly/yearly/lifetime/api)。已跳过授权,请核查是否漏配 env price ID 或误建 product。`,
        details: { priceId, userId: profile.id, subscriptionId: subscription.id },
      })
    } catch {
      /* alert failure non-fatal */
    }
    throw new Error(`Cannot map Stripe price ${priceId || 'missing'} to a Pro plan`)
  }

  await updateUserSubscription(profile.id, subscription, plan)
}

export async function handleSubscriptionCanceled(
  subscription: Stripe.Subscription,
  event: StripeWebhookEventContext
) {
  if (carriesApiTierSubscriptionIdentity(subscription)) {
    let authority: ApiTierStripeAuthority
    try {
      authority = parseApiTierSubscriptionAuthority(subscription, {
        allowHistoricalPriceForNonGrant: true,
      })
    } catch (identityError) {
      if (
        await tryApplyPersistedApiTierNonGrantEvent({
          subscription,
          event,
          isTerminal: true,
        })
      ) {
        logger.warn('Invalid deleted API subscription identity was durably revoked', {
          subscriptionId: subscription.id,
        })
        return
      }
      throw identityError
    }
    const profile = await resolveApiTierAuthorityOwner(authority, subscription.id)
    await applyApiTierStripeEvent({
      authority,
      plan: 'free',
      dailyLimit: API_TIER_LIMITS.free,
      subscription,
      event,
      isActive: false,
      isTerminal: true,
    })
    logger.info(`API tier cancellation recorded for user ${profile?.id ?? authority.userId}`, {
      previousPlan: authority.plan,
      canceledSubId: subscription.id,
    })
    return
  }

  if (
    await tryApplyPersistedApiTierNonGrantEvent({
      subscription,
      event,
      isTerminal: true,
    })
  ) {
    logger.info('Metadata-free deleted API subscription durably converged', {
      subscriptionId: subscription.id,
    })
    return
  }

  const customerId = subscription.customer as string

  const { data: profile, error: profileLookupError } = await getSupabase()
    .from('user_profiles')
    .select('id, api_stripe_subscription_id, api_tier')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()

  if (profileLookupError) {
    throw new Error(`Failed to find canceled subscription owner: ${profileLookupError.message}`)
  }
  if (!profile) {
    logger.warn('Subscription canceled: no user found for stripe_customer_id', { customerId })
    return
  }

  const priceId = subscription.items.data[0]?.price.id
  const regularPlan = getProPlanFromPriceId(priceId)
  const metadataPlan = subscription.metadata?.plan
  const carriesRegularPlanMetadata = metadataPlan === 'monthly' || metadataPlan === 'yearly'
  if (!regularPlan && !carriesRegularPlanMetadata) {
    throw new Error(
      `Cannot classify canceled Stripe subscription ${subscription.id} with price ${
        priceId || 'missing'
      }`
    )
  }

  // Regular Pro membership cancellation.
  const { error: subError } = await getSupabase()
    .from('subscriptions')
    .update({
      status: 'canceled',
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', profile.id)
    .eq('stripe_subscription_id', subscription.id)

  if (subError) {
    logger.error('Failed to update subscription status to canceled', {
      userId: profile.id,
      error: subError.message,
    })
    throw new Error(`Failed to cancel subscription record: ${subError.message}`)
  }

  // P-1 FIX: Only downgrade if the canceled subscription is still the user's
  // current one. If the user re-subscribed (new stripe_subscription_id replaced
  // the old one via upsert), a late-delivered `customer.subscription.deleted`
  // for the old sub must NOT downgrade them.
  const { data: currentSub, error: currentSubError } = await getSupabase()
    .from('subscriptions')
    .select('stripe_subscription_id, status')
    .eq('user_id', profile.id)
    .maybeSingle()

  if (currentSubError) {
    throw new Error(
      `Failed to verify current subscription before downgrade: ${currentSubError.message}`
    )
  }
  let downgradedToFree = false
  if (currentSub && currentSub.stripe_subscription_id !== subscription.id) {
    logger.info('Skipping profile downgrade — user has a newer subscription', {
      userId: profile.id,
      canceledSubId: subscription.id,
      currentSubId: currentSub.stripe_subscription_id,
    })
  } else {
    // Check lifetime plan holder
    const { data: currentProfile, error: currentProfileError } = await getSupabase()
      .from('user_profiles')
      .select('pro_plan')
      .eq('id', profile.id)
      .maybeSingle()
    if (currentProfileError) {
      throw new Error(`Failed to verify lifetime entitlement: ${currentProfileError.message}`)
    }
    if (currentProfile?.pro_plan === 'lifetime') {
      logger.info('Skipping downgrade for lifetime user on subscription cancel', {
        userId: profile.id,
      })
    } else {
      const { error: profileError } = await getSupabase()
        .from('user_profiles')
        .update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        })
        .eq('id', profile.id)
      if (profileError) {
        logger.error('Failed to downgrade user tier to free', {
          userId: profile.id,
          error: profileError.message,
        })
        throw new Error(`Failed to downgrade user tier: ${profileError.message}`)
      }
      downgradedToFree = true
    }
  }

  if (downgradedToFree) {
    try {
      const leftGroup = await leaveProOfficialGroup(profile.id)
      if (leftGroup) {
        logger.info(`User ${profile.id} left Pro official group`)
      }
    } catch (leaveError) {
      logger.error('Error leaving Pro official group', { error: leaveError })
      throw leaveError
    }
  }

  logger.info(`Subscription canceled for user ${profile.id}`)
}

export async function handleTrialWillEnd(subscription: Stripe.Subscription) {
  const customerId = subscription.customer as string

  const { data: profile } = await getSupabase()
    .from('user_profiles')
    .select('id, email')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!profile) {
    logger.warn('Trial ending but no user found', { customerId })
    return
  }

  const trialEndDate = subscription.trial_end
    ? new Date(subscription.trial_end * 1000).toLocaleDateString('zh-CN')
    : '即将'

  sendNotification(
    getSupabase(),
    {
      user_id: profile.id,
      type: 'system',
      title: '试用期即将结束',
      message: `您的 Pro 会员试用期将于 ${trialEndDate} 结束。届时将开始正式计费，如需取消请前往设置页面。`,
      reference_id: `trial_ending_${subscription.id}`,
    },
    'stripe-trial-ending'
  )

  logger.info(`Trial ending notification sent to user ${profile.id}`)
}

export async function updateUserSubscription(
  userId: string,
  subscription: Stripe.Subscription,
  plan: string
) {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
  const item = subscription.items?.data?.length === 1 ? subscription.items.data[0] : null
  const authoritativePlan = getProPlanFromPriceId(item?.price.id)
  if (
    !UUID_PATTERN.test(userId) ||
    !customerId ||
    !STRIPE_CUSTOMER_ID_PATTERN.test(customerId) ||
    !subscription.id.startsWith('sub_') ||
    !item ||
    item.quantity !== 1 ||
    (plan !== 'monthly' && plan !== 'yearly') ||
    authoritativePlan !== plan
  ) {
    throw new Error(`Subscription ${subscription.id} has invalid recurring Pro projection identity`)
  }
  const status = SUBSCRIPTION_STATUS_MAP[subscription.status] || subscription.status
  const sub = subscription as unknown as Record<string, unknown>
  const itemPeriod = subscription.items?.data?.[0] as unknown as Record<string, unknown> | undefined
  const pStart = (sub.current_period_start ?? itemPeriod?.current_period_start) as
    | number
    | undefined
  const pEnd = (sub.current_period_end ?? itemPeriod?.current_period_end) as number | undefined
  const periodStart = pStart
    ? new Date(pStart * 1000).toISOString()
    : new Date(subscription.start_date * 1000).toISOString()
  const periodEnd = pEnd ? new Date(pEnd * 1000).toISOString() : null

  logger.info(`updateUserSubscription`, { userId, status, plan, periodStart, periodEnd })

  return withRetry(async () => {
    const { data, error: rpcError } = await getSupabase().rpc(
      'sync_recurring_pro_subscription_projection_atomic',
      {
        p_user_id: userId,
        p_status: status,
        p_stripe_subscription_id: subscription.id,
        p_stripe_customer_id: customerId,
        p_plan: plan,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_cancel_at_period_end: subscription.cancel_at_period_end,
      }
    )

    if (rpcError) {
      throw new Error(`Failed to sync recurring Pro subscription projection: ${rpcError.message}`)
    }

    if (
      data !== 'updated' &&
      data !== 'blocked_full_refund' &&
      data !== 'stale_current_subscription' &&
      data !== 'subject_deleted'
    ) {
      throw new Error(
        `sync_recurring_pro_subscription_projection_atomic returned ${String(data ?? 'missing')}`
      )
    }
    const details = { status, plan, projectionStatus: data }
    if (data === 'blocked_full_refund' || data === 'stale_current_subscription') {
      logger.warn(`Subscription projection did not grant Pro for user ${userId}`, details)
    } else {
      logger.info(`Subscription updated for user ${userId}`, details)
    }
    return data
  })
}
