import type Stripe from 'stripe'
import { PRICING } from '@/app/(app)/user-center/membership-config'
import { isTrustedStripeCheckoutUrl } from '@/lib/stripe/hosted-url'

export type RecurringProPlan = 'monthly' | 'yearly'

export const RECURRING_PRO_RESERVATION_METADATA_KEY = 'pro_checkout_reservation_id'
export const RECURRING_PRO_OPERATION_METADATA_KEY = 'pro_checkout_operation_id'
export const RECURRING_PRO_NONCE_METADATA_KEY = 'pro_checkout_nonce'

export const RECURRING_PRO_METADATA_KEYS = [
  'plan',
  RECURRING_PRO_NONCE_METADATA_KEY,
  RECURRING_PRO_OPERATION_METADATA_KEY,
  RECURRING_PRO_RESERVATION_METADATA_KEY,
  'stripe_customer_id',
  'stripe_price_id',
  'supabase_user_id',
  'trial_requested',
  'type',
  'userId',
] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9_]+$/
const STRIPE_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/
const STRIPE_SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9_]+$/
const STRIPE_PRICE_ID_PATTERN = /^price_[A-Za-z0-9_]+$/
const MAX_STRIPE_UNIX_SECONDS = 253_402_300_799
const PRO_TRIAL_SECONDS = 7 * 24 * 60 * 60

type RpcError = {
  code?: string
  details?: string
  hint?: string
  message: string
}

export type RecurringProRpcResult = {
  data: unknown
  error: RpcError | null
  status: number | null
}

export type RecurringProCheckoutIdentity = {
  userId: string
  customerId: string
  plan: RecurringProPlan
  priceId: string
  reservationId: string
  operationId: string
  nonce: string
  trialRequested: boolean
}

export type RecurringProCheckoutReservation = RecurringProCheckoutIdentity & {
  status: 'reserved' | 'existing'
  livemode: boolean
  checkoutExpiresAtSeconds: number
  checkoutSessionId: string | null
}

export type VerifiedRecurringProSubscription = {
  subscription: Stripe.Subscription
  periodStart: string
  periodEnd: string
}

export type RecurringProRpcName =
  | 'reserve_recurring_pro_checkout_atomic'
  | 'bind_recurring_pro_checkout_session_atomic'
  | 'complete_recurring_pro_checkout_atomic'
  | 'release_recurring_pro_checkout_atomic'
  | 'assert_recurring_pro_checkout_completed_atomic'
  | 'activate_recurring_trial_entitlement_atomic'

