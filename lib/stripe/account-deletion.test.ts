/** @jest-environment node */

import type Stripe from 'stripe'
import {
  ACCOUNT_DELETION_PAUSE_METADATA_KEY,
  B2CSubscriptionRecoveryIdentityConflictError,
  B2CSubscriptionRecoveryWriteUncertainError,
  discoverStripeSubscriptionBilling,
  expireOpenSubscriptionCheckouts,
  recoverExactB2CSubscriptionRenewal,
  resumeStripeSubscriptionRenewals,
  stopExactFrozenB2CSubscriptionForCompensation,
  stopStripeSubscriptionRenewals,
} from './account-deletion'

const mockListCheckouts = jest.fn()
const mockExpireCheckout = jest.fn()
const mockRetrieveCheckout = jest.fn()
const mockListSubscriptions = jest.fn()
const mockRetrieveSubscription = jest.fn()
const mockUpdateSubscription = jest.fn()
const mockCancelSubscription = jest.fn()
const mockRetrieveCustomer = jest.fn()
const PAUSE_MARKER = 'user-1'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const PERIOD_START = 1_800_000_000
const PERIOD_END = 1_802_592_000

const stripeClient = {
  checkout: {
    sessions: {
      list: mockListCheckouts,
      expire: mockExpireCheckout,
      retrieve: mockRetrieveCheckout,
    },
  },
  subscriptions: {
    list: mockListSubscriptions,
    retrieve: mockRetrieveSubscription,
    update: mockUpdateSubscription,
    cancel: mockCancelSubscription,
  },
  customers: {
    retrieve: mockRetrieveCustomer,
  },
} as unknown as Stripe

function subscription(
  id: string,
  overrides: Partial<Stripe.Subscription> = {}
): Stripe.Subscription {
  return {
    object: 'subscription',
    id,
    customer: 'cus_owner',
    livemode: true,
    status: 'active',
    cancel_at_period_end: false,
    metadata: {},
    ...overrides,
  } as Stripe.Subscription
}

function recoverySubscription(
  id: string,
  overrides: Partial<Stripe.Subscription> = {},
  itemOverrides: Partial<Stripe.SubscriptionItem> = {},
  priceOverrides: Partial<Stripe.Price> = {}
): Stripe.Subscription {
  const price = {
    object: 'price',
    id: 'price_pro_monthly',
    livemode: true,
    unit_amount: 2_000,
    currency: 'usd',
    recurring: { interval: 'month', interval_count: 1 },
    ...priceOverrides,
  } as Stripe.Price
  const item = {
    object: 'subscription_item',
    id: 'si_recovery',
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    price,
    quantity: 1,
    ...itemOverrides,
  } as Stripe.SubscriptionItem
  return subscription(id, {
    collection_method: 'charge_automatically',
    pause_collection: null,
    pending_update: null,
    schedule: null,
    items: page([item]),
    ...overrides,
  })
}

function checkout(
  id: string,
  overrides: Partial<Stripe.Checkout.Session> = {}
): Stripe.Checkout.Session {
  return {
    object: 'checkout.session',
    id,
    customer: 'cus_owner',
    mode: 'subscription',
    status: 'open',
    payment_status: 'unpaid',
    livemode: true,
    client_reference_id: null,
    metadata: {},
    subscription: null,
    ...overrides,
  } as Stripe.Checkout.Session
}

function page<T>(data: T[], hasMore = false) {
  return { object: 'list', data, has_more: hasMore, url: '/v1/test' }
}

