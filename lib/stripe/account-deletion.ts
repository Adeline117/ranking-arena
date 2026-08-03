import type Stripe from 'stripe'
import { stripeMetadataUserId } from '@/lib/stripe/identity'

const TERMINAL_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'canceled',
  'incomplete_expired',
])

function stripeObjectId(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === 'string') return value
  return value?.id ?? null
}

function isResourceMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'resource_missing'
  )
}

function assertCustomerId(customerId: string): void {
  if (!/^cus_[A-Za-z0-9_]+$/.test(customerId) || customerId.length > 255) {
    throw new Error('Stored Stripe customer ID is malformed')
  }
}

function assertSubscriptionId(subscriptionId: string): void {
  if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId) || subscriptionId.length > 255) {
    throw new Error('Stored Stripe subscription ID is malformed')
  }
}

function assertOwnedByCustomer(
  resource: Stripe.Subscription | Stripe.Checkout.Session,
  expectedCustomerId: string
): void {
  const actualCustomerId = stripeObjectId(resource.customer)
  if (actualCustomerId !== expectedCustomerId) {
    throw new Error(`Stripe ${resource.object} ${resource.id} belongs to a different customer`)
  }
}

export interface StopSubscriptionRenewalsResult {
  customerId: string | null
  observedSubscriptionIds: string[]
  changedSubscriptionIds: string[]
}

export interface ResumeSubscriptionRenewalsResult extends StopSubscriptionRenewalsResult {
  terminalMarkedSubscriptionIds: string[]
}

export type ExactFrozenB2CSubscriptionCompensationStopResult = {
  status: 'missing' | 'terminal'
  subscriptionId: string
}

export type B2CSubscriptionAuthorityKind = 'paid' | 'trial'

export type ExactB2CSubscriptionRecoveryObservation =
  | {
      stripe_subscription_id: string
      missing: true
    }
  | {
      stripe_subscription_id: string
      stripe_customer_id: string
      livemode: boolean
      status: Stripe.Subscription.Status
      cancel_at_period_end: boolean
      current_period_start: number
      current_period_end: number
      stripe_price_id: string
      unit_amount: number
      currency: string
      quantity: number
      collection_method: Stripe.Subscription.CollectionMethod
      has_pause_collection: boolean
      has_pending_update: boolean
      has_subscription_schedule: boolean
      resume_state: 'already_active' | 'resumed' | 'ineligible'
    }

export class B2CSubscriptionRecoveryWriteUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'B2CSubscriptionRecoveryWriteUncertainError'
  }
}

export class B2CSubscriptionRecoveryIdentityConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'B2CSubscriptionRecoveryIdentityConflictError'
  }
}

export const ACCOUNT_DELETION_PAUSE_METADATA_KEY = 'arena_account_deletion_pause'

function assertPauseMarker(pauseMarker: string): void {
  if (!pauseMarker || pauseMarker.length > 255) {
    throw new Error('Account deletion billing marker is malformed')
  }
}

function assertExpectedUserId(expectedUserId: string): void {
  if (!expectedUserId || expectedUserId.length > 255) {
    throw new Error('Expected Stripe customer owner is malformed')
  }
}

function assertVerifiedStripeCustomer(params: {
  customer: Stripe.Customer | Stripe.DeletedCustomer
  customerId: string
  expectedUserId: string
  livemode: boolean
}): Stripe.Customer {
  const { customer } = params
  if (
    customer.object !== 'customer' ||
    customer.id !== params.customerId ||
    customer.deleted === true
  ) {
    throw new Error('Stripe customer identity could not be verified')
  }
  if (customer.livemode !== params.livemode) {
    throw new Error('Stripe customer belongs to a different mode')
  }

  const metadataUserId = stripeMetadataUserId(customer.metadata, `Stripe customer ${customer.id}`)
  if (metadataUserId !== params.expectedUserId) {
    throw new Error('Stripe customer belongs to a different user')
  }
  return customer
}

async function retrieveVerifiedStripeCustomer(params: {
  stripeClient: Stripe
  customerId: string
  expectedUserId: string
  livemode: boolean
}): Promise<Stripe.Customer> {
  assertCustomerId(params.customerId)
  assertExpectedUserId(params.expectedUserId)
  if (typeof params.livemode !== 'boolean') {
    throw new Error('Expected Stripe customer mode is malformed')
  }

  const customer = await params.stripeClient.customers.retrieve(params.customerId)
  return assertVerifiedStripeCustomer({ ...params, customer })
}