function record(value: unknown): Record<string, unknown> | null {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

export function recurringProRpcStatus(value: unknown): string | null {
  if (typeof value === 'string') return value
  const valueRecord = record(value)
  return typeof valueRecord?.status === 'string' ? valueRecord.status : null
}

export async function callRecurringProRpc(
  client: unknown,
  name: RecurringProRpcName,
  args: Record<string, unknown>
): Promise<RecurringProRpcResult> {
  const rpc = record(client)?.rpc
  if (typeof rpc !== 'function') {
    throw new Error(`Supabase RPC client is unavailable for ${name}`)
  }
  const raw = await (
    rpc as (
      this: unknown,
      functionName: string,
      functionArgs: Record<string, unknown>
    ) => Promise<unknown>
  ).call(client, name, args)
  const result = record(raw)
  if (!result) throw new Error(`Supabase RPC ${name} returned an invalid result`)

  const rawError = result.error
  const error = record(rawError)
  return {
    data: result.data,
    error:
      rawError == null
        ? null
        : {
            code: typeof error?.code === 'string' ? error.code : undefined,
            details: typeof error?.details === 'string' ? error.details : undefined,
            hint: typeof error?.hint === 'string' ? error.hint : undefined,
            message: typeof error?.message === 'string' ? error.message : 'Unknown database error',
          },
    status:
      typeof result.status === 'number' && Number.isInteger(result.status) ? result.status : null,
  }
}

export function exactCanonicalUuid(value: unknown): string | null {
  return typeof value === 'string' &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    UUID_PATTERN.test(value)
    ? value
    : null
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value
  const valueRecord = record(value)
  return typeof valueRecord?.id === 'string' ? valueRecord.id : null
}

function isEmptyStripeCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

function exactMetadataKeys(metadata: Record<string, unknown>): boolean {
  const actualKeys = Object.keys(metadata).sort()
  return (
    actualKeys.length === RECURRING_PRO_METADATA_KEYS.length &&
    RECURRING_PRO_METADATA_KEYS.every((key, index) => actualKeys[index] === key)
  )
}

export function buildRecurringProCheckoutMetadata(
  identity: RecurringProCheckoutIdentity
): Record<(typeof RECURRING_PRO_METADATA_KEYS)[number], string> {
  return {
    plan: identity.plan,
    [RECURRING_PRO_NONCE_METADATA_KEY]: identity.nonce,
    [RECURRING_PRO_OPERATION_METADATA_KEY]: identity.operationId,
    [RECURRING_PRO_RESERVATION_METADATA_KEY]: identity.reservationId,
    stripe_customer_id: identity.customerId,
    stripe_price_id: identity.priceId,
    supabase_user_id: identity.userId,
    trial_requested: identity.trialRequested ? 'true' : 'false',
    type: 'pro_subscription',
    userId: identity.userId,
  }
}

export function parseRecurringProCheckoutMetadata(
  value: unknown
): RecurringProCheckoutIdentity | null {
  const metadata = record(value)
  if (!metadata || !exactMetadataKeys(metadata)) return null

  const userId = exactCanonicalUuid(metadata.userId)
  const supabaseUserId = exactCanonicalUuid(metadata.supabase_user_id)
  const reservationId = exactCanonicalUuid(metadata[RECURRING_PRO_RESERVATION_METADATA_KEY])
  const operationId = exactCanonicalUuid(metadata[RECURRING_PRO_OPERATION_METADATA_KEY])
  const nonce = exactCanonicalUuid(metadata[RECURRING_PRO_NONCE_METADATA_KEY])
  const customerId = metadata.stripe_customer_id
  const priceId = metadata.stripe_price_id
  const plan = metadata.plan
  const trialRequested = metadata.trial_requested

  if (
    metadata.type !== 'pro_subscription' ||
    !userId ||
    !supabaseUserId ||
    userId !== supabaseUserId ||
    !reservationId ||
    !operationId ||
    !nonce ||
    (plan !== 'monthly' && plan !== 'yearly') ||
    typeof customerId !== 'string' ||
    !STRIPE_CUSTOMER_ID_PATTERN.test(customerId) ||
    customerId.length > 255 ||
    typeof priceId !== 'string' ||
    !STRIPE_PRICE_ID_PATTERN.test(priceId) ||
    priceId.length > 255 ||
    (trialRequested !== 'true' && trialRequested !== 'false')
  ) {
    return null
  }

  return {
    userId,
    customerId,
    plan,
    priceId,
    reservationId,
    operationId,
    nonce,
    trialRequested: trialRequested === 'true',
  }
}

export function carriesRecurringProCheckoutMarker(
  metadata: Stripe.Metadata | null | undefined
): boolean {
  const candidate = metadata || {}
  return (
    candidate.type === 'pro_subscription' ||
    [
      RECURRING_PRO_RESERVATION_METADATA_KEY,
      RECURRING_PRO_OPERATION_METADATA_KEY,
      RECURRING_PRO_NONCE_METADATA_KEY,
      'stripe_customer_id',
      'stripe_price_id',
      'trial_requested',
    ].some((key) => Object.prototype.hasOwnProperty.call(candidate, key))
  )
}

export function parseRecurringProReservation(
  value: unknown
): RecurringProCheckoutReservation | null {
  const reservation = record(value)
  if (!reservation) return null
  const expectedKeys = [
    'checkout_expires_at',
    'checkout_session_id',
    'livemode',
    'nonce',
    'operation_id',
    'plan',
    'reservation_id',
    'status',
    'stripe_customer_id',
    'stripe_price_id',
    'trial_requested',
    'user_id',
  ]
  const actualKeys = Object.keys(reservation).sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key, index) => actualKeys[index] === key)
  ) {
    return null
  }

  const status = reservation.status
  const userId = exactCanonicalUuid(reservation.user_id)
  const reservationId = exactCanonicalUuid(reservation.reservation_id)
  const operationId = exactCanonicalUuid(reservation.operation_id)
  const nonce = exactCanonicalUuid(reservation.nonce)
  const customerId = reservation.stripe_customer_id
  const priceId = reservation.stripe_price_id
  const plan = reservation.plan
  const checkoutExpiresAtSeconds = reservation.checkout_expires_at
  const checkoutSessionId = reservation.checkout_session_id

  if (
    (status !== 'reserved' && status !== 'existing') ||
    !userId ||
    !reservationId ||
    !operationId ||
    !nonce ||
    typeof reservation.livemode !== 'boolean' ||
    typeof customerId !== 'string' ||
    !STRIPE_CUSTOMER_ID_PATTERN.test(customerId) ||
    typeof priceId !== 'string' ||
    !STRIPE_PRICE_ID_PATTERN.test(priceId) ||
    (plan !== 'monthly' && plan !== 'yearly') ||
    typeof reservation.trial_requested !== 'boolean' ||
    typeof checkoutExpiresAtSeconds !== 'number' ||
    !Number.isSafeInteger(checkoutExpiresAtSeconds) ||
    checkoutExpiresAtSeconds <= Math.floor(Date.now() / 1000) ||
    checkoutExpiresAtSeconds > MAX_STRIPE_UNIX_SECONDS ||
    (checkoutSessionId !== null &&
      (typeof checkoutSessionId !== 'string' ||
        !STRIPE_SESSION_ID_PATTERN.test(checkoutSessionId))) ||
    (status === 'reserved' && checkoutSessionId !== null)
  ) {
    return null
  }

  return {
    status,
    userId,
    reservationId,
    operationId,
    nonce,
    livemode: reservation.livemode,
    customerId,
    priceId,
    plan,
    trialRequested: reservation.trial_requested,
    checkoutExpiresAtSeconds,
    checkoutSessionId,
  }
}

