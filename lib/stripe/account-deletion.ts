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

export const ACCOUNT_DELETION_PAUSE_METADATA_KEY = 'arena_account_deletion_pause'

function assertPauseMarker(pauseMarker: string): void {
  if (!pauseMarker || pauseMarker.length > 255) {
    throw new Error('Account deletion billing marker is malformed')
  }
}

async function loadStripeSubscriptions(params: {
  stripeClient: Stripe
  subscriptionIds: Array<string | null | undefined>
  expectedCustomerId?: string | null
  includeCustomerSubscriptions: boolean
}): Promise<{ customerId: string | null; subscriptions: Stripe.Subscription[] }> {
  const subscriptionIds = [...new Set(params.subscriptionIds.filter((id): id is string => !!id))]
  const expectedCustomerId = params.expectedCustomerId || null
  if (expectedCustomerId) assertCustomerId(expectedCustomerId)
  subscriptionIds.forEach(assertSubscriptionId)

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
      for (const subscription of page.data) {
        if (!subscription.id || seenRemoteIds.has(subscription.id)) {
          throw new Error(
            'Stripe subscription pagination returned a duplicate or missing subscription ID'
          )
        }
        assertSubscriptionId(subscription.id)
        seenRemoteIds.add(subscription.id)
        assertOwnedByCustomer(subscription, customerId)
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

  if (params.includeCustomerSubscriptions && expectedCustomerId) {
    await listCustomerSubscriptions(expectedCustomerId)
  }

  for (const subscriptionId of subscriptionIds) {
    if (subscriptionsById.has(subscriptionId)) continue
    try {
      const subscription = await params.stripeClient.subscriptions.retrieve(subscriptionId)
      if (subscription.id !== subscriptionId) {
        throw new Error(`Stripe returned the wrong subscription for ${subscriptionId}`)
      }
      subscriptionsById.set(subscription.id, subscription)
    } catch (error) {
      if (!isResourceMissing(error)) throw error
    }
  }

  let subscriptions = [...subscriptionsById.values()]
  const customerIds = new Set(
    subscriptions
      .map((subscription) => stripeObjectId(subscription.customer))
      .filter((id): id is string => !!id)
  )
  if (expectedCustomerId) {
    for (const subscription of subscriptions) {
      assertOwnedByCustomer(subscription, expectedCustomerId)
    }
  } else if (subscriptions.length > 0 && customerIds.size !== 1) {
    throw new Error('Stored Stripe subscriptions do not resolve to one customer')
  }

  const customerId = expectedCustomerId ?? customerIds.values().next().value ?? null
  if (customerId) assertCustomerId(customerId)

  if (params.includeCustomerSubscriptions && customerId && !expectedCustomerId) {
    await listCustomerSubscriptions(customerId)
    subscriptions = [...subscriptionsById.values()]
  }

  return { customerId, subscriptions }
}

export async function discoverStripeSubscriptionBilling(params: {
  stripeClient: Stripe
  subscriptionIds: Array<string | null | undefined>
  expectedUserId: string
  expectedCustomerId?: string | null
  includeCustomerSubscriptions?: boolean
}): Promise<{ customerId: string | null; observedSubscriptionIds: string[] }> {
  const { customerId, subscriptions } = await loadStripeSubscriptions({
    stripeClient: params.stripeClient,
    subscriptionIds: params.subscriptionIds,
    expectedCustomerId: params.expectedCustomerId,
    includeCustomerSubscriptions: params.includeCustomerSubscriptions ?? true,
  })
  if (customerId) {
    const customer = await params.stripeClient.customers.retrieve(customerId)
    if (customer.id !== customerId || customer.deleted) {
      throw new Error('Derived Stripe customer identity could not be verified')
    }
    const metadataUserId = stripeMetadataUserId(customer.metadata, `Stripe customer ${customer.id}`)
    if (metadataUserId !== params.expectedUserId) {
      throw new Error('Derived Stripe customer belongs to a different user')
    }
  }
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
      if (customerId) assertOwnedByCustomer(marked, customerId)
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
      if (canceled.id !== subscription.id) {
        throw new Error(`Stripe returned the wrong subscription for ${subscription.id}`)
      }
      if (customerId) assertOwnedByCustomer(canceled, customerId)
      if (!TERMINAL_SUBSCRIPTION_STATUSES.has(canceled.status)) {
        throw new Error(`Stripe subscription ${subscription.id} was not canceled`)
      }
    }
    changedSubscriptionIds.push(subscription.id)
  }

  return { customerId, observedSubscriptionIds, changedSubscriptionIds }
}

/**
 * Recover legacy period-end pauses created before immediate cancellation.
 * New account deletions are terminal and return those IDs for explicit
 * reactivation messaging instead of attempting to revive them.
 */
export async function resumeStripeSubscriptionRenewals(params: {
  stripeClient: Stripe
  subscriptionIds: string[]
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
      if (resumed.id !== subscription.id) {
        throw new Error(`Stripe returned the wrong subscription for ${subscription.id}`)
      }
      if (customerId) assertOwnedByCustomer(resumed, customerId)
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

function assertCheckoutSession(session: Stripe.Checkout.Session, expectedCustomerId: string): void {
  if (
    session.object !== 'checkout.session' ||
    !CHECKOUT_SESSION_ID_PATTERN.test(session.id) ||
    session.id.length > 255
  ) {
    throw new Error('Stripe Checkout pagination returned an invalid Session identity')
  }
  assertOwnedByCustomer(session, expectedCustomerId)
}

async function listCheckoutSessions(params: {
  stripeClient: Stripe
  customerId: string
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
      assertCheckoutSession(session, params.customerId)
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
  expectedUserId?: string
}): Promise<ExpireOpenCheckoutsResult> {
  assertCustomerId(params.customerId)

  const openSessions = await listCheckoutSessions({
    stripeClient: params.stripeClient,
    customerId: params.customerId,
    status: 'open',
  })

  const expiredSessionIds: string[] = []
  const racedSubscriptionIds: string[] = []
  const racedOneTimeSessionIds: string[] = []
  const oneTimeSettlementsById = new Map<string, AccountDeletionOneTimeSettlementObservation>()

  const recordOneTimeSettlement = (session: Stripe.Checkout.Session): void => {
    if (session.mode !== 'payment') return
    if ((session.status !== 'complete' && session.status !== 'expired') || !params.expectedUserId) {
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

    assertCheckoutSession(currentSession, params.customerId)
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
