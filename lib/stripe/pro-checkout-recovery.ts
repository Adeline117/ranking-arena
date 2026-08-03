import 'server-only'

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { createCheckoutSession } from '@/lib/stripe'

export const PRO_MEMBERSHIP_RESERVATION_METADATA_KEY = 'pro_membership_reservation_id'
export const PRO_MEMBERSHIP_PRICE_METADATA_KEY = 'pro_price_id'
export const PRO_CHECKOUT_METADATA_KEYS = [
  'currency',
  'plan',
  PRO_MEMBERSHIP_RESERVATION_METADATA_KEY,
  PRO_MEMBERSHIP_PRICE_METADATA_KEY,
  'supabase_user_id',
  'trial_days',
  'type',
  'unit_amount',
  'userId',
] as const

const stripeCustomerIdPattern = /^cus_[A-Za-z0-9_]+$/
const stripeSessionIdPattern = /^cs_[A-Za-z0-9_]+$/
const stripePriceIdPattern = /^price_[A-Za-z0-9_]+$/
const stripeSubscriptionIdPattern = /^sub_[A-Za-z0-9_]+$/
const stripeSubscriptionItemIdPattern = /^si_[A-Za-z0-9_]+$/
const stripeLineItemIdPattern = /^li_[A-Za-z0-9_]+$/
const stripeEventIdPattern = /^evt_[A-Za-z0-9_]+$/
const maxStripeUnixSeconds = 253_402_300_799
const maxStripePaginationPages = 100
const maxInFlightSeconds = 15 * 60
const blockingStatuses = new Set<Stripe.Subscription.Status>([
  'active',
  'trialing',
  'past_due',
  'incomplete',
  'unpaid',
  'paused',
])
const terminalStatuses = new Set<Stripe.Subscription.Status>(['canceled', 'incomplete_expired'])

export type ProCheckoutMetadata = Record<(typeof PRO_CHECKOUT_METADATA_KEYS)[number], string>

export type ProCheckoutReservation = {
  status: 'reserved' | 'existing' | 'bound' | 'converted'
  reservationId: string
  plan: 'monthly' | 'yearly'
  priceId: string
  unitAmount: number
  currency: 'usd'
  trialDays: 0 | 7
  successUrl: string
  cancelUrl: string
  checkoutExpiresAtSeconds: number
  checkoutSessionId: string | null
}

export type ExactRecurringPriceSnapshot = {
  priceId: string
  unitAmount: number
  currency: string
}

export type ProSubscriptionSnapshot = {
  subscription: Stripe.Subscription
  priceIds: string[]
}

export type ProSessionVerification =
  | {
      ok: true
      session: Stripe.Checkout.Session
      state: 'open' | 'expired' | 'complete'
    }
  | {
      ok: false
      session: Stripe.Checkout.Session | null
      safeToExpire: boolean
      reason: string
    }

export type ProCheckoutRecoveryOutcome = 'released' | 'bound' | 'converted' | 'uncertain'

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