async function listCompleteCheckoutLineItems(
  stripe: Stripe,
  sessionId: string
): Promise<Stripe.LineItem[]> {
  const lines: Stripe.LineItem[] = []
  const seenIds = new Set<string>()
  let startingAfter: string | undefined

  while (true) {
    const page = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error('Recurring Pro Checkout line-item pagination returned an invalid page')
    }
    if (startingAfter && page.data.length === 0) {
      throw new Error('Recurring Pro Checkout line-item pagination returned an empty continuation')
    }
    for (const line of page.data) {
      if (
        typeof line.id !== 'string' ||
        !line.id.startsWith('li_') ||
        line.object !== 'item' ||
        seenIds.has(line.id)
      ) {
        throw new Error('Recurring Pro Checkout line-item pagination returned uncertain identity')
      }
      seenIds.add(line.id)
      lines.push(line)
    }
    if (!page.has_more) return lines
    const lastId = page.data.at(-1)?.id
    if (!lastId || lastId === startingAfter) {
      throw new Error('Recurring Pro Checkout line-item pagination did not advance')
    }
    startingAfter = lastId
  }
}

function expectedPlanAmount(plan: RecurringProPlan): number {
  return Math.round(PRICING[plan].price * 100)
}

function checkoutLineMatches(
  line: Stripe.LineItem | null,
  identity: RecurringProCheckoutIdentity,
  dueNow: number
): boolean {
  const price = line?.price
  const recurring = price?.recurring
  const expectedInterval = identity.plan === 'monthly' ? 'month' : 'year'
  return (
    !!line &&
    line.quantity === 1 &&
    line.currency === 'usd' &&
    line.amount_subtotal === dueNow &&
    line.amount_total === dueNow &&
    line.amount_discount === 0 &&
    line.amount_tax === 0 &&
    isEmptyStripeCollection(line.discounts) &&
    isEmptyStripeCollection(line.taxes) &&
    price?.id === identity.priceId &&
    price.type === 'recurring' &&
    price.currency === 'usd' &&
    price.unit_amount === expectedPlanAmount(identity.plan) &&
    recurring?.interval === expectedInterval &&
    recurring.interval_count === 1
  )
}