describe('account deletion Stripe shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListCheckouts.mockResolvedValue(page([]))
    mockListSubscriptions.mockResolvedValue(page([]))
    mockRetrieveCustomer.mockResolvedValue({
      object: 'customer',
      id: 'cus_owner',
      deleted: false,
      livemode: true,
      metadata: { userId: USER_ID },
    })
    mockUpdateSubscription.mockImplementation(
      async (id: string, update: { cancel_at_period_end?: boolean; metadata?: Stripe.Metadata }) =>
        subscription(id, {
          cancel_at_period_end: update.cancel_at_period_end ?? false,
          metadata: update.metadata ?? {},
        })
    )
    mockCancelSubscription.mockImplementation(async (id: string) =>
      subscription(id, { status: 'canceled' })
    )
  })

  it.each([
    [
      'wrong returned identity',
      {
        object: 'customer',
        id: 'cus_other',
        deleted: false,
        livemode: true,
        metadata: { userId: USER_ID },
      },
    ],
    [
      'foreign owner',
      {
        object: 'customer',
        id: 'cus_owner',
        deleted: false,
        livemode: true,
        metadata: { userId: 'foreign-user' },
      },
    ],
    [
      'missing owner',
      {
        object: 'customer',
        id: 'cus_owner',
        deleted: false,
        livemode: true,
        metadata: {},
      },
    ],
    [
      'conflicting owner aliases',
      {
        object: 'customer',
        id: 'cus_owner',
        deleted: false,
        livemode: true,
        metadata: { userId: USER_ID, supabase_user_id: 'foreign-user' },
      },
    ],
    [
      'deleted object',
      {
        object: 'customer',
        id: 'cus_owner',
        deleted: true,
      },
    ],
    [
      'wrong mode',
      {
        object: 'customer',
        id: 'cus_owner',
        deleted: false,
        livemode: false,
        metadata: { userId: USER_ID },
      },
    ],
  ])(
    'attests Customer before every customer-scoped shutdown operation: %s',
    async (_label, customer) => {
      mockRetrieveCustomer.mockResolvedValue(customer)

      await expect(
        stopStripeSubscriptionRenewals({
          stripeClient,
          expectedUserId: USER_ID,
          livemode: true,
          subscriptionIds: ['sub_local'],
          expectedCustomerId: 'cus_owner',
          deletionMode: 'permanent',
        })
      ).rejects.toThrow()
      await expect(
        expireOpenSubscriptionCheckouts({
          stripeClient,
          customerId: 'cus_owner',
          expectedUserId: USER_ID,
          livemode: true,
        })
      ).rejects.toThrow()

      expect(mockListSubscriptions).not.toHaveBeenCalled()
      expect(mockRetrieveSubscription).not.toHaveBeenCalled()
      expect(mockUpdateSubscription).not.toHaveBeenCalled()
      expect(mockCancelSubscription).not.toHaveBeenCalled()
      expect(mockListCheckouts).not.toHaveBeenCalled()
      expect(mockExpireCheckout).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['wrong object', subscription('sub_local', { object: 'customer' as 'subscription' })],
    ['wrong id', subscription('sub_other')],
    ['wrong customer', subscription('sub_local', { customer: 'cus_foreign' })],
    ['wrong mode', subscription('sub_local', { livemode: false })],
  ])('rejects an explicit Subscription read with %s before mutation', async (_label, remote) => {
    mockRetrieveSubscription.mockResolvedValue(remote)

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_local'],
        expectedCustomerId: 'cus_owner',
        includeCustomerSubscriptions: false,
        deletionMode: 'permanent',
      })
    ).rejects.toThrow()

    expect(mockUpdateSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('discovers and immediately cancels API and consumer subscriptions for the customer', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([subscription('sub_consumer'), subscription('sub_api')])
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_consumer', 'sub_api'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api', 'sub_consumer'],
      changedSubscriptionIds: ['sub_consumer', 'sub_api'],
    })

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockRetrieveCustomer).toHaveBeenCalledWith('cus_owner')
    expect(mockRetrieveCustomer.mock.invocationCallOrder[0]).toBeLessThan(
      mockListSubscriptions.mock.invocationCallOrder[0]
    )
    expect(mockUpdateSubscription).toHaveBeenNthCalledWith(1, 'sub_consumer', {
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER,
      },
    })
    expect(mockUpdateSubscription).toHaveBeenNthCalledWith(2, 'sub_api', {
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER,
      },
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
  })

  it('immediately cancels subscriptions that were already set to end after the period', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([
        subscription('sub_terminal', { status: 'canceled' }),
        subscription('sub_paused', { cancel_at_period_end: true }),
        subscription('sub_deletion_paused', {
          cancel_at_period_end: true,
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        }),
      ])
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_terminal', 'sub_paused', 'sub_deletion_paused'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_deletion_paused', 'sub_paused', 'sub_terminal'],
      changedSubscriptionIds: ['sub_paused', 'sub_deletion_paused'],
    })
    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    expect(mockUpdateSubscription).toHaveBeenCalledWith('sub_paused', {
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER,
      },
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
  })

  it('reports terminal and live subscriptions that were explicitly retrieved', async () => {
    mockRetrieveSubscription.mockImplementation(async (id: string) =>
      subscription(id, { status: id === 'sub_terminal' ? 'canceled' : 'active' })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_terminal', 'sub_live'],
        deletionMode: 'permanent',
        includeCustomerSubscriptions: false,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_live', 'sub_terminal'],
      changedSubscriptionIds: ['sub_live'],
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(1)
    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_live', {
      invoice_now: false,
      prorate: false,
    })
  })

  it('does not re-read or mutate when no explicit Subscription can derive a Customer', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'resource_missing' })
    mockRetrieveSubscription.mockRejectedValue(missing)

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_missing'],
        deletionMode: 'permanent',
        includeCustomerSubscriptions: false,
      })
    ).resolves.toEqual({
      customerId: null,
      observedSubscriptionIds: [],
      changedSubscriptionIds: [],
    })

    expect(mockRetrieveSubscription).toHaveBeenCalledTimes(1)
    expect(mockRetrieveCustomer).not.toHaveBeenCalled()
    expect(mockUpdateSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('does not misclassify a missing derived Customer as a missing Subscription', async () => {
    mockRetrieveSubscription.mockResolvedValue(subscription('sub_derived'))
    mockRetrieveCustomer.mockRejectedValue(
      Object.assign(new Error('missing Customer'), { code: 'resource_missing' })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_derived'],
        deletionMode: 'permanent',
        includeCustomerSubscriptions: false,
      })
    ).rejects.toThrow('missing Customer')

    expect(mockListSubscriptions).not.toHaveBeenCalled()
    expect(mockUpdateSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('validates every discovered subscription owner before changing billing', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([subscription('sub_wrong', { customer: 'cus_other' })])
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: [],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'permanent',
      })
    ).rejects.toThrow('belongs to a different customer')
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('validates the marked Subscription response before cancellation', async () => {
    mockListSubscriptions.mockResolvedValue(page([subscription('sub_local')]))
    mockUpdateSubscription.mockResolvedValue(
      subscription('sub_local', {
        customer: 'cus_foreign',
        metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
      })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_local'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).rejects.toThrow('belongs to a different customer')
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('rejects a cancellation response from a different Stripe mode', async () => {
    mockListSubscriptions.mockResolvedValue(page([subscription('sub_local')]))
    mockCancelSubscription.mockResolvedValue(
      subscription('sub_local', { status: 'canceled', livemode: false })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_local'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'permanent',
      })
    ).rejects.toThrow('belongs to a different mode')
  })

  it('verifies the derived Stripe Customer identity before exposing it for binding', async () => {
    mockRetrieveSubscription.mockResolvedValue(subscription('sub_derived'))

    await expect(
      discoverStripeSubscriptionBilling({
        stripeClient,
        livemode: true,
        subscriptionIds: ['sub_derived'],
        expectedUserId: USER_ID,
        includeCustomerSubscriptions: false,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_derived'],
    })

    expect(mockRetrieveCustomer).toHaveBeenCalledWith('cus_owner')
    expect(mockRetrieveSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      mockRetrieveCustomer.mock.invocationCallOrder[0]
    )
    expect(mockUpdateSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockExpireCheckout).not.toHaveBeenCalled()
  })

  it('rejects a derived Customer owned by another user before any Stripe mutation', async () => {
    mockRetrieveSubscription.mockResolvedValue(subscription('sub_foreign'))
    mockRetrieveCustomer.mockResolvedValue({
      object: 'customer',
      id: 'cus_owner',
      deleted: false,
      livemode: true,
      metadata: { userId: 'another-user' },
    })

    await expect(
      discoverStripeSubscriptionBilling({
        stripeClient,
        livemode: true,
        subscriptionIds: ['sub_foreign'],
        expectedUserId: USER_ID,
        includeCustomerSubscriptions: false,
      })
    ).rejects.toThrow('belongs to a different user')

    expect(mockUpdateSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockExpireCheckout).not.toHaveBeenCalled()
  })

  it.each(['past_due', 'incomplete'] as Stripe.Subscription.Status[])(
    'immediately cancels %s subscriptions so invoice retries cannot charge a deleted account',
    async (status) => {
      mockListSubscriptions.mockResolvedValue(page([subscription('sub_unpaid', { status })]))

      await expect(
        stopStripeSubscriptionRenewals({
          stripeClient,
          expectedUserId: USER_ID,
          livemode: true,
          subscriptionIds: ['sub_unpaid'],
          expectedCustomerId: 'cus_owner',
          deletionMode: 'recoverable',
          pauseMarker: PAUSE_MARKER,
        })
      ).resolves.toEqual({
        customerId: 'cus_owner',
        observedSubscriptionIds: ['sub_unpaid'],
        changedSubscriptionIds: ['sub_unpaid'],
      })

      expect(mockCancelSubscription).toHaveBeenCalledWith('sub_unpaid', {
        invoice_now: false,
        prorate: false,
      })
    }
  )

  it('immediately cancels when the latest finalized invoice is still open and retryable', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([
        subscription('sub_open_invoice', {
          status: 'past_due',
          latest_invoice: {
            object: 'invoice',
            id: 'in_retryable',
            status: 'open',
            auto_advance: true,
          } as Stripe.Invoice,
        }),
      ])
    )

    await stopStripeSubscriptionRenewals({
      stripeClient,
      expectedUserId: USER_ID,
      livemode: true,
      subscriptionIds: ['sub_open_invoice'],
      expectedCustomerId: 'cus_owner',
      deletionMode: 'recoverable',
      pauseMarker: PAUSE_MARKER,
    })

    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_open_invoice', {
      invoice_now: false,
      prorate: false,
    })
  })

  it('re-reads an ambiguously canceled subscription and accepts only a terminal result', async () => {
    mockListSubscriptions.mockResolvedValue(page([subscription('sub_past_due')]))
    mockCancelSubscription.mockRejectedValue(new Error('connection reset after write'))
    mockRetrieveSubscription.mockResolvedValue(
      subscription('sub_past_due', {
        status: 'canceled',
        metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
      })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_past_due'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_past_due'],
      changedSubscriptionIds: ['sub_past_due'],
    })
  })

  it('fails closed when ambiguous cancellation still resolves to a live subscription', async () => {
    mockListSubscriptions.mockResolvedValue(page([subscription('sub_still_live')]))
    mockCancelSubscription.mockRejectedValue(new Error('connection reset after write'))
    mockRetrieveSubscription.mockResolvedValue(
      subscription('sub_still_live', {
        status: 'past_due',
        metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
      })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_still_live'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'recoverable',
        pauseMarker: PAUSE_MARKER,
      })
    ).rejects.toThrow('was not canceled')
  })

  it('immediately cancels every live remote subscription before hard deletion', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([subscription('sub_consumer'), subscription('sub_api')])
    )
    mockCancelSubscription.mockImplementation(async (id: string) =>
      subscription(id, { status: 'canceled' })
    )

    await expect(
      stopStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_consumer', 'sub_api'],
        expectedCustomerId: 'cus_owner',
        deletionMode: 'permanent',
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api', 'sub_consumer'],
      changedSubscriptionIds: ['sub_consumer', 'sub_api'],
    })
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
  })

  describe('exact frozen recovery compensation shutdown', () => {
    const frozenParams = () => ({
      stripeClient,
      subscriptionId: 'sub_frozen',
      customerId: 'cus_owner',
      expectedUserId: USER_ID,
      livemode: true,
    })
    const exactSubscription = (overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription =>
      subscription('sub_frozen', {
        metadata: { userId: USER_ID },
        ...overrides,
      })

    it('treats an exact missing Subscription as terminal without reading Customer', async () => {
      mockRetrieveSubscription.mockRejectedValue(
        Object.assign(new Error('missing Subscription'), { code: 'resource_missing' })
      )

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).resolves.toEqual({
        status: 'missing',
        subscriptionId: 'sub_frozen',
      })

      expect(mockRetrieveSubscription).toHaveBeenCalledWith('sub_frozen')
      expect(mockRetrieveCustomer).not.toHaveBeenCalled()
      expect(mockListSubscriptions).not.toHaveBeenCalled()
      expect(mockCancelSubscription).not.toHaveBeenCalled()
    })

    it.each(['active', 'canceled'] as Stripe.Subscription.Status[])(
      'fails closed when Customer is missing but the exact %s Subscription still exists',
      async (status) => {
        mockRetrieveSubscription.mockResolvedValue(exactSubscription({ status }))
        mockRetrieveCustomer.mockRejectedValue(
          Object.assign(new Error('missing Customer'), { code: 'resource_missing' })
        )

        await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).rejects.toThrow(
          'missing Customer'
        )

        expect(mockRetrieveSubscription.mock.invocationCallOrder[0]).toBeLessThan(
          mockRetrieveCustomer.mock.invocationCallOrder[0]
        )
        expect(mockCancelSubscription).not.toHaveBeenCalled()
      }
    )

    it('fails closed for a deleted Customer while the exact Subscription exists', async () => {
      mockRetrieveSubscription.mockResolvedValue(exactSubscription())
      mockRetrieveCustomer.mockResolvedValue({
        object: 'customer',
        id: 'cus_owner',
        deleted: true,
      })

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).rejects.toThrow(
        'customer identity could not be verified'
      )
      expect(mockCancelSubscription).not.toHaveBeenCalled()
    })

    it.each([
      ['wrong id', exactSubscription({ id: 'sub_other' })],
      ['wrong customer', exactSubscription({ customer: 'cus_other' })],
      ['wrong mode', exactSubscription({ livemode: false })],
      ['wrong owner', exactSubscription({ metadata: { userId: 'foreign-user' } })],
      ['missing owner', exactSubscription({ metadata: {} })],
      [
        'conflicting owner aliases',
        exactSubscription({
          metadata: { userId: USER_ID, supabase_user_id: 'foreign-user' },
        }),
      ],
    ])('rejects an exact Subscription with %s before Customer or cancel', async (_label, value) => {
      mockRetrieveSubscription.mockResolvedValue(value)

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).rejects.toThrow()

      expect(mockRetrieveCustomer).not.toHaveBeenCalled()
      expect(mockCancelSubscription).not.toHaveBeenCalled()
    })

    it('cancels once and makes a terminal replay read-only', async () => {
      const active = exactSubscription()
      const canceled = exactSubscription({ status: 'canceled' })
      mockRetrieveSubscription.mockResolvedValueOnce(active).mockResolvedValueOnce(canceled)
      mockCancelSubscription.mockResolvedValue(canceled)

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).resolves.toEqual({
        status: 'terminal',
        subscriptionId: 'sub_frozen',
      })
      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).resolves.toEqual({
        status: 'terminal',
        subscriptionId: 'sub_frozen',
      })

      expect(mockCancelSubscription).toHaveBeenCalledTimes(1)
      expect(mockCancelSubscription).toHaveBeenCalledWith('sub_frozen', {
        invoice_now: false,
        prorate: false,
      })
      expect(mockRetrieveSubscription).toHaveBeenCalledTimes(2)
      expect(mockRetrieveSubscription.mock.invocationCallOrder[0]).toBeLessThan(
        mockRetrieveCustomer.mock.invocationCallOrder[0]
      )
      expect(mockRetrieveCustomer.mock.invocationCallOrder[0]).toBeLessThan(
        mockCancelSubscription.mock.invocationCallOrder[0]
      )
    })

    it.each([
      ['wrong id', exactSubscription({ id: 'sub_other', status: 'canceled' })],
      ['wrong customer', exactSubscription({ customer: 'cus_other', status: 'canceled' })],
      ['wrong mode', exactSubscription({ livemode: false, status: 'canceled' })],
      [
        'wrong owner',
        exactSubscription({ metadata: { userId: 'foreign-user' }, status: 'canceled' }),
      ],
      ['non-terminal state', exactSubscription({ status: 'active' })],
    ])('rejects a cancel response with %s', async (_label, canceled) => {
      mockRetrieveSubscription.mockResolvedValue(exactSubscription())
      mockCancelSubscription.mockResolvedValue(canceled)

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).rejects.toThrow()
    })

    it('accepts resource_missing from the exact cancel as terminal success', async () => {
      mockRetrieveSubscription.mockResolvedValue(exactSubscription())
      mockCancelSubscription.mockRejectedValue(
        Object.assign(new Error('missing after cancel'), { code: 'resource_missing' })
      )

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).resolves.toEqual({
        status: 'missing',
        subscriptionId: 'sub_frozen',
      })
    })

    it('proves an ambiguous cancel by re-reading the exact terminal Subscription', async () => {
      mockRetrieveSubscription
        .mockResolvedValueOnce(exactSubscription())
        .mockResolvedValueOnce(exactSubscription({ status: 'canceled' }))
      mockCancelSubscription.mockRejectedValue(new Error('connection reset after write'))

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).resolves.toEqual({
        status: 'terminal',
        subscriptionId: 'sub_frozen',
      })

      expect(mockRetrieveSubscription).toHaveBeenCalledTimes(2)
      expect(mockRetrieveCustomer).toHaveBeenCalledTimes(2)
    })

    it('accepts an exact missing Subscription after an ambiguous cancel', async () => {
      mockRetrieveSubscription
        .mockResolvedValueOnce(exactSubscription())
        .mockRejectedValueOnce(
          Object.assign(new Error('missing after write'), { code: 'resource_missing' })
        )
      mockCancelSubscription.mockRejectedValue(new Error('connection reset after write'))

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).resolves.toEqual({
        status: 'missing',
        subscriptionId: 'sub_frozen',
      })
      expect(mockRetrieveCustomer).toHaveBeenCalledTimes(1)
    })

    it('fails closed when an ambiguous cancel re-read remains live', async () => {
      mockRetrieveSubscription.mockResolvedValue(exactSubscription())
      mockCancelSubscription.mockRejectedValue(new Error('connection reset after write'))

      await expect(stopExactFrozenB2CSubscriptionForCompensation(frozenParams())).rejects.toThrow(
        'was not canceled'
      )

      expect(mockRetrieveSubscription).toHaveBeenCalledTimes(2)
      expect(mockRetrieveCustomer).toHaveBeenCalledTimes(2)
    })
  })

  it('paginates and expires every open Checkout including one-time payments', async () => {
    mockListCheckouts
      .mockResolvedValueOnce(
        page(
          [
            checkout('cs_api_1'),
            checkout('cs_tip', {
              mode: 'payment',
            }),
          ],
          true
        )
      )
      .mockResolvedValueOnce(page([checkout('cs_api_2')]))
    mockExpireCheckout.mockImplementation(async (id: string) =>
      checkout(id, {
        mode: id === 'cs_tip' ? 'payment' : 'subscription',
        status: 'expired',
      })
    )

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).resolves.toEqual({
      expiredSessionIds: ['cs_api_1', 'cs_tip', 'cs_api_2'],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [
        {
          checkoutSessionId: 'cs_tip',
          livemode: true,
          stripeCustomerId: 'cus_owner',
          productKind: 'unknown',
          stripeStatus: 'expired',
          paymentStatus: 'unpaid',
          ownershipStatus: 'mismatch',
        },
      ],
    })

    expect(mockListCheckouts).toHaveBeenNthCalledWith(2, {
      customer: 'cus_owner',
      status: 'open',
      limit: 100,
      starting_after: 'cs_tip',
    })
    expect(mockExpireCheckout).toHaveBeenCalledTimes(3)
    expect(mockExpireCheckout).toHaveBeenCalledWith('cs_tip')
  })

  it('rejects a Checkout list response from a different Stripe mode before expiration', async () => {
    mockListCheckouts.mockResolvedValue(page([checkout('cs_wrong_mode', { livemode: false })]))

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).rejects.toThrow('belongs to a different mode')
    expect(mockExpireCheckout).not.toHaveBeenCalled()
  })

  it('fully paginates and classifies pre-existing complete one-time Checkouts', async () => {
    const tipId = '22222222-2222-4222-8222-222222222222'
    const postId = '33333333-3333-4333-8333-333333333333'
    const recipientId = '44444444-4444-4444-8444-444444444444'
    const groupId = '55555555-5555-4555-8555-555555555555'
    const reservationId = '66666666-6666-4666-8666-666666666666'
    mockListCheckouts
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        page(
          [
            checkout('cs_lifetime', {
              mode: 'payment',
              status: 'complete',
              payment_status: 'paid',
              metadata: {
                lifetime_reservation_id: reservationId,
                lifetime_reservation_nonce: 'lifetime:nonce:123',
                plan: 'lifetime',
                supabase_user_id: USER_ID,
                userId: USER_ID,
              },
            }),
            checkout('cs_tip', {
              mode: 'payment',
              status: 'complete',
              payment_status: 'paid',
              client_reference_id: tipId,
              metadata: {
                amount_cents: '500',
                from_user_id: USER_ID,
                post_id: postId,
                tip_id: tipId,
                to_user_id: recipientId,
                type: 'tip',
                user_id: USER_ID,
              },
            }),
          ],
          true
        )
      )
      .mockResolvedValueOnce(
        page([
          checkout('cs_group', {
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
            client_reference_id: USER_ID,
            metadata: {
              group_id: groupId,
              tier: 'monthly',
              user_id: USER_ID,
            },
          }),
          checkout('cs_unknown', {
            mode: 'payment',
            status: 'complete',
            payment_status: 'paid',
          }),
        ])
      )

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).resolves.toEqual({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [
        expect.objectContaining({
          checkoutSessionId: 'cs_group',
          productKind: 'group_pass',
          ownershipStatus: 'exact',
        }),
        expect.objectContaining({
          checkoutSessionId: 'cs_lifetime',
          productKind: 'lifetime',
          ownershipStatus: 'exact',
        }),
        expect.objectContaining({
          checkoutSessionId: 'cs_tip',
          productKind: 'tip',
          ownershipStatus: 'exact',
        }),
        expect.objectContaining({
          checkoutSessionId: 'cs_unknown',
          productKind: 'unknown',
          ownershipStatus: 'mismatch',
        }),
      ],
    })
    expect(mockListCheckouts).toHaveBeenNthCalledWith(3, {
      customer: 'cus_owner',
      status: 'complete',
      limit: 100,
      starting_after: 'cs_tip',
    })
  })

  it('fails closed when complete Checkout pagination returns an empty continuation', async () => {
    mockListCheckouts
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(
        page(
          [
            checkout('cs_complete', {
              mode: 'payment',
              status: 'complete',
              payment_status: 'paid',
            }),
          ],
          true
        )
      )
      .mockResolvedValueOnce(page([]))

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).rejects.toThrow('empty continuation')
  })

  it('returns the exact subscription when open Checkout completes during expiration', async () => {
    mockListCheckouts.mockResolvedValueOnce(page([checkout('cs_raced')]))
    mockExpireCheckout.mockRejectedValue(new Error('session is no longer open'))
    mockRetrieveCheckout.mockResolvedValue(
      checkout('cs_raced', {
        status: 'complete',
        subscription: 'sub_raced',
      })
    )

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).resolves.toEqual({
      expiredSessionIds: [],
      racedSubscriptionIds: ['sub_raced'],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [],
    })
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('surfaces a one-time payment that completes during expiration', async () => {
    mockListCheckouts.mockResolvedValueOnce(page([checkout('cs_tip_raced', { mode: 'payment' })]))
    mockExpireCheckout.mockRejectedValue(new Error('session is no longer open'))
    mockRetrieveCheckout.mockResolvedValue(
      checkout('cs_tip_raced', {
        mode: 'payment',
        status: 'complete',
        payment_status: 'paid',
      })
    )

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).resolves.toEqual({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: ['cs_tip_raced'],
      oneTimeSettlements: [
        {
          checkoutSessionId: 'cs_tip_raced',
          livemode: true,
          stripeCustomerId: 'cus_owner',
          productKind: 'unknown',
          stripeStatus: 'complete',
          paymentStatus: 'paid',
          ownershipStatus: 'mismatch',
        },
      ],
    })
  })

  it('fails closed when an open Checkout cannot be made non-payable', async () => {
    mockListCheckouts.mockResolvedValueOnce(page([checkout('cs_open')]))
    mockExpireCheckout.mockRejectedValue(new Error('Stripe unavailable'))
    mockRetrieveCheckout.mockResolvedValue(checkout('cs_open'))

    await expect(
      expireOpenSubscriptionCheckouts({
        stripeClient,
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: true,
      })
    ).rejects.toThrow('remains payable')
  })

  describe('exact B2C account recovery', () => {
    const recoveryParams = {
      stripeClient,
      subscriptionId: 'sub_b2c_current',
      expectedCustomerId: 'cus_owner',
      expectedUserId: USER_ID,
      livemode: true,
      authorityKind: 'paid' as const,
      plan: 'monthly' as const,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      priceId: 'price_pro_monthly',
      expectedAmount: 2_000,
      currency: 'usd',
      pauseMarker: PAUSE_MARKER,
    }

    it.each([
      [
        'wrong owner',
        {
          object: 'customer',
          id: 'cus_owner',
          deleted: false,
          livemode: true,
          metadata: { userId: 'foreign-user' },
        },
      ],
      [
        'wrong mode',
        {
          object: 'customer',
          id: 'cus_owner',
          deleted: false,
          livemode: false,
          metadata: { userId: USER_ID },
        },
      ],
    ])('types a deterministic Customer %s conflict before any write', async (_label, customer) => {
      mockRetrieveCustomer.mockResolvedValue(customer)
      await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).rejects.toBeInstanceOf(
        B2CSubscriptionRecoveryIdentityConflictError
      )
      expect(mockRetrieveSubscription).not.toHaveBeenCalled()
      expect(mockUpdateSubscription).not.toHaveBeenCalled()
      expect(mockCancelSubscription).not.toHaveBeenCalled()
    })

    it('resumes and fresh-verifies only the exact frozen B2C target', async () => {
      mockRetrieveSubscription
        .mockResolvedValueOnce(
          recoverySubscription('sub_b2c_current', {
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          })
        )
        .mockResolvedValueOnce(recoverySubscription('sub_b2c_current'))
      mockUpdateSubscription.mockResolvedValue(recoverySubscription('sub_b2c_current'))

      await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).resolves.toEqual({
        stripe_subscription_id: 'sub_b2c_current',
        stripe_customer_id: 'cus_owner',
        livemode: true,
        status: 'active',
        cancel_at_period_end: false,
        current_period_start: PERIOD_START,
        current_period_end: PERIOD_END,
        stripe_price_id: 'price_pro_monthly',
        unit_amount: 2_000,
        currency: 'usd',
        quantity: 1,
        collection_method: 'charge_automatically',
        has_pause_collection: false,
        has_pending_update: false,
        has_subscription_schedule: false,
        resume_state: 'resumed',
      })
      expect(mockListSubscriptions).not.toHaveBeenCalled()
      expect(mockRetrieveSubscription).toHaveBeenNthCalledWith(1, 'sub_b2c_current')
      expect(mockUpdateSubscription).toHaveBeenCalledWith('sub_b2c_current', {
        cancel_at_period_end: false,
        metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: '' },
      })
    })

    it('accepts only a same-kind trialing target', async () => {
      mockRetrieveSubscription
        .mockResolvedValueOnce(
          recoverySubscription('sub_b2c_current', {
            status: 'trialing',
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          })
        )
        .mockResolvedValueOnce(recoverySubscription('sub_b2c_current', { status: 'trialing' }))
      mockUpdateSubscription.mockResolvedValue(
        recoverySubscription('sub_b2c_current', { status: 'trialing' })
      )

      await expect(
        recoverExactB2CSubscriptionRenewal({ ...recoveryParams, authorityKind: 'trial' })
      ).resolves.toMatchObject({ status: 'trialing', resume_state: 'resumed' })
      expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    })

    it.each([
      'past_due',
      'unpaid',
      'paused',
      'incomplete',
      'canceled',
      'incomplete_expired',
      'trialing',
    ] as Stripe.Subscription.Status[])(
      'observes %s without clearing a deletion cancellation marker',
      async (status) => {
        mockRetrieveSubscription.mockResolvedValue(
          recoverySubscription('sub_b2c_current', {
            status,
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          })
        )

        await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).resolves.toMatchObject({
          status,
          resume_state: 'ineligible',
        })
        expect(mockUpdateSubscription).not.toHaveBeenCalled()
      }
    )

    it('does not write an otherwise exact expired paid or trial target', async () => {
      const expiredStart = Math.floor(Date.now() / 1_000) - 7_200
      const expiredEnd = Math.floor(Date.now() / 1_000) - 3_600
      mockRetrieveSubscription.mockResolvedValue(
        recoverySubscription(
          'sub_b2c_current',
          {
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          },
          { current_period_start: expiredStart, current_period_end: expiredEnd }
        )
      )

      await expect(
        recoverExactB2CSubscriptionRenewal({
          ...recoveryParams,
          periodStart: expiredStart,
          periodEnd: expiredEnd,
        })
      ).resolves.toMatchObject({ resume_state: 'ineligible' })
      expect(mockUpdateSubscription).not.toHaveBeenCalled()
    })

    it.each([
      ['changed price', recoverySubscription('sub_b2c_current', {}, {}, { id: 'price_api_pro' })],
      ['changed amount', recoverySubscription('sub_b2c_current', {}, {}, { unit_amount: 9_999 })],
      ['changed currency', recoverySubscription('sub_b2c_current', {}, {}, { currency: 'eur' })],
      [
        'changed recurring interval',
        recoverySubscription(
          'sub_b2c_current',
          {},
          {},
          { recurring: { interval: 'year', interval_count: 1 } as Stripe.Price.Recurring }
        ),
      ],
      [
        'changed recurring interval count',
        recoverySubscription(
          'sub_b2c_current',
          {},
          {},
          { recurring: { interval: 'month', interval_count: 2 } as Stripe.Price.Recurring }
        ),
      ],
      ['changed quantity', recoverySubscription('sub_b2c_current', {}, { quantity: 2 })],
      [
        'period drift',
        recoverySubscription('sub_b2c_current', {}, { current_period_end: PERIOD_END + 1 }),
      ],
      [
        'manual invoices',
        recoverySubscription('sub_b2c_current', { collection_method: 'send_invoice' }),
      ],
      [
        'paused collection',
        recoverySubscription('sub_b2c_current', {
          pause_collection: { behavior: 'void' },
        }),
      ],
      [
        'pending update',
        recoverySubscription('sub_b2c_current', {
          pending_update: { expires_at: PERIOD_END },
        }),
      ],
      [
        'subscription schedule',
        recoverySubscription('sub_b2c_current', { schedule: 'sub_sched_future_price' }),
      ],
    ] satisfies Array<[string, Stripe.Subscription]>)(
      'returns ineligible fresh evidence without a Stripe write for %s',
      async (_label, value) => {
        mockRetrieveSubscription.mockResolvedValue(value)
        await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).resolves.toMatchObject({
          resume_state: 'ineligible',
        })
        expect(mockUpdateSubscription).not.toHaveBeenCalled()
      }
    )

    it('returns exact missing evidence without customer enumeration', async () => {
      mockRetrieveSubscription.mockRejectedValue({ code: 'resource_missing' })
      await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).resolves.toEqual({
        stripe_subscription_id: 'sub_b2c_current',
        missing: true,
      })
      expect(mockListSubscriptions).not.toHaveBeenCalled()
      expect(mockUpdateSubscription).not.toHaveBeenCalled()
    })

    it.each([
      ['wrong subscription ID', recoverySubscription('sub_api')],
      ['wrong customer', recoverySubscription('sub_b2c_current', { customer: 'cus_foreign' })],
      [
        'wrong mode',
        recoverySubscription('sub_b2c_current', { livemode: false }, {}, { livemode: false }),
      ],
    ] satisfies Array<[string, Stripe.Subscription]>)(
      'returns non-mutating identity-conflict evidence for %s',
      async (_label, value) => {
        mockRetrieveSubscription.mockResolvedValue(value)
        await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).resolves.toMatchObject({
          resume_state: 'ineligible',
        })
        expect(mockUpdateSubscription).not.toHaveBeenCalled()
        expect(mockListSubscriptions).not.toHaveBeenCalled()
      }
    )

    it('returns a typed non-write conflict for contradictory owner metadata', async () => {
      mockRetrieveSubscription.mockResolvedValue(
        recoverySubscription('sub_b2c_current', {
          metadata: { userId: 'foreign-user' },
        })
      )
      await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).rejects.toBeInstanceOf(
        B2CSubscriptionRecoveryIdentityConflictError
      )
      expect(mockUpdateSubscription).not.toHaveBeenCalled()
    })

    it('accepts a committed recovery write whose response was lost', async () => {
      mockRetrieveSubscription
        .mockResolvedValueOnce(
          recoverySubscription('sub_b2c_current', {
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          })
        )
        .mockResolvedValueOnce(recoverySubscription('sub_b2c_current'))
      mockUpdateSubscription.mockRejectedValue(new Error('connection reset after write'))

      await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).resolves.toMatchObject({
        resume_state: 'resumed',
      })
    })

    it('marks an unverified recovery write as compensation-required', async () => {
      const marked = recoverySubscription('sub_b2c_current', {
        cancel_at_period_end: true,
        metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
      })
      mockRetrieveSubscription.mockResolvedValue(marked)
      mockUpdateSubscription.mockRejectedValue(new Error('connection reset after write'))

      await expect(recoverExactB2CSubscriptionRenewal(recoveryParams)).rejects.toBeInstanceOf(
        B2CSubscriptionRecoveryWriteUncertainError
      )
    })
  })

  it('resumes only nonterminal subscriptions still scheduled to cancel', async () => {
    mockRetrieveSubscription
      .mockResolvedValueOnce(
        subscription('sub_resume', {
          cancel_at_period_end: true,
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        })
      )
      .mockResolvedValueOnce(
        subscription('sub_terminal', {
          status: 'canceled',
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        })
      )
    mockUpdateSubscription.mockResolvedValue(
      subscription('sub_resume', { cancel_at_period_end: false, metadata: {} })
    )

    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_resume', 'sub_terminal'],
        expectedCustomerId: 'cus_owner',
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_resume', 'sub_terminal'],
      changedSubscriptionIds: ['sub_resume'],
      terminalMarkedSubscriptionIds: ['sub_terminal'],
    })

    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    expect(mockUpdateSubscription).toHaveBeenCalledWith('sub_resume', {
      cancel_at_period_end: false,
      metadata: {
        [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: '',
      },
    })
  })

  it('refuses to derive a Customer inside the Stripe mutation boundary', async () => {
    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_foreign'],
        expectedCustomerId: '',
        pauseMarker: PAUSE_MARKER,
      })
    ).rejects.toThrow('durably bound Stripe customer')

    expect(mockRetrieveSubscription).not.toHaveBeenCalled()
    expect(mockUpdateSubscription).not.toHaveBeenCalled()
    expect(mockCancelSubscription).not.toHaveBeenCalled()
  })

  it('enumerates a customer but resumes only subscriptions marked by this deletion', async () => {
    mockListSubscriptions.mockResolvedValue(
      page([
        subscription('sub_api', {
          cancel_at_period_end: true,
          metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
        }),
        subscription('sub_user_cancelled', {
          cancel_at_period_end: true,
          metadata: {},
        }),
      ])
    )
    mockUpdateSubscription.mockResolvedValue(
      subscription('sub_api', { cancel_at_period_end: false, metadata: {} })
    )

    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: [],
        expectedCustomerId: 'cus_owner',
        includeCustomerSubscriptions: true,
        pauseMarker: PAUSE_MARKER,
      })
    ).resolves.toEqual({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api', 'sub_user_cancelled'],
      changedSubscriptionIds: ['sub_api'],
      terminalMarkedSubscriptionIds: [],
    })

    expect(mockUpdateSubscription).toHaveBeenCalledTimes(1)
    expect(mockUpdateSubscription).not.toHaveBeenCalledWith('sub_user_cancelled', expect.anything())
  })

  it('re-enumerates and stops the entire customer after an ambiguous recovery write', async () => {
    mockListSubscriptions
      .mockResolvedValueOnce(
        page([
          subscription('sub_ambiguous', {
            cancel_at_period_end: true,
            metadata: { [ACCOUNT_DELETION_PAUSE_METADATA_KEY]: PAUSE_MARKER },
          }),
        ])
      )
      .mockResolvedValueOnce(
        page([
          // The first update committed in Stripe but its response was lost.
          subscription('sub_ambiguous', {
            cancel_at_period_end: false,
            metadata: {},
          }),
          // A concurrent/unlinked subscription must also be stopped while the
          // account remains tombstoned.
          subscription('sub_concurrent', {
            cancel_at_period_end: false,
            metadata: {},
          }),
        ])
      )
    mockUpdateSubscription
      .mockRejectedValueOnce(new Error('connection reset after write'))
      .mockImplementation(
        async (
          id: string,
          update: { cancel_at_period_end?: boolean; metadata?: Stripe.Metadata }
        ) =>
          subscription(id, {
            cancel_at_period_end: update.cancel_at_period_end ?? false,
            metadata: update.metadata ?? {},
          })
      )

    await expect(
      resumeStripeSubscriptionRenewals({
        stripeClient,
        expectedUserId: USER_ID,
        livemode: true,
        subscriptionIds: ['sub_ambiguous'],
        expectedCustomerId: 'cus_owner',
        includeCustomerSubscriptions: true,
        pauseMarker: PAUSE_MARKER,
      })
    ).rejects.toThrow('connection reset after write')

    expect(mockListSubscriptions).toHaveBeenCalledTimes(2)
    expect(mockCancelSubscription).toHaveBeenCalledTimes(2)
    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_ambiguous', {
      invoice_now: false,
      prorate: false,
    })
    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_concurrent', {
      invoice_now: false,
      prorate: false,
    })
  })
})