function isEmptyCollection(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

function metadataMatches(actual: Stripe.Metadata | null, expected: ProCheckoutMetadata): boolean {
  const metadata = actual || {}
  const keys = Object.keys(metadata).sort()
  return (
    keys.length === PRO_CHECKOUT_METADATA_KEYS.length &&
    PRO_CHECKOUT_METADATA_KEYS.every((key, index) => keys[index] === key) &&
    PRO_CHECKOUT_METADATA_KEYS.every((key) => metadata[key] === expected[key])
  )
}

function fixedRecurringPrice(price: Stripe.Price): boolean {
  if (price.custom_unit_amount !== null) return false
  if (price.transform_quantity !== null || price.tiers_mode !== null) return false
  if (price.billing_scheme !== 'per_unit' || price.type !== 'recurring') return false
  if (price.currency_options) {
    for (const option of Object.values(price.currency_options)) {
      if (option.custom_unit_amount !== null) return false
    }
  }
  return true
}

export function stripeCustomerIsExactlyOwned(params: {
  value: Stripe.Customer | Stripe.DeletedCustomer
  expectedCustomerId: string
  expectedUserId: string
  expectedLivemode: boolean
}): boolean {
  const customer = params.value
  if (
    'deleted' in customer ||
    customer.object !== 'customer' ||
    customer.id !== params.expectedCustomerId ||
    customer.livemode !== params.expectedLivemode
  ) {
    return false
  }
  const metadata = customer.metadata || {}
  if (metadata.userId !== params.expectedUserId) return false
  for (const alias of ['supabase_user_id', 'user_id'] as const) {
    if (
      Object.prototype.hasOwnProperty.call(metadata, alias) &&
      metadata[alias] !== params.expectedUserId
    ) {
      return false
    }
  }
  return true
}

async function listCompleteCheckoutLineItems(
  stripeClient: Stripe,
  sessionId: string
): Promise<Stripe.LineItem[]> {
  const lines: Stripe.LineItem[] = []
  const seenIds = new Set<string>()
  let startingAfter: string | undefined
  for (let pageCount = 1; pageCount <= maxStripePaginationPages; pageCount += 1) {
    const page = await stripeClient.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      expand: ['data.price'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (
      !Array.isArray(page.data) ||
      page.data.length > 100 ||
      typeof page.has_more !== 'boolean' ||
      (startingAfter !== undefined && page.data.length === 0)
    ) {
      throw new Error('Stripe Checkout line-item pagination returned an invalid page')
    }
    for (const line of page.data) {
      if (
        !exactIdentifier(line.id, stripeLineItemIdPattern) ||
        line.object !== 'item' ||
        seenIds.has(line.id)
      ) {
        throw new Error('Stripe Checkout line-item pagination returned uncertain identity')
      }
      seenIds.add(line.id)
      lines.push(line)
    }
    if (!page.has_more) return lines
    const next = page.data.at(-1)?.id
    if (!next || next === startingAfter) {
      throw new Error('Stripe Checkout line-item pagination did not advance')
    }
    startingAfter = next
  }
  throw new Error('Stripe Checkout line-item pagination exceeded its safety limit')
}

export async function verifyFreshProCheckoutSession(params: {
  stripeClient: Stripe
  sessionId: string
  userId: string
  customerId: string
  livemode: boolean
  reservation: ProCheckoutReservation
  metadata: ProCheckoutMetadata
  allowTerminalRecovery?: boolean
}): Promise<ProSessionVerification> {
  if (!exactIdentifier(params.sessionId, stripeSessionIdPattern)) {
    return {
      ok: false,
      session: null,
      safeToExpire: false,
      reason: 'Stripe returned an invalid Checkout Session identity.',
    }
  }
  const session = await params.stripeClient.checkout.sessions.retrieve(params.sessionId, {
    expand: ['line_items.data.price'],
  })
  const lines = await listCompleteCheckoutLineItems(params.stripeClient, params.sessionId)
  const line = lines.length === 1 ? lines[0] : null
  const price = line?.price && !('deleted' in line.price) ? line.price : null
  const expectedAmount = params.reservation.unitAmount
  const expectedCheckoutAmount = params.reservation.trialDays === 7 ? 0 : expectedAmount
  const expectedInterval = params.reservation.plan === 'monthly' ? 'month' : 'year'
  const openState =
    session.status === 'open' &&
    session.payment_status === 'unpaid' &&
    session.subscription === null
  const expiredState =
    session.status === 'expired' &&
    session.payment_status === 'unpaid' &&
    session.subscription === null
  const completeState =
    session.status === 'complete' &&
    session.payment_status ===
      (params.reservation.trialDays === 7 ? 'no_payment_required' : 'paid') &&
    exactIdentifier(stripeId(session.subscription), stripeSubscriptionIdPattern)
  const state = openState ? 'open' : expiredState ? 'expired' : completeState ? 'complete' : null
  const exactOwner =
    session.id === params.sessionId &&
    session.mode === 'subscription' &&
    stripeId(session.customer) === params.customerId &&
    session.livemode === params.livemode &&
    session.client_reference_id === params.reservation.reservationId &&
    session.metadata?.userId === params.userId &&
    session.metadata?.supabase_user_id === params.userId &&
    session.metadata?.[PRO_MEMBERSHIP_RESERVATION_METADATA_KEY] === params.reservation.reservationId
  const safeToExpire = exactOwner && openState
  const exact =
    exactOwner &&
    Number.isSafeInteger(session.created) &&
    session.created > 0 &&
    session.created <= maxStripeUnixSeconds &&
    state !== null &&
    (params.allowTerminalRecovery || state === 'open') &&
    session.object === 'checkout.session' &&
    (state !== 'open' || isHostedCheckoutUrl(session.url)) &&
    session.expires_at === params.reservation.checkoutExpiresAtSeconds &&
    session.after_expiration === null &&
    metadataMatches(session.metadata, params.metadata) &&
    session.currency === params.reservation.currency &&
    session.amount_subtotal === expectedCheckoutAmount &&
    session.amount_total === expectedCheckoutAmount &&
    session.total_details?.amount_discount === 0 &&
    session.total_details.amount_shipping === 0 &&
    session.total_details.amount_tax === 0 &&
    session.allow_promotion_codes === false &&
    session.automatic_tax?.enabled === false &&
    session.adaptive_pricing?.enabled !== true &&
    isEmptyCollection(session.discounts) &&
    isEmptyCollection(session.optional_items) &&
    Array.isArray(session.custom_fields) &&
    session.custom_fields.length === 0 &&
    !!line &&
    line.quantity === 1 &&
    line.currency === params.reservation.currency &&
    line.amount_subtotal === expectedCheckoutAmount &&
    line.amount_total === expectedCheckoutAmount &&
    line.amount_discount === 0 &&
    line.amount_tax === 0 &&
    isEmptyCollection(line.discounts) &&
    isEmptyCollection(line.taxes) &&
    !!price &&
    price.id === params.reservation.priceId &&
    price.object === 'price' &&
    typeof price.active === 'boolean' &&
    (state !== 'open' || price.active) &&
    price.livemode === params.livemode &&
    price.currency === params.reservation.currency &&
    price.unit_amount === expectedAmount &&
    price.unit_amount_decimal !== null &&
    price.unit_amount_decimal.toString() === String(expectedAmount) &&
    price.recurring?.interval === expectedInterval &&
    price.recurring.interval_count === 1 &&
    price.recurring.usage_type === 'licensed' &&
    fixedRecurringPrice(price)

  if (exact && state) return { ok: true, session, state }
  return {
    ok: false,
    session,
    safeToExpire,
    reason: 'Stripe Checkout failed exact Pro reservation, price, or amount verification.',
  }
}

function subscriptionItemPriceId(item: Stripe.SubscriptionItem): string | null {
  return item.price?.id || null
}

async function completeSubscriptionPrices(
  stripeClient: Stripe,
  subscription: Stripe.Subscription,
  expectedLivemode: boolean
): Promise<ExactRecurringPriceSnapshot[]> {
  if (!subscription.items || !Array.isArray(subscription.items.data)) {
    throw new Error(`Stripe subscription ${subscription.id} omitted its item list`)
  }
  if (subscription.items.data.length > 100 || typeof subscription.items.has_more !== 'boolean') {
    throw new Error(`Stripe subscription ${subscription.id} returned an invalid item page`)
  }
  const prices: ExactRecurringPriceSnapshot[] = []
  const seenIds = new Set<string>()
  const append = (items: Stripe.SubscriptionItem[]) => {
    for (const item of items) {
      if (
        !exactIdentifier(item.id, stripeSubscriptionItemIdPattern) ||
        item.object !== 'subscription_item' ||
        seenIds.has(item.id) ||
        stripeId(item.subscription) !== subscription.id ||
        item.quantity !== 1 ||
        !isEmptyCollection(item.discounts) ||
        !isEmptyCollection(item.tax_rates)
      ) {
        throw new Error(`Stripe subscription ${subscription.id} returned uncertain item identity`)
      }
      const priceId = subscriptionItemPriceId(item)
      const price = item.price
      if (
        !exactIdentifier(priceId, stripePriceIdPattern) ||
        price.object !== 'price' ||
        price.livemode !== expectedLivemode ||
        price.type !== 'recurring' ||
        price.billing_scheme !== 'per_unit' ||
        price.currency !== 'usd' ||
        !Number.isSafeInteger(price.unit_amount) ||
        Number(price.unit_amount) <= 0 ||
        price.custom_unit_amount !== null ||
        price.transform_quantity !== null ||
        price.tiers_mode !== null ||
        (price.recurring?.interval !== 'month' && price.recurring?.interval !== 'year') ||
        price.recurring.interval_count !== 1 ||
        price.recurring.usage_type !== 'licensed'
      ) {
        throw new Error(`Stripe subscription ${subscription.id} returned an invalid price identity`)
      }
      seenIds.add(item.id)
      prices.push({
        priceId,
        unitAmount: Number(price.unit_amount),
        currency: price.currency,
      })
    }
  }
  append(subscription.items.data)
  let hasMore = subscription.items.has_more
  let startingAfter = subscription.items.data.at(-1)?.id
  const seenCursors = new Set<string>()
  if (hasMore && !startingAfter) {
    throw new Error(`Stripe subscription ${subscription.id} item pagination did not advance`)
  }
  for (let pageCount = 2; hasMore; pageCount += 1) {
    if (pageCount > maxStripePaginationPages || !startingAfter || seenCursors.has(startingAfter)) {
      throw new Error(`Stripe subscription ${subscription.id} item pagination did not advance`)
    }
    seenCursors.add(startingAfter)
    const page = await stripeClient.subscriptionItems.list({
      subscription: subscription.id,
      limit: 100,
      starting_after: startingAfter,
    })
    if (
      !Array.isArray(page.data) ||
      page.data.length === 0 ||
      page.data.length > 100 ||
      typeof page.has_more !== 'boolean'
    ) {
      throw new Error(`Stripe subscription ${subscription.id} returned an invalid item page`)
    }
    append(page.data)
    hasMore = page.has_more
    if (hasMore) startingAfter = page.data.at(-1)?.id
  }
  if (prices.length !== 1) {
    throw new Error(`Stripe subscription ${subscription.id} has ambiguous item identity`)
  }
  return prices
}

export async function listCompleteCustomerProSubscriptions(params: {
  stripeClient: Stripe
  customerId: string
  livemode: boolean
  proPriceIds: ReadonlySet<string>
  apiPriceIds: ReadonlySet<string>
  resolveHistoricalAuthority: (
    subscription: Stripe.Subscription,
    price: ExactRecurringPriceSnapshot
  ) => Promise<void>
}): Promise<ProSubscriptionSnapshot[]> {
  const snapshots: ProSubscriptionSnapshot[] = []
  const seenIds = new Set<string>()
  let startingAfter: string | undefined
  for (let pageCount = 1; pageCount <= maxStripePaginationPages; pageCount += 1) {
    const page = await params.stripeClient.subscriptions.list({
      customer: params.customerId,
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (
      !Array.isArray(page.data) ||
      page.data.length > 100 ||
      typeof page.has_more !== 'boolean' ||
      (startingAfter !== undefined && page.data.length === 0)
    ) {
      throw new Error('Stripe customer subscription pagination returned an invalid page')
    }
    for (const subscription of page.data) {
      if (
        !exactIdentifier(subscription.id, stripeSubscriptionIdPattern) ||
        subscription.object !== 'subscription' ||
        subscription.livemode !== params.livemode ||
        seenIds.has(subscription.id) ||
        stripeId(subscription.customer) !== params.customerId ||
        (!blockingStatuses.has(subscription.status) && !terminalStatuses.has(subscription.status))
      ) {
        throw new Error('Stripe customer subscription pagination returned uncertain identity')
      }
      seenIds.add(subscription.id)
      const prices = await completeSubscriptionPrices(
        params.stripeClient,
        subscription,
        params.livemode
      )
      const priceIds = prices.map(({ priceId }) => priceId)
      if (priceIds.some((priceId) => params.proPriceIds.has(priceId))) {
        snapshots.push({ subscription, priceIds })
      } else if (!priceIds.every((priceId) => params.apiPriceIds.has(priceId))) {
        await params.resolveHistoricalAuthority(subscription, prices[0])
        snapshots.push({ subscription, priceIds })
      }
    }
    if (!page.has_more) return snapshots
    const next = page.data.at(-1)?.id
    if (!next || next === startingAfter) {
      throw new Error('Stripe customer subscription pagination did not advance')
    }
    startingAfter = next
  }
  throw new Error('Stripe customer subscription pagination exceeded its safety limit')
}

function exactCompletedSnapshot(params: {
  session: Stripe.Checkout.Session
  freshSession: Stripe.Checkout.Session
  event: { id: string; created: number; livemode: boolean }
  userId: string
  customerId: string
  livemode: boolean
  reservation: ProCheckoutReservation
  metadata: ProCheckoutMetadata
}): boolean {
  const { session, event, reservation } = params
  const amount = reservation.trialDays === 7 ? 0 : reservation.unitAmount
  const subscriptionId = stripeId(session.subscription)
  return (
    session.object === 'checkout.session' &&
    exactIdentifier(session.id, stripeSessionIdPattern) &&
    session.mode === 'subscription' &&
    session.status === 'complete' &&
    session.payment_status === (reservation.trialDays === 7 ? 'no_payment_required' : 'paid') &&
    exactIdentifier(subscriptionId, stripeSubscriptionIdPattern) &&
    stripeId(session.customer) === params.customerId &&
    session.livemode === params.livemode &&
    event.livemode === params.livemode &&
    Number.isSafeInteger(session.created) &&
    session.created > 0 &&
    session.created <= event.created &&
    session.created === params.freshSession.created &&
    subscriptionId === stripeId(params.freshSession.subscription) &&
    session.client_reference_id === reservation.reservationId &&
    metadataMatches(session.metadata, params.metadata) &&
    session.expires_at === reservation.checkoutExpiresAtSeconds &&
    session.after_expiration === null &&
    session.recovered_from === null &&
    session.currency === reservation.currency &&
    session.amount_subtotal === amount &&
    session.amount_total === amount &&
    session.total_details?.amount_discount === 0 &&
    session.total_details.amount_shipping === 0 &&
    session.total_details.amount_tax === 0 &&
    session.allow_promotion_codes === false &&
    session.automatic_tax?.enabled === false &&
    session.adaptive_pricing?.enabled !== true &&
    isEmptyCollection(session.discounts) &&
    isEmptyCollection(session.optional_items) &&
    Array.isArray(session.custom_fields) &&
    session.custom_fields.length === 0 &&
    session.metadata?.userId === params.userId &&
    session.metadata?.supabase_user_id === params.userId
  )
}

async function listCustomerCheckoutSessions(params: {
  stripeClient: Stripe
  customerId: string
  livemode: boolean
}): Promise<Stripe.Checkout.Session[]> {
  const sessions: Stripe.Checkout.Session[] = []
  const seenIds = new Set<string>()
  let startingAfter: string | undefined
  for (let pageCount = 1; pageCount <= maxStripePaginationPages; pageCount += 1) {
    const page = await params.stripeClient.checkout.sessions.list({
      customer: params.customerId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (
      !Array.isArray(page.data) ||
      page.data.length > 100 ||
      typeof page.has_more !== 'boolean' ||
      (startingAfter !== undefined && page.data.length === 0)
    ) {
      throw new Error('Stripe Checkout Session recovery pagination returned an invalid page')
    }
    for (const session of page.data) {
      if (
        !exactIdentifier(session.id, stripeSessionIdPattern) ||
        session.object !== 'checkout.session' ||
        session.livemode !== params.livemode ||
        stripeId(session.customer) !== params.customerId ||
        seenIds.has(session.id)
      ) {
        throw new Error('Stripe Checkout Session recovery pagination returned uncertain identity')
      }
      seenIds.add(session.id)
      sessions.push(session)
    }
    if (!page.has_more) return sessions
    const next = page.data.at(-1)?.id
    if (!next || next === startingAfter) {
      throw new Error('Stripe Checkout Session recovery pagination did not advance')
    }
    startingAfter = next
  }
  throw new Error('Stripe Checkout Session recovery pagination exceeded its safety limit')
}

async function findCompletionEvent(params: {
  stripeClient: Stripe
  sessionId: string
  livemode: boolean
  sessionCreated: number
}): Promise<{
  context: { id: string; created: number; livemode: boolean }
  sessionSnapshot: Stripe.Checkout.Session
} | null> {
  const now = Math.floor(Date.now() / 1000)
  if (params.sessionCreated > now + 300) return null
  const matches: Array<{
    context: { id: string; created: number; livemode: boolean }
    sessionSnapshot: Stripe.Checkout.Session
  }> = []
  const seenIds = new Set<string>()
  let startingAfter: string | undefined
  for (let pageCount = 1; pageCount <= maxStripePaginationPages; pageCount += 1) {
    const page = await params.stripeClient.events.list({
      type: 'checkout.session.completed',
      created: { gte: params.sessionCreated, lte: Math.min(now + 300, maxStripeUnixSeconds) },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (
      !Array.isArray(page.data) ||
      page.data.length > 100 ||
      typeof page.has_more !== 'boolean' ||
      (startingAfter !== undefined && page.data.length === 0)
    ) {
      throw new Error('Stripe Checkout completion Event pagination returned an invalid page')
    }
    for (const event of page.data) {
      const object = event.data?.object
      if (
        !exactIdentifier(event.id, stripeEventIdPattern) ||
        event.object !== 'event' ||
        event.type !== 'checkout.session.completed' ||
        event.livemode !== params.livemode ||
        !Number.isSafeInteger(event.created) ||
        event.created <= 0 ||
        event.created > maxStripeUnixSeconds ||
        !object ||
        object.object !== 'checkout.session' ||
        !exactIdentifier(object.id, stripeSessionIdPattern) ||
        seenIds.has(event.id)
      ) {
        throw new Error('Stripe Checkout completion Event pagination returned uncertain identity')
      }
      seenIds.add(event.id)
      if (object.id === params.sessionId) {
        matches.push({
          context: { id: event.id, created: event.created, livemode: event.livemode },
          sessionSnapshot: object as Stripe.Checkout.Session,
        })
      }
    }
    if (!page.has_more) break
    const next = page.data.at(-1)?.id
    if (!next || next === startingAfter) {
      throw new Error('Stripe Checkout completion Event pagination did not advance')
    }
    startingAfter = next
    if (pageCount === maxStripePaginationPages) {
      throw new Error('Stripe Checkout completion Event pagination exceeded its safety limit')
    }
  }
  if (matches.length > 1) {
    throw new Error('Stripe returned multiple completion Events for one Pro Checkout Session')
  }
  return matches[0] || null
}

async function retrieveExpectedCompletionEvent(params: {
  stripeClient: Stripe
  sessionId: string
  livemode: boolean
  expected: { eventId: string; eventCreated: number; subscriptionId: string }
}): Promise<{
  context: { id: string; created: number; livemode: boolean }
  sessionSnapshot: Stripe.Checkout.Session
} | null> {
  if (
    !exactIdentifier(params.expected.eventId, stripeEventIdPattern) ||
    !exactIdentifier(params.expected.subscriptionId, stripeSubscriptionIdPattern) ||
    !Number.isSafeInteger(params.expected.eventCreated) ||
    params.expected.eventCreated <= 0 ||
    params.expected.eventCreated > maxStripeUnixSeconds
  ) {
    return null
  }
  const event = await params.stripeClient.events.retrieve(params.expected.eventId)
  const object = event.data?.object
  if (
    event.id !== params.expected.eventId ||
    event.object !== 'event' ||
    event.type !== 'checkout.session.completed' ||
    event.livemode !== params.livemode ||
    event.created !== params.expected.eventCreated ||
    !object ||
    object.object !== 'checkout.session' ||
    object.id !== params.sessionId ||
    stripeId((object as Stripe.Checkout.Session).subscription) !== params.expected.subscriptionId
  ) {
    return null
  }
  return {
    context: { id: event.id, created: event.created, livemode: event.livemode },
    sessionSnapshot: object as Stripe.Checkout.Session,
  }
}

async function releaseFromObservation(params: {
  supabaseAdmin: SupabaseClient<Database>
  reservation: ProCheckoutReservation
  userId: string
  customerId: string
  livemode: boolean
  kind: 'expired_session' | 'absent_session'
  sessionId: string | null
}): Promise<boolean> {
  const { data, error } = await params.supabaseAdmin.rpc(
    'release_pro_membership_checkout_observation_atomic',
    {
      p_reservation_id: params.reservation.reservationId,
      p_user_id: params.userId,
      p_livemode: params.livemode,
      p_stripe_customer_id: params.customerId,
      p_pro_plan: params.reservation.plan,
      p_stripe_price_id: params.reservation.priceId,
      p_unit_amount: params.reservation.unitAmount,
      p_currency: params.reservation.currency,
      p_trial_days: params.reservation.trialDays,
      p_checkout_session_id: params.sessionId,
      p_checkout_expires_at: params.reservation.checkoutExpiresAtSeconds,
      p_observation_kind: params.kind,
      p_observed_at: Math.floor(Date.now() / 1000),
    }
  )
  const status = record(data)?.status
  return !error && (status === 'released' || status === 'already_released')
}

export async function recoverExpiredProCheckoutReservation(params: {
  stripeClient: Stripe
  supabaseAdmin: SupabaseClient<Database>
  reservation: ProCheckoutReservation
  userId: string
  customerId: string
  livemode: boolean
  metadata: ProCheckoutMetadata
  expectedCompletion?: { eventId: string; eventCreated: number; subscriptionId: string }
}): Promise<ProCheckoutRecoveryOutcome> {
  const { reservation } = params
  const now = Math.floor(Date.now() / 1000)
  if (reservation.status !== 'converted' && reservation.checkoutExpiresAtSeconds > now) {
    return 'uncertain'
  }

  const processSession = async (sessionId: string): Promise<ProCheckoutRecoveryOutcome> => {
    let verification = await verifyFreshProCheckoutSession({
      ...params,
      sessionId,
      allowTerminalRecovery: true,
    })
    if (!verification.ok) return 'uncertain'
    if (verification.state === 'open') {
      await params.stripeClient.checkout.sessions.expire(sessionId)
      verification = await verifyFreshProCheckoutSession({
        ...params,
        sessionId,
        allowTerminalRecovery: true,
      })
      if (!verification.ok || verification.state !== 'expired') return 'uncertain'
    }
    if (verification.state === 'expired') {
      return (await releaseFromObservation({
        ...params,
        kind: 'expired_session',
        sessionId,
      }))
        ? 'released'
        : 'uncertain'
    }
    const event = params.expectedCompletion
      ? await retrieveExpectedCompletionEvent({
          stripeClient: params.stripeClient,
          sessionId,
          livemode: params.livemode,
          expected: params.expectedCompletion,
        })
      : await findCompletionEvent({
          stripeClient: params.stripeClient,
          sessionId,
          livemode: params.livemode,
          sessionCreated: verification.session.created,
        })
    if (
      !event ||
      !exactCompletedSnapshot({
        ...params,
        session: event.sessionSnapshot,
        event: event.context,
        freshSession: verification.session,
      })
    ) {
      return 'uncertain'
    }
    const { handleCheckoutComplete } = await import('@/app/api/stripe/webhook/handlers/checkout')
    const completion = await handleCheckoutComplete(event.sessionSnapshot, event.context, {
      reportProReservationConversion: true,
    })
    return completion?.status === 'pro_reservation_converted' ? 'converted' : 'uncertain'
  }

  if (reservation.checkoutSessionId) return processSession(reservation.checkoutSessionId)

  let replaySessionId: string | null = null
  let definitiveExpiredParameterRejection = false
  try {
    const replay = await createCheckoutSession({
      customerId: params.customerId,
      priceId: reservation.priceId,
      successUrl: reservation.successUrl,
      cancelUrl: reservation.cancelUrl,
      metadata: params.metadata,
      allowPromotionCodes: false,
      ...(reservation.trialDays === 7 ? { trialDays: 7 } : {}),
      idempotencyKey: `pro_membership_checkout_${params.livemode ? 'live' : 'test'}_${reservation.reservationId}`,
      expiresAt: reservation.checkoutExpiresAtSeconds,
      clientReferenceId: reservation.reservationId,
    })
    replaySessionId = exactIdentifier(replay.id, stripeSessionIdPattern) ? replay.id : null
    if (!replaySessionId) return 'uncertain'
  } catch (error) {
    const stripeError = error as { type?: unknown; param?: unknown }
    definitiveExpiredParameterRejection =
      stripeError.type === 'StripeInvalidRequestError' && stripeError.param === 'expires_at'
  }
  if (replaySessionId) return processSession(replaySessionId)

  const allSessions = await listCustomerCheckoutSessions(params)
  const candidates = allSessions.filter(
    (session) =>
      session.client_reference_id === reservation.reservationId ||
      session.metadata?.[PRO_MEMBERSHIP_RESERVATION_METADATA_KEY] === reservation.reservationId
  )
  if (candidates.length > 1) return 'uncertain'
  if (candidates.length === 1) return processSession(candidates[0].id)
  const age = now - (reservation.checkoutExpiresAtSeconds - 2700)
  if (!definitiveExpiredParameterRejection || age < maxInFlightSeconds) return 'uncertain'
  return (await releaseFromObservation({
    ...params,
    kind: 'absent_session',
    sessionId: null,
  }))
    ? 'released'
    : 'uncertain'
}