export async function verifyRecurringProCheckoutSession(params: {
  stripe: Stripe
  sessionId: string
  identity: RecurringProCheckoutIdentity
  livemode: boolean
  checkoutExpiresAtSeconds: number
  phase: 'open' | 'complete'
  subscriptionId?: string
}): Promise<Stripe.Checkout.Session> {
  if (!STRIPE_SESSION_ID_PATTERN.test(params.sessionId)) {
    throw new Error('Recurring Pro Checkout Session identity is malformed')
  }
  const session = await params.stripe.checkout.sessions.retrieve(params.sessionId, {
    expand: ['line_items.data.price'],
  })
  const lines = await listCompleteCheckoutLineItems(params.stripe, params.sessionId)
  const line = lines.length === 1 ? lines[0] : null
  const metadata = parseRecurringProCheckoutMetadata(session.metadata)
  const expectedMetadata = buildRecurringProCheckoutMetadata(params.identity)
  const dueNow = params.identity.trialRequested ? 0 : expectedPlanAmount(params.identity.plan)
  const totalDetails = session.total_details
  const expectedPaymentStatus = params.identity.trialRequested ? 'no_payment_required' : 'paid'
  const phaseMatches =
    params.phase === 'open'
      ? session.status === 'open' &&
        session.payment_status === 'unpaid' &&
        session.subscription === null &&
        isTrustedStripeCheckoutUrl(session.url)
      : session.status === 'complete' &&
        session.payment_status === expectedPaymentStatus &&
        stripeObjectId(session.subscription) === params.subscriptionId

  const exact =
    session.id === params.sessionId &&
    session.object === 'checkout.session' &&
    session.mode === 'subscription' &&
    phaseMatches &&
    stripeObjectId(session.customer) === params.identity.customerId &&
    session.livemode === params.livemode &&
    session.client_reference_id === params.identity.reservationId &&
    session.expires_at === params.checkoutExpiresAtSeconds &&
    session.currency === 'usd' &&
    session.amount_subtotal === dueNow &&
    session.amount_total === dueNow &&
    totalDetails?.amount_discount === 0 &&
    totalDetails.amount_shipping === 0 &&
    totalDetails.amount_tax === 0 &&
    session.allow_promotion_codes === false &&
    isEmptyStripeCollection(session.discounts) &&
    session.automatic_tax?.enabled === false &&
    session.adaptive_pricing?.enabled !== true &&
    session.after_expiration === null &&
    session.recovered_from === null &&
    !!metadata &&
    RECURRING_PRO_METADATA_KEYS.every(
      (key) => buildRecurringProCheckoutMetadata(metadata)[key] === expectedMetadata[key]
    ) &&
    checkoutLineMatches(line, params.identity, dueNow)

  if (!exact) {
    throw new Error(`Recurring Pro Checkout Session ${params.sessionId} failed exact verification`)
  }
  return session
}

function unixTimestamp(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_STRIPE_UNIX_SECONDS
    ? value
    : null
}