async function retrieveVerifiedStripeCustomerForRecovery(params: {
  stripeClient: Stripe
  customerId: string
  expectedUserId: string
  livemode: boolean
}): Promise<Stripe.Customer> {
  let customer: Stripe.Customer | Stripe.DeletedCustomer
  try {
    customer = await params.stripeClient.customers.retrieve(params.customerId)
  } catch (error) {
    if (isResourceMissing(error)) {
      throw new B2CSubscriptionRecoveryIdentityConflictError(
        `Stripe customer ${params.customerId} no longer exists`,
        { cause: error }
      )
    }
    throw error
  }
  try {
    return await assertVerifiedStripeCustomer({ ...params, customer })
  } catch (error) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe customer ${params.customerId} identity conflicted`,
      { cause: error }
    )
  }
}

function assertSubscriptionResponse(
  subscription: Stripe.Subscription,
  expected: {
    subscriptionId?: string
    customerId?: string
    expectedUserId: string
    livemode: boolean
  }
): string {
  if (subscription.object !== 'subscription') {
    throw new Error('Stripe returned an invalid subscription object')
  }
  assertSubscriptionId(subscription.id)
  if (expected.subscriptionId && subscription.id !== expected.subscriptionId) {
    throw new Error(`Stripe returned the wrong subscription for ${expected.subscriptionId}`)
  }
  if (subscription.livemode !== expected.livemode) {
    throw new Error(`Stripe subscription ${subscription.id} belongs to a different mode`)
  }

  const customerId = stripeObjectId(subscription.customer)
  if (!customerId) {
    throw new Error(`Stripe subscription ${subscription.id} has no customer`)
  }
  assertCustomerId(customerId)
  if (expected.customerId && customerId !== expected.customerId) {
    throw new Error(`Stripe subscription ${subscription.id} belongs to a different customer`)
  }

  const metadataUserId = stripeMetadataUserId(
    subscription.metadata,
    `Stripe subscription ${subscription.id}`
  )
  if (metadataUserId && metadataUserId !== expected.expectedUserId) {
    throw new Error(`Stripe subscription ${subscription.id} belongs to a different user`)
  }
  return customerId
}

function assertExactFrozenCompensationSubscription(params: {
  subscription: Stripe.Subscription
  subscriptionId: string
  customerId: string
  expectedUserId: string
  livemode: boolean
}): void {
  assertSubscriptionResponse(params.subscription, {
    subscriptionId: params.subscriptionId,
    customerId: params.customerId,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
  })
  const metadataUserId = stripeMetadataUserId(
    params.subscription.metadata,
    `Stripe subscription ${params.subscription.id}`
  )
  if (metadataUserId !== params.expectedUserId) {
    throw new Error(`Stripe subscription ${params.subscription.id} has no exact owner metadata`)
  }
}

async function loadStripeSubscriptions(params: {
  stripeClient: Stripe
  subscriptionIds: Array<string | null | undefined>
  expectedUserId: string
  livemode: boolean
  expectedCustomerId?: string | null
  includeCustomerSubscriptions: boolean
}): Promise<{ customerId: string | null; subscriptions: Stripe.Subscription[] }> {
  const subscriptionIds = [...new Set(params.subscriptionIds.filter((id): id is string => !!id))]
  let customerId = params.expectedCustomerId || null
  subscriptionIds.forEach(assertSubscriptionId)
  assertExpectedUserId(params.expectedUserId)

  if (customerId) {
    await retrieveVerifiedStripeCustomer({
      stripeClient: params.stripeClient,
      customerId,
      expectedUserId: params.expectedUserId,
      livemode: params.livemode,
    })
  }

  const subscriptionsById = new Map<string, Stripe.Subscription>()

  const listCustomerSubscriptions = async (customerId: string): Promise<void> => {
    const seenRemoteIds = new Set<string>()
    let startingAfter: string | undefined
    while (true) {
      const page = await params.stripeClient.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })
      if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
        throw new Error('Stripe subscription pagination returned an invalid page')
      }
      if (startingAfter && page.data.length === 0) {
        throw new Error('Stripe subscription pagination returned an empty continuation page')
      }
      for (const subscription of page.data) {
        if (!subscription.id || seenRemoteIds.has(subscription.id)) {
          throw new Error(
            'Stripe subscription pagination returned a duplicate or missing subscription ID'
          )
        }
        assertSubscriptionId(subscription.id)
        seenRemoteIds.add(subscription.id)
        assertSubscriptionResponse(subscription, {
          customerId,
          expectedUserId: params.expectedUserId,
          livemode: params.livemode,
        })
        subscriptionsById.set(subscription.id, subscription)
      }
      if (!page.has_more) break
      const nextCursor = page.data.at(-1)?.id
      if (!nextCursor || nextCursor === startingAfter) {
        throw new Error('Stripe subscription pagination did not advance')
      }
      startingAfter = nextCursor
    }
  }

  // When no Customer is durably bound yet, an explicit Subscription retrieve
  // is the only allowed derivation read. Attest the derived Customer before
  // any Customer-scoped list or Stripe mutation can occur.
  if (!customerId) {
    for (const subscriptionId of subscriptionIds) {
      let subscription: Stripe.Subscription
      try {
        subscription = await params.stripeClient.subscriptions.retrieve(subscriptionId)
      } catch (error) {
        if (!isResourceMissing(error)) throw error
        continue
      }
      customerId = assertSubscriptionResponse(subscription, {
        subscriptionId,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
      })
      await retrieveVerifiedStripeCustomer({
        stripeClient: params.stripeClient,
        customerId,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
      })
      subscriptionsById.set(subscription.id, subscription)
      break
    }
  }

  if (!customerId) {
    return { customerId: null, subscriptions: [] }
  }

  if (params.includeCustomerSubscriptions && customerId) {
    await listCustomerSubscriptions(customerId)
  }

  for (const subscriptionId of subscriptionIds) {
    if (subscriptionsById.has(subscriptionId)) continue
    try {
      const subscription = await params.stripeClient.subscriptions.retrieve(subscriptionId)
      assertSubscriptionResponse(subscription, {
        subscriptionId,
        customerId: customerId ?? undefined,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
      })
      subscriptionsById.set(subscription.id, subscription)
    } catch (error) {
      if (!isResourceMissing(error)) throw error
    }
  }

  return { customerId, subscriptions: [...subscriptionsById.values()] }
}

export async function discoverStripeSubscriptionBilling(params: {
  stripeClient: Stripe
  subscriptionIds: Array<string | null | undefined>
  expectedUserId: string
  livemode: boolean
  expectedCustomerId?: string | null
  includeCustomerSubscriptions?: boolean
}): Promise<{ customerId: string | null; observedSubscriptionIds: string[] }> {
  const { customerId, subscriptions } = await loadStripeSubscriptions({
    stripeClient: params.stripeClient,
    subscriptionIds: params.subscriptionIds,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
    expectedCustomerId: params.expectedCustomerId,
    includeCustomerSubscriptions: params.includeCustomerSubscriptions ?? true,
  })
  return {
    customerId,
    observedSubscriptionIds: subscriptions.map(({ id }) => id).sort(),
  }
}

/**
 * Stop every recurring subscription before account deletion.
 *
 * The read phase finishes before any mutation, so a corrupt cross-customer
 * link fails closed without canceling another customer's subscription.
 * Soft deletion also cancels immediately: cancel_at_period_end does not stop
 * Smart Retries for an already-finalized invoice, while immediate cancellation
 * stops automatic collection. The marker remains on the terminal Subscription
 * so recovery can explicitly report that billing must be reactivated.
 */
export async function stopStripeSubscriptionRenewals(params: {
  stripeClient: Stripe
  subscriptionIds: Array<string | null | undefined>
  expectedUserId: string
  livemode: boolean
  expectedCustomerId?: string | null
  deletionMode: 'recoverable' | 'permanent'
  pauseMarker?: string
  includeCustomerSubscriptions?: boolean
}): Promise<StopSubscriptionRenewalsResult> {
  if (params.deletionMode === 'recoverable') {
    if (!params.pauseMarker) {
      throw new Error('Soft account deletion requires a durable Stripe pause marker')
    }
    assertPauseMarker(params.pauseMarker)
  }
  const { customerId, subscriptions } = await loadStripeSubscriptions({
    stripeClient: params.stripeClient,
    subscriptionIds: params.subscriptionIds,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
    expectedCustomerId: params.expectedCustomerId,
    includeCustomerSubscriptions: params.includeCustomerSubscriptions ?? true,
  })
  const observedSubscriptionIds = subscriptions.map(({ id }) => id).sort()

  const changedSubscriptionIds: string[] = []
  for (const subscription of subscriptions) {
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) continue

    if (params.deletionMode === 'recoverable') {
      const marked =
        subscription.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY] === params.pauseMarker
          ? subscription
          : await params.stripeClient.subscriptions.update(subscription.id, {
              metadata: {
                [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: params.pauseMarker!,
              },
            })
      if (marked.id !== subscription.id) {
        throw new Error(`Stripe returned the wrong subscription for ${subscription.id}`)
      }
      if (!customerId) {
        throw new Error('Stripe subscription mutation has no verified customer')
      }
      assertSubscriptionResponse(marked, {
        subscriptionId: subscription.id,
        customerId,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
      })
      if (marked.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY] !== params.pauseMarker) {
        throw new Error(`Stripe subscription ${subscription.id} deletion marker was not stored`)
      }
      if (TERMINAL_SUBSCRIPTION_STATUSES.has(marked.status)) {
        changedSubscriptionIds.push(subscription.id)
        continue
      }
    }

    let canceled: Stripe.Subscription | null = null
    let confirmedMissing = false
    try {
      canceled = await params.stripeClient.subscriptions.cancel(subscription.id, {
        invoice_now: false,
        prorate: false,
      })
    } catch (cancelError) {
      if (isResourceMissing(cancelError)) {
        confirmedMissing = true
      } else {
        try {
          canceled = await params.stripeClient.subscriptions.retrieve(subscription.id)
        } catch (verifyError) {
          if (isResourceMissing(verifyError)) {
            confirmedMissing = true
          } else {
            throw new Error(
              `Could not verify Stripe subscription ${subscription.id} after cancellation failed: ${
                verifyError instanceof Error ? verifyError.message : String(verifyError)
              }`,
              { cause: cancelError }
            )
          }
        }
      }
    }

    if (!canceled && !confirmedMissing) {
      throw new Error(`Stripe subscription ${subscription.id} cancellation returned no result`)
    }
    if (canceled) {
      if (!customerId) {
        throw new Error('Stripe subscription mutation has no verified customer')
      }
      assertSubscriptionResponse(canceled, {
        subscriptionId: subscription.id,
        customerId,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
      })
      if (!TERMINAL_SUBSCRIPTION_STATUSES.has(canceled.status)) {
        throw new Error(`Stripe subscription ${subscription.id} was not canceled`)
      }
    }
    changedSubscriptionIds.push(subscription.id)
  }

  return { customerId, observedSubscriptionIds, changedSubscriptionIds }
}

/**
 * Stops one immutable recovery-compensation target without Customer-scoped
 * discovery. The caller must bind `livemode`, `customerId`, and
 * `subscriptionId` to the signed durable recovery snapshot before calling.
 *
 * A missing Subscription is terminal proof that it cannot renew. A missing or
 * deleted Customer is not equivalent: while the Subscription still exists,
 * that inconsistent graph must remain fail-closed.
 */
export async function stopExactFrozenB2CSubscriptionForCompensation(params: {
  stripeClient: Stripe
  subscriptionId: string
  customerId: string
  expectedUserId: string
  livemode: boolean
}): Promise<ExactFrozenB2CSubscriptionCompensationStopResult> {
  assertSubscriptionId(params.subscriptionId)
  assertCustomerId(params.customerId)
  assertExpectedUserId(params.expectedUserId)
  if (typeof params.livemode !== 'boolean') {
    throw new Error('Expected Stripe subscription mode is malformed')
  }

  const retrieveExactSubscription = async (): Promise<Stripe.Subscription | null> => {
    try {
      return await params.stripeClient.subscriptions.retrieve(params.subscriptionId)
    } catch (error) {
      if (isResourceMissing(error)) return null
      throw error
    }
  }
  const verifyExistingSubscription = async (subscription: Stripe.Subscription): Promise<void> => {
    assertExactFrozenCompensationSubscription({
      subscription,
      subscriptionId: params.subscriptionId,
      customerId: params.customerId,
      expectedUserId: params.expectedUserId,
      livemode: params.livemode,
    })
    await retrieveVerifiedStripeCustomer({
      stripeClient: params.stripeClient,
      customerId: params.customerId,
      expectedUserId: params.expectedUserId,
      livemode: params.livemode,
    })
  }

  const subscription = await retrieveExactSubscription()
  if (!subscription) return { status: 'missing', subscriptionId: params.subscriptionId }

  await verifyExistingSubscription(subscription)
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    return { status: 'terminal', subscriptionId: params.subscriptionId }
  }

  let canceled: Stripe.Subscription
  try {
    canceled = await params.stripeClient.subscriptions.cancel(params.subscriptionId, {
      invoice_now: false,
      prorate: false,
    })
  } catch (cancelError) {
    if (isResourceMissing(cancelError)) {
      return { status: 'missing', subscriptionId: params.subscriptionId }
    }

    let replay: Stripe.Subscription | null
    try {
      replay = await retrieveExactSubscription()
    } catch (verifyError) {
      throw new Error(
        `Could not verify exact Stripe subscription ${params.subscriptionId} after cancellation failed: ${
          verifyError instanceof Error ? verifyError.message : String(verifyError)
        }`,
        { cause: cancelError }
      )
    }
    if (!replay) return { status: 'missing', subscriptionId: params.subscriptionId }

    await verifyExistingSubscription(replay)
    if (TERMINAL_SUBSCRIPTION_STATUSES.has(replay.status)) {
      return { status: 'terminal', subscriptionId: params.subscriptionId }
    }
    throw new Error(`Stripe subscription ${params.subscriptionId} was not canceled`, {
      cause: cancelError,
    })
  }

  assertExactFrozenCompensationSubscription({
    subscription: canceled,
    subscriptionId: params.subscriptionId,
    customerId: params.customerId,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
  })
  if (!TERMINAL_SUBSCRIPTION_STATUSES.has(canceled.status)) {
    throw new Error(`Stripe subscription ${params.subscriptionId} was not canceled`)
  }
  return { status: 'terminal', subscriptionId: params.subscriptionId }
}

/**
 * Recover legacy period-end pauses created before immediate cancellation.
 * New account deletions are terminal and return those IDs for explicit
 * reactivation messaging instead of attempting to revive them.
 */
export async function resumeStripeSubscriptionRenewals(params: {
  stripeClient: Stripe
  subscriptionIds: string[]
  expectedUserId: string
  livemode: boolean
  expectedCustomerId: string
  includeCustomerSubscriptions?: boolean
  pauseMarker: string
}): Promise<ResumeSubscriptionRenewalsResult> {
  assertPauseMarker(params.pauseMarker)
  if (!params.expectedCustomerId) {
    throw new Error('Account recovery requires a durably bound Stripe customer')
  }
  const { customerId, subscriptions } = await loadStripeSubscriptions({
    stripeClient: params.stripeClient,
    subscriptionIds: params.subscriptionIds,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
    expectedCustomerId: params.expectedCustomerId,
    includeCustomerSubscriptions: params.includeCustomerSubscriptions ?? false,
  })
  const observedSubscriptionIds = subscriptions.map(({ id }) => id).sort()
  const changedSubscriptionIds: string[] = []
  const terminalMarkedSubscriptionIds: string[] = []
  const explicitlyLinkedIds = new Set(params.subscriptionIds)
  try {
    for (const subscription of subscriptions) {
      if (TERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status)) {
        if (
          subscription.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY] === params.pauseMarker ||
          explicitlyLinkedIds.has(subscription.id)
        ) {
          terminalMarkedSubscriptionIds.push(subscription.id)
        }
        continue
      }
      if (subscription.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY] !== params.pauseMarker) {
        continue
      }

      const resumed = await params.stripeClient.subscriptions.update(subscription.id, {
        cancel_at_period_end: false,
        metadata: {
          [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: '',
        },
      })
      if (!customerId) {
        throw new Error('Stripe subscription mutation has no verified customer')
      }
      assertSubscriptionResponse(resumed, {
        subscriptionId: subscription.id,
        customerId,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
      })
      if (TERMINAL_SUBSCRIPTION_STATUSES.has(resumed.status)) {
        terminalMarkedSubscriptionIds.push(subscription.id)
        continue
      }
      if (resumed.cancel_at_period_end || resumed.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY]) {
        throw new Error(`Stripe subscription ${subscription.id} renewal was not resumed`)
      }
      changedSubscriptionIds.push(subscription.id)
    }
  } catch (error) {
    // Stripe writes can commit remotely even when the client receives a
    // timeout. Re-read the entire Customer instead of trusting the local list
    // of acknowledged updates, then immediately cancel every nonterminal
    // subscription before leaving the account tombstoned.
    try {
      await stopStripeSubscriptionRenewals({
        stripeClient: params.stripeClient,
        subscriptionIds: params.subscriptionIds,
        expectedUserId: params.expectedUserId,
        livemode: params.livemode,
        expectedCustomerId: customerId,
        deletionMode: 'permanent',
        includeCustomerSubscriptions: true,
      })
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        'Subscription recovery and fail-closed billing compensation both failed'
      )
    }
    throw error
  }
  return {
    customerId,
    observedSubscriptionIds,
    changedSubscriptionIds,
    terminalMarkedSubscriptionIds,
  }
}

const STRIPE_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'active',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'paused',
  'trialing',
  'unpaid',
])

function exactSubscriptionItemEvidence(subscription: Stripe.Subscription): {
  current_period_start: number
  current_period_end: number
  stripe_price_id: string
  unit_amount: number
  currency: string
  quantity: number
  recurringInterval: Stripe.Price.Recurring.Interval
  recurringIntervalCount: number
} {
  const items = subscription.items
  if (!items || !Array.isArray(items.data) || items.data.length !== 1 || items.has_more !== false) {
    throw new Error(`Stripe subscription ${subscription.id} has uncertain billing items`)
  }
  const item = items.data[0] as Stripe.SubscriptionItem & {
    current_period_start?: unknown
    current_period_end?: unknown
  }
  const periodStart = item.current_period_start
  const periodEnd = item.current_period_end
  const price = item.price
  if (
    !Number.isSafeInteger(periodStart) ||
    !Number.isSafeInteger(periodEnd) ||
    (periodStart as number) < 0 ||
    (periodEnd as number) <= (periodStart as number)
  ) {
    throw new Error(`Stripe subscription ${subscription.id} has uncertain billing period`)
  }
  if (
    !price ||
    typeof price !== 'object' ||
    price.object !== 'price' ||
    !/^price_[A-Za-z0-9_]+$/.test(price.id) ||
    price.id.length > 255 ||
    price.livemode !== subscription.livemode ||
    !Number.isSafeInteger(price.unit_amount) ||
    (price.unit_amount as number) < 0 ||
    typeof price.currency !== 'string' ||
    !/^[a-z]{3}$/.test(price.currency) ||
    !Number.isSafeInteger(item.quantity) ||
    (item.quantity as number) < 1 ||
    !price.recurring ||
    (price.recurring.interval !== 'month' && price.recurring.interval !== 'year') ||
    !Number.isSafeInteger(price.recurring.interval_count) ||
    price.recurring.interval_count < 1
  ) {
    throw new Error(`Stripe subscription ${subscription.id} has uncertain price identity`)
  }
  return {
    current_period_start: periodStart as number,
    current_period_end: periodEnd as number,
    stripe_price_id: price.id,
    unit_amount: price.unit_amount as number,
    currency: price.currency,
    quantity: item.quantity as number,
    recurringInterval: price.recurring.interval,
    recurringIntervalCount: price.recurring.interval_count,
  }
}

function exactB2CSubscriptionObservation(params: {
  subscription: Stripe.Subscription
  subscriptionId: string
  customerId: string
  expectedUserId: string
  livemode: boolean
  authorityKind: B2CSubscriptionAuthorityKind
  plan: 'monthly' | 'yearly'
  periodStart: number
  periodEnd: number
  priceId: string
  expectedAmount: number
  currency: string
  resumeState?: 'already_active' | 'resumed' | 'ineligible'
}): Exclude<ExactB2CSubscriptionRecoveryObservation, { missing: true }> {
  if (params.subscription.object !== 'subscription') {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      'Stripe returned an invalid subscription object'
    )
  }
  try {
    assertSubscriptionId(params.subscription.id)
  } catch (error) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      'Stripe returned a malformed subscription identity',
      { cause: error }
    )
  }
  if (typeof params.subscription.livemode !== 'boolean') {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has uncertain mode`
    )
  }
  const actualCustomerId = stripeObjectId(params.subscription.customer)
  if (!actualCustomerId) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has no customer`
    )
  }
  try {
    assertCustomerId(actualCustomerId)
  } catch (error) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has malformed customer identity`,
      { cause: error }
    )
  }
  let metadataUserId: string | null
  try {
    metadataUserId = stripeMetadataUserId(
      params.subscription.metadata,
      `Stripe subscription ${params.subscription.id}`
    )
  } catch (error) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has conflicting owner metadata`,
      { cause: error }
    )
  }
  if (metadataUserId && metadataUserId !== params.expectedUserId) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} belongs to a different user`
    )
  }
  if (!STRIPE_SUBSCRIPTION_STATUSES.has(params.subscription.status)) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has an unknown status`
    )
  }
  if (typeof params.subscription.cancel_at_period_end !== 'boolean') {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has uncertain renewal state`
    )
  }
  if (
    params.subscription.collection_method !== 'charge_automatically' &&
    params.subscription.collection_method !== 'send_invoice'
  ) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has uncertain collection state`
    )
  }
  let itemEvidence: ReturnType<typeof exactSubscriptionItemEvidence>
  try {
    itemEvidence = exactSubscriptionItemEvidence(params.subscription)
  } catch (error) {
    throw new B2CSubscriptionRecoveryIdentityConflictError(
      `Stripe subscription ${params.subscription.id} has conflicting product evidence`,
      { cause: error }
    )
  }
  const { recurringInterval, recurringIntervalCount, ...item } = itemEvidence
  const statusEligible =
    (params.authorityKind === 'paid' && params.subscription.status === 'active') ||
    (params.authorityKind === 'trial' && params.subscription.status === 'trialing')
  const identityEligible =
    params.subscription.id === params.subscriptionId &&
    actualCustomerId === params.customerId &&
    params.subscription.livemode === params.livemode
  const contractEligible =
    item.current_period_start === params.periodStart &&
    item.current_period_end === params.periodEnd &&
    item.stripe_price_id === params.priceId &&
    item.unit_amount === params.expectedAmount &&
    item.currency === params.currency &&
    item.quantity === 1 &&
    item.current_period_end > Math.floor(Date.now() / 1_000) &&
    recurringInterval === (params.plan === 'monthly' ? 'month' : 'year') &&
    recurringIntervalCount === 1 &&
    params.subscription.collection_method === 'charge_automatically' &&
    params.subscription.pause_collection == null &&
    params.subscription.pending_update == null &&
    params.subscription.schedule == null
  const isEligible = identityEligible && statusEligible && contractEligible
  const marker = params.subscription.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY]
  const isAlreadyActive = isEligible && !params.subscription.cancel_at_period_end && !marker
  const resumeState = params.resumeState ?? (isAlreadyActive ? 'already_active' : 'ineligible')
  if (resumeState !== 'ineligible' && !isEligible) {
    throw new Error(`Stripe subscription ${params.subscription.id} is not recovery eligible`)
  }
  if (resumeState !== 'ineligible' && (params.subscription.cancel_at_period_end || marker)) {
    throw new Error(`Stripe subscription ${params.subscription.id} renewal was not restored`)
  }
  return {
    stripe_subscription_id: params.subscription.id,
    stripe_customer_id: actualCustomerId,
    livemode: params.subscription.livemode,
    status: params.subscription.status,
    cancel_at_period_end: params.subscription.cancel_at_period_end,
    ...item,
    collection_method: params.subscription.collection_method,
    has_pause_collection: params.subscription.pause_collection != null,
    has_pending_update: params.subscription.pending_update != null,
    has_subscription_schedule: params.subscription.schedule != null,
    resume_state: resumeState,
  }
}

/**
 * Fresh-read and, when possible, resume one exact durable B2C Subscription.
 *
 * This boundary deliberately has no Customer enumeration mode. API-tier and
 * unknown subscriptions sharing the Customer can therefore never be resumed
 * by account recovery. The returned JSON is also the complete evidence passed
 * to the recovery completion RPC; local status alone is never authoritative.
 */
export async function recoverExactB2CSubscriptionRenewal(params: {
  stripeClient: Stripe
  subscriptionId: string
  expectedCustomerId: string
  expectedUserId: string
  livemode: boolean
  authorityKind: B2CSubscriptionAuthorityKind
  plan: 'monthly' | 'yearly'
  periodStart: number
  periodEnd: number
  priceId: string
  expectedAmount: number
  currency: string
  pauseMarker: string
}): Promise<ExactB2CSubscriptionRecoveryObservation> {
  assertSubscriptionId(params.subscriptionId)
  assertCustomerId(params.expectedCustomerId)
  assertExpectedUserId(params.expectedUserId)
  assertPauseMarker(params.pauseMarker)
  if (
    typeof params.livemode !== 'boolean' ||
    !Number.isSafeInteger(params.periodStart) ||
    !Number.isSafeInteger(params.periodEnd) ||
    params.periodStart < 0 ||
    params.periodEnd <= params.periodStart ||
    !/^price_[A-Za-z0-9_]+$/.test(params.priceId) ||
    params.priceId.length > 255 ||
    !Number.isSafeInteger(params.expectedAmount) ||
    params.expectedAmount <= 0 ||
    !/^[a-z]{3}$/.test(params.currency)
  ) {
    throw new Error('Exact B2C recovery target is malformed')
  }

  await retrieveVerifiedStripeCustomerForRecovery({
    stripeClient: params.stripeClient,
    customerId: params.expectedCustomerId,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
  })

  let subscription: Stripe.Subscription
  try {
    subscription = await params.stripeClient.subscriptions.retrieve(params.subscriptionId)
  } catch (error) {
    if (isResourceMissing(error)) {
      return { stripe_subscription_id: params.subscriptionId, missing: true }
    }
    throw error
  }

  const initial = exactB2CSubscriptionObservation({
    subscription,
    subscriptionId: params.subscriptionId,
    customerId: params.expectedCustomerId,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
    authorityKind: params.authorityKind,
    plan: params.plan,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    priceId: params.priceId,
    expectedAmount: params.expectedAmount,
    currency: params.currency,
  })
  const isEligible =
    ((params.authorityKind === 'paid' && initial.status === 'active') ||
      (params.authorityKind === 'trial' && initial.status === 'trialing')) &&
    initial.stripe_subscription_id === params.subscriptionId &&
    initial.stripe_customer_id === params.expectedCustomerId &&
    initial.livemode === params.livemode &&
    initial.current_period_start === params.periodStart &&
    initial.current_period_end === params.periodEnd &&
    initial.stripe_price_id === params.priceId &&
    initial.unit_amount === params.expectedAmount &&
    initial.currency === params.currency &&
    initial.quantity === 1 &&
    initial.current_period_end > Math.floor(Date.now() / 1_000) &&
    subscription.items.data[0]?.price.recurring?.interval ===
      (params.plan === 'monthly' ? 'month' : 'year') &&
    subscription.items.data[0]?.price.recurring?.interval_count === 1 &&
    initial.collection_method === 'charge_automatically' &&
    !initial.has_pause_collection &&
    !initial.has_pending_update &&
    !initial.has_subscription_schedule
  const marker = subscription.metadata?.[ACCOUNT_DELETION_PAUSE_METADATA_KEY]
  if (!isEligible || marker !== params.pauseMarker) return initial

  let updateError: unknown = null
  try {
    const updated = await params.stripeClient.subscriptions.update(params.subscriptionId, {
      cancel_at_period_end: false,
      metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: '' },
    })
    exactB2CSubscriptionObservation({
      subscription: updated,
      subscriptionId: params.subscriptionId,
      customerId: params.expectedCustomerId,
      expectedUserId: params.expectedUserId,
      livemode: params.livemode,
      authorityKind: params.authorityKind,
      plan: params.plan,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      priceId: params.priceId,
      expectedAmount: params.expectedAmount,
      currency: params.currency,
      resumeState: 'resumed',
    })
  } catch (error) {
    updateError = error
  }

  // A Stripe write may commit even when its response is lost. Always perform
  // one final retrieve and return only that fresh, exact post-write state.
  let verified: Stripe.Subscription
  try {
    verified = await params.stripeClient.subscriptions.retrieve(params.subscriptionId)
  } catch (verifyError) {
    const cause = updateError
      ? new AggregateError([updateError, verifyError], 'Stripe recovery write and read failed')
      : verifyError
    throw new B2CSubscriptionRecoveryWriteUncertainError(
      `Could not verify Stripe subscription ${params.subscriptionId} after recovery write`,
      { cause }
    )
  }
  try {
    return exactB2CSubscriptionObservation({
      subscription: verified,
      subscriptionId: params.subscriptionId,
      customerId: params.expectedCustomerId,
      expectedUserId: params.expectedUserId,
      livemode: params.livemode,
      authorityKind: params.authorityKind,
      plan: params.plan,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      priceId: params.priceId,
      expectedAmount: params.expectedAmount,
      currency: params.currency,
      resumeState: 'resumed',
    })
  } catch (verifyError) {
    const cause = updateError
      ? new AggregateError([updateError, verifyError], 'Stripe recovery write remained uncertain')
      : verifyError
    throw new B2CSubscriptionRecoveryWriteUncertainError(
      `Stripe subscription ${params.subscriptionId} recovery remained uncertain`,
      { cause }
    )
  }
}

export interface ExpireOpenCheckoutsResult {
  expiredSessionIds: string[]
  racedSubscriptionIds: string[]
  racedOneTimeSessionIds: string[]
  oneTimeSettlements: AccountDeletionOneTimeSettlementObservation[]
}

export type AccountDeletionOneTimeProductKind = 'lifetime' | 'tip' | 'group_pass' | 'unknown'

export interface AccountDeletionOneTimeSettlementObservation {
  checkoutSessionId: string
  livemode: boolean
  stripeCustomerId: string
  productKind: AccountDeletionOneTimeProductKind
  stripeStatus: 'complete' | 'expired'
  paymentStatus: Stripe.Checkout.Session['payment_status']
  ownershipStatus: 'exact' | 'mismatch'
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]+$/
const LIFETIME_RESERVATION_ID_KEY = 'lifetime_reservation_id'
const LIFETIME_RESERVATION_NONCE_KEY = 'lifetime_reservation_nonce'
const LIFETIME_METADATA_KEYS = [
  LIFETIME_RESERVATION_ID_KEY,
  LIFETIME_RESERVATION_NONCE_KEY,
  'plan',
  'supabase_user_id',
  'userId',
] as const
const TIP_METADATA_KEYS = [
  'amount_cents',
  'from_user_id',
  'post_id',
  'tip_id',
  'to_user_id',
  'type',
  'user_id',
] as const

function exactMetadataKeys(metadata: Stripe.Metadata, expected: readonly string[]): boolean {
  const keys = Object.keys(metadata).sort()
  return keys.length === expected.length && expected.every((key, index) => keys[index] === key)
}

function classifyOneTimeCheckout(
  session: Stripe.Checkout.Session,
  expectedUserId: string
): Pick<AccountDeletionOneTimeSettlementObservation, 'productKind' | 'ownershipStatus'> {
  const metadata = session.metadata ?? {}
  const lifetimeIntent =
    metadata.plan === 'lifetime' ||
    Object.prototype.hasOwnProperty.call(metadata, LIFETIME_RESERVATION_ID_KEY) ||
    Object.prototype.hasOwnProperty.call(metadata, LIFETIME_RESERVATION_NONCE_KEY)
  const tipIntent =
    metadata.type === 'tip' ||
    Object.prototype.hasOwnProperty.call(metadata, 'tip_id') ||
    Object.prototype.hasOwnProperty.call(metadata, 'from_user_id')
  const groupPassIntent =
    Object.prototype.hasOwnProperty.call(metadata, 'group_id') ||
    (Object.prototype.hasOwnProperty.call(metadata, 'tier') && metadata.type === 'group_pass')
  if ([lifetimeIntent, tipIntent, groupPassIntent].filter(Boolean).length !== 1) {
    return { productKind: 'unknown', ownershipStatus: 'mismatch' }
  }

  if (lifetimeIntent) {
    const reservationId = metadata[LIFETIME_RESERVATION_ID_KEY]
    const reservationNonce = metadata[LIFETIME_RESERVATION_NONCE_KEY]
    const exact =
      exactMetadataKeys(metadata, LIFETIME_METADATA_KEYS) &&
      metadata.plan === 'lifetime' &&
      metadata.userId === expectedUserId &&
      metadata.supabase_user_id === expectedUserId &&
      typeof reservationId === 'string' &&
      UUID_PATTERN.test(reservationId) &&
      typeof reservationNonce === 'string' &&
      /^[A-Za-z0-9_.:-]{8,128}$/.test(reservationNonce) &&
      session.client_reference_id === null
    return { productKind: 'lifetime', ownershipStatus: exact ? 'exact' : 'mismatch' }
  }

  if (tipIntent) {
    const amountCents = Number(metadata.amount_cents)
    const exact =
      exactMetadataKeys(metadata, TIP_METADATA_KEYS) &&
      metadata.type === 'tip' &&
      metadata.user_id === expectedUserId &&
      metadata.from_user_id === expectedUserId &&
      typeof metadata.tip_id === 'string' &&
      UUID_PATTERN.test(metadata.tip_id) &&
      typeof metadata.post_id === 'string' &&
      UUID_PATTERN.test(metadata.post_id) &&
      typeof metadata.to_user_id === 'string' &&
      UUID_PATTERN.test(metadata.to_user_id) &&
      Number.isSafeInteger(amountCents) &&
      amountCents >= 100 &&
      amountCents <= 50_000 &&
      metadata.amount_cents === String(amountCents) &&
      session.client_reference_id === metadata.tip_id
    return { productKind: 'tip', ownershipStatus: exact ? 'exact' : 'mismatch' }
  }

  const exact =
    metadata.user_id === expectedUserId &&
    typeof metadata.group_id === 'string' &&
    UUID_PATTERN.test(metadata.group_id) &&
    (metadata.tier === 'monthly' || metadata.tier === 'yearly') &&
    (metadata.plan === undefined || metadata.plan === metadata.tier) &&
    session.client_reference_id === expectedUserId
  return { productKind: 'group_pass', ownershipStatus: exact ? 'exact' : 'mismatch' }
}

function assertCheckoutSession(
  session: Stripe.Checkout.Session,
  expectedCustomerId: string,
  livemode: boolean
): void {
  if (
    session.object !== 'checkout.session' ||
    !CHECKOUT_SESSION_ID_PATTERN.test(session.id) ||
    session.id.length > 255
  ) {
    throw new Error('Stripe Checkout pagination returned an invalid Session identity')
  }
  if (session.livemode !== livemode) {
    throw new Error(`Stripe Checkout Session ${session.id} belongs to a different mode`)
  }
  assertOwnedByCustomer(session, expectedCustomerId)
}

async function listCheckoutSessions(params: {
  stripeClient: Stripe
  customerId: string
  livemode: boolean
  status: 'open' | 'complete'
}): Promise<Stripe.Checkout.Session[]> {
  const sessions: Stripe.Checkout.Session[] = []
  const seenSessionIds = new Set<string>()
  let startingAfter: string | undefined

  while (true) {
    const page = await params.stripeClient.checkout.sessions.list({
      customer: params.customerId,
      status: params.status,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean') {
      throw new Error('Stripe Checkout pagination returned an invalid page')
    }
    if (startingAfter && page.data.length === 0) {
      throw new Error('Stripe Checkout pagination returned an empty continuation page')
    }

    for (const session of page.data) {
      assertCheckoutSession(session, params.customerId, params.livemode)
      if (seenSessionIds.has(session.id) || session.status !== params.status) {
        throw new Error('Stripe Checkout pagination returned uncertain Session identity')
      }
      seenSessionIds.add(session.id)
      sessions.push(session)
    }

    if (!page.has_more) return sessions
    const nextCursor = page.data.at(-1)?.id
    if (!nextCursor || nextCursor === startingAfter) {
      throw new Error('Stripe Checkout pagination did not advance')
    }
    startingAfter = nextCursor
  }
}

/**
 * Close every open Checkout and enumerate every completed one-time Checkout
 * for a billing Customer.
 *
 * We intentionally do not rely on mutable price IDs or Checkout metadata:
 * account deletion must close legacy/bound API Sessions and one-time
 * lifetime/tip/group payment Sessions after a product-contract rotation. The
 * caller must durably persist `oneTimeSettlements` before hard deletion.
 */
export async function expireOpenSubscriptionCheckouts(params: {
  stripeClient: Stripe
  customerId: string
  expectedUserId: string
  livemode: boolean
}): Promise<ExpireOpenCheckoutsResult> {
  assertCustomerId(params.customerId)
  await retrieveVerifiedStripeCustomer({
    stripeClient: params.stripeClient,
    customerId: params.customerId,
    expectedUserId: params.expectedUserId,
    livemode: params.livemode,
  })

  const openSessions = await listCheckoutSessions({
    stripeClient: params.stripeClient,
    customerId: params.customerId,
    livemode: params.livemode,
    status: 'open',
  })

  const expiredSessionIds: string[] = []
  const racedSubscriptionIds: string[] = []
  const racedOneTimeSessionIds: string[] = []
  const oneTimeSettlementsById = new Map<string, AccountDeletionOneTimeSettlementObservation>()

  const recordOneTimeSettlement = (session: Stripe.Checkout.Session): void => {
    if (session.mode !== 'payment') return
    if (session.status !== 'complete' && session.status !== 'expired') {
      throw new Error(`One-time Checkout Session ${session.id} has uncertain settlement state`)
    }
    const classification = classifyOneTimeCheckout(session, params.expectedUserId)
    const observation: AccountDeletionOneTimeSettlementObservation = {
      checkoutSessionId: session.id,
      livemode: session.livemode,
      stripeCustomerId: params.customerId,
      productKind: classification.productKind,
      stripeStatus: session.status,
      paymentStatus: session.payment_status,
      ownershipStatus: classification.ownershipStatus,
    }
    const existing = oneTimeSettlementsById.get(session.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(observation)) {
      throw new Error(`Stripe Checkout Session ${session.id} changed during settlement scan`)
    }
    oneTimeSettlementsById.set(session.id, observation)
  }

  for (const listedSession of openSessions) {
    let currentSession: Stripe.Checkout.Session
    try {
      currentSession = await params.stripeClient.checkout.sessions.expire(listedSession.id)
    } catch (expireError) {
      try {
        currentSession = await params.stripeClient.checkout.sessions.retrieve(listedSession.id)
      } catch (retrieveError) {
        throw new Error(
          `Could not verify Checkout Session ${listedSession.id} after expiration failed: ${
            retrieveError instanceof Error ? retrieveError.message : String(retrieveError)
          }`,
          { cause: expireError }
        )
      }
    }

    assertCheckoutSession(currentSession, params.customerId, params.livemode)
    if (currentSession.id !== listedSession.id) {
      throw new Error(`Stripe returned the wrong Checkout Session for ${listedSession.id}`)
    }
    if (currentSession.status === 'expired') {
      expiredSessionIds.push(currentSession.id)
      recordOneTimeSettlement(currentSession)
      continue
    }

    // A customer may complete Checkout between list() and expire(). Return
    // subscription identity to the caller's immediate cancellation phase.
    // Completed one-time payments are surfaced so hard deletion can defer
    // while their signed fulfillment event settles.
    if (currentSession.status === 'complete') {
      if (currentSession.mode === 'subscription') {
        const subscriptionId = stripeObjectId(currentSession.subscription)
        if (!subscriptionId) {
          throw new Error(
            `Completed subscription Checkout ${currentSession.id} has no Stripe subscription`
          )
        }
        assertSubscriptionId(subscriptionId)
        racedSubscriptionIds.push(subscriptionId)
      } else if (currentSession.mode === 'payment') {
        racedOneTimeSessionIds.push(currentSession.id)
        recordOneTimeSettlement(currentSession)
      }
      continue
    }

    throw new Error(`Checkout Session ${currentSession.id} remains payable`)
  }

  const completeSessions = await listCheckoutSessions({
    stripeClient: params.stripeClient,
    customerId: params.customerId,
    livemode: params.livemode,
    status: 'complete',
  })
  for (const completeSession of completeSessions) {
    recordOneTimeSettlement(completeSession)
  }

  return {
    expiredSessionIds,
    racedSubscriptionIds,
    racedOneTimeSessionIds,
    oneTimeSettlements: [...oneTimeSettlementsById.values()].sort((left, right) =>
      left.checkoutSessionId < right.checkoutSessionId
        ? -1
        : left.checkoutSessionId > right.checkoutSessionId
          ? 1
          : 0
    ),
  }
}
