import type Stripe from 'stripe'

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

  return { customerId, changedSubscriptionIds }
}

/**
 * Recover legacy period-end pauses created before immediate cancellation.
 * New account deletions are terminal and return those IDs for explicit
 * reactivation messaging instead of attempting to revive them.
 */
export async function resumeStripeSubscriptionRenewals(params: {
  stripeClient: Stripe
  subscriptionIds: string[]
  expectedCustomerId?: string | null
  includeCustomerSubscriptions?: boolean
  pauseMarker: string
}): Promise<ResumeSubscriptionRenewalsResult> {
  assertPauseMarker(params.pauseMarker)
  const { customerId, subscriptions } = await loadStripeSubscriptions({
    stripeClient: params.stripeClient,
    subscriptionIds: params.subscriptionIds,
    expectedCustomerId: params.expectedCustomerId,
    includeCustomerSubscriptions: params.includeCustomerSubscriptions ?? false,
  })
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
        deletionMode: 'recoverable',
        pauseMarker: params.pauseMarker,
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
  return { customerId, changedSubscriptionIds, terminalMarkedSubscriptionIds }
}

export interface ExpireOpenCheckoutsResult {
  expiredSessionIds: string[]
  racedSubscriptionIds: string[]
  racedOneTimeSessionIds: string[]
}

/**
 * Close every open Checkout for a billing Customer.
 *
 * We intentionally do not rely on mutable price IDs or Checkout metadata:
 * account deletion must close legacy/bound API Sessions and one-time
 * lifetime/tip/group payment Sessions after a product-contract rotation.
 */
export async function expireOpenSubscriptionCheckouts(params: {
  stripeClient: Stripe
  customerId: string
}): Promise<ExpireOpenCheckoutsResult> {
  assertCustomerId(params.customerId)

  const openSessions: Stripe.Checkout.Session[] = []
  const seenSessionIds = new Set<string>()
  let startingAfter: string | undefined

  while (true) {
    const page = await params.stripeClient.checkout.sessions.list({
      customer: params.customerId,
      status: 'open',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })

    for (const session of page.data) {
      if (!session.id || seenSessionIds.has(session.id)) {
        throw new Error('Stripe Checkout pagination returned a duplicate or missing Session ID')
      }
      seenSessionIds.add(session.id)
      openSessions.push(session)
    }

    if (!page.has_more) break
    const nextCursor = page.data.at(-1)?.id
    if (!nextCursor || nextCursor === startingAfter) {
      throw new Error('Stripe Checkout pagination did not advance')
    }
    startingAfter = nextCursor
  }

  const expiredSessionIds: string[] = []
  const racedSubscriptionIds: string[] = []
  const racedOneTimeSessionIds: string[] = []

  for (const listedSession of openSessions) {
    assertOwnedByCustomer(listedSession, params.customerId)

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

    assertOwnedByCustomer(currentSession, params.customerId)
    if (currentSession.status === 'expired') {
      expiredSessionIds.push(currentSession.id)
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
      } else {
        racedOneTimeSessionIds.push(currentSession.id)
      }
      continue
    }

    throw new Error(`Checkout Session ${currentSession.id} remains payable`)
  }

  return { expiredSessionIds, racedSubscriptionIds, racedOneTimeSessionIds }
}