export function verifyRecurringProSubscription(params: {
  subscription: Stripe.Subscription
  subscriptionId: string
  identity: RecurringProCheckoutIdentity
  livemode: boolean
  eventCreated: number
  phase?: 'checkout_completion' | 'subscription_lifecycle'
}): VerifiedRecurringProSubscription {
  const { subscription, identity } = params
  const metadata = parseRecurringProCheckoutMetadata(subscription.metadata)
  const expectedMetadata = buildRecurringProCheckoutMetadata(identity)
  const item = subscription.items?.data?.length === 1 ? subscription.items.data[0] : null
  const price = item?.price
  const recurring = price?.recurring
  const itemRecord = record(item)
  const subscriptionRecord = record(subscription)
  const periodStart = unixTimestamp(
    subscriptionRecord?.current_period_start ?? itemRecord?.current_period_start
  )
  const periodEnd = unixTimestamp(
    subscriptionRecord?.current_period_end ?? itemRecord?.current_period_end
  )
  const created = unixTimestamp(subscription.created)
  const expectedInterval = identity.plan === 'monthly' ? 'month' : 'year'
  const trialStart = unixTimestamp(subscription.trial_start)
  const trialEnd = unixTimestamp(subscription.trial_end)
  const exactTrialWindow =
    trialStart !== null && trialEnd !== null && trialEnd - trialStart === PRO_TRIAL_SECONDS
  const statusMatches = identity.trialRequested
    ? exactTrialWindow &&
      (subscription.status === 'trialing' ||
        (params.phase === 'subscription_lifecycle' &&
          subscription.status === 'active' &&
          trialEnd !== null &&
          params.eventCreated >= trialEnd))
    : subscription.status === 'active' &&
      subscription.trial_start === null &&
      subscription.trial_end === null

  const exact =
    STRIPE_SUBSCRIPTION_ID_PATTERN.test(params.subscriptionId) &&
    subscription.id === params.subscriptionId &&
    stripeObjectId(subscription.customer) === identity.customerId &&
    subscription.livemode === params.livemode &&
    created !== null &&
    created <= params.eventCreated &&
    statusMatches &&
    subscription.collection_method === 'charge_automatically' &&
    subscription.currency === 'usd' &&
    subscription.automatic_tax?.enabled === false &&
    isEmptyStripeCollection(subscription.default_tax_rates) &&
    subscription.pause_collection === null &&
    subscription.schedule === null &&
    subscription.cancel_at_period_end === false &&
    subscription.canceled_at === null &&
    subscription.pending_update === null &&
    isEmptyStripeCollection(subscription.discounts) &&
    subscription.items?.has_more === false &&
    !!item &&
    stripeObjectId(item.subscription) === subscription.id &&
    item.quantity === 1 &&
    isEmptyStripeCollection(item.discounts) &&
    isEmptyStripeCollection(item.tax_rates) &&
    price?.id === identity.priceId &&
    price.type === 'recurring' &&
    price.currency === 'usd' &&
    price.unit_amount === expectedPlanAmount(identity.plan) &&
    recurring?.interval === expectedInterval &&
    recurring.interval_count === 1 &&
    periodStart !== null &&
    periodEnd !== null &&
    periodEnd > periodStart &&
    !!metadata &&
    RECURRING_PRO_METADATA_KEYS.every(
      (key) => buildRecurringProCheckoutMetadata(metadata)[key] === expectedMetadata[key]
    )

  if (!exact || periodStart === null || periodEnd === null) {
    throw new Error(`Recurring Pro subscription ${subscription.id} failed exact verification`)
  }

  return {
    subscription,
    periodStart: new Date(periodStart * 1000).toISOString(),
    periodEnd: new Date(periodEnd * 1000).toISOString(),
  }
}

export async function assertRecurringProCheckoutCompleted(params: {
  supabase: unknown
  identity: RecurringProCheckoutIdentity
  livemode: boolean
  subscriptionId: string
}): Promise<void> {
  const result = await callRecurringProRpc(
    params.supabase,
    'assert_recurring_pro_checkout_completed_atomic',
    {
      p_user_id: params.identity.userId,
      p_livemode: params.livemode,
      p_stripe_customer_id: params.identity.customerId,
      p_stripe_subscription_id: params.subscriptionId,
      p_reservation_id: params.identity.reservationId,
      p_operation_id: params.identity.operationId,
      p_reservation_nonce: params.identity.nonce,
      p_plan: params.identity.plan,
      p_stripe_price_id: params.identity.priceId,
      p_trial_requested: params.identity.trialRequested,
    }
  )
  if (result.error) {
    throw new Error(`Recurring Pro checkout completion assertion failed: ${result.error.message}`)
  }
  const status = recurringProRpcStatus(result.data)
  if (status !== 'completed') {
    throw new Error(`Recurring Pro checkout completion assertion returned ${status || 'missing'}`)
  }
}
