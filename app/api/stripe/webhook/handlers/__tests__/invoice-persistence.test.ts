import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockRetrieveSubscription = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/stripe', () => ({
  STRIPE_API_PRICE_IDS: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
  stripe: {
    subscriptions: {
      retrieve: (...args: unknown[]) => mockRetrieveSubscription(...args),
    },
  },
}))

jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))

import { handlePaymentFailed, handlePaymentSucceeded } from '../invoice'

type DbError = { message: string }

function lookupQuery(data: unknown, error: DbError | null = null) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn(async () => ({ data, error })),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function mutationQuery(error: DbError | null = null) {
  const result = { error }
  const query: {
    upsert: jest.Mock
    update: jest.Mock
    eq: jest.Mock
    then: Promise<typeof result>['then']
  } = {
    upsert: jest.fn(),
    update: jest.fn(),
    eq: jest.fn(),
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  }
  query.upsert.mockReturnValue(query)
  query.update.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function invoice(overrides: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test',
    customer: 'cus_owner',
    amount_paid: 2500,
    amount_due: 2500,
    currency: 'usd',
    parent: {
      subscription_details: {
        subscription: 'sub_current',
      },
    },
    ...overrides,
  } as Stripe.Invoice
}

describe('invoice webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_current',
      status: 'active',
      customer: 'cus_owner',
      metadata: {},
      items: { data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }] },
    })
  })

  it('does not turn a successful API invoice into an ordinary Pro entitlement', async () => {
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_current',
      status: 'active',
      metadata: {
        type: 'api_tier',
        api_plan: 'starter',
      },
      items: { data: [{ price: { id: 'price_api_starter' } }] },
    })

    await expect(handlePaymentSucceeded(invoice())).resolves.toBeUndefined()

    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('isolates a current API price even when Stripe omits subscription metadata', async () => {
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_current',
      status: 'active',
      metadata: {},
      items: { data: [{ price: { id: 'price_api_pro' } }] },
    })

    await expect(handlePaymentSucceeded(invoice())).resolves.toBeUndefined()

    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each(['price_api_legacy_pro', 'price_pro_lifetime', 'price_unknown'])(
    'does not restore ordinary Pro for unknown subscription price %s',
    async (priceId) => {
      mockRetrieveSubscription.mockResolvedValue({
        id: 'sub_current',
        status: 'active',
        customer: 'cus_owner',
        metadata: {},
        items: { data: [{ quantity: 1, price: { id: priceId } }] },
      })

      await expect(handlePaymentSucceeded(invoice())).rejects.toThrow(
        'Invoice in_test subscription is not an exact ordinary Pro subscription'
      )

      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('does not write ordinary Pro failure state for an API invoice', async () => {
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_current',
      status: 'past_due',
      metadata: {
        type: 'api_tier',
        api_plan: 'starter',
      },
      items: { data: [{ price: { id: 'price_api_starter' } }] },
    })

    await expect(handlePaymentFailed(invoice())).resolves.toBeUndefined()

    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not write ordinary Pro failure state for a rotated unknown price', async () => {
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_current',
      status: 'past_due',
      customer: 'cus_owner',
      metadata: {},
      items: {
        data: [{ quantity: 1, price: { id: 'price_api_legacy_pro' } }],
      },
    })

    await expect(handlePaymentFailed(invoice())).rejects.toThrow(
      'Invoice in_test subscription is not an exact ordinary Pro subscription'
    )

    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('keeps a successful payment retryable when its history row cannot be written', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'free' }))
      .mockImplementationOnce(() => mutationQuery({ message: 'history write unavailable' }))

    await expect(handlePaymentSucceeded(invoice())).rejects.toThrow(
      'Failed to record successful payment: history write unavailable'
    )
  })

  it('keeps a successful payment retryable when Pro restoration fails', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'free' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() => mutationQuery({ message: 'profile write unavailable' }))

    await expect(handlePaymentSucceeded(invoice())).rejects.toThrow(
      'Failed to restore Pro tier after payment: profile write unavailable'
    )
  })

  it('reconciles the subscription row even when the profile is already Pro', async () => {
    const subscriptionMutation = mutationQuery()
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'pro' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() => subscriptionMutation)

    await expect(handlePaymentSucceeded(invoice())).resolves.toBeUndefined()
    expect(subscriptionMutation.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' })
    )
  })

  it('keeps an active-subscription reconciliation failure retryable', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'pro' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() => mutationQuery({ message: 'subscription write unavailable' }))

    await expect(handlePaymentSucceeded(invoice())).rejects.toThrow(
      'Failed to restore active subscription status: subscription write unavailable'
    )
  })

  it('keeps a failed payment retryable when its history row cannot be written', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'pro' }))
      .mockImplementationOnce(() => mutationQuery({ message: 'failure history unavailable' }))

    await expect(handlePaymentFailed(invoice())).rejects.toThrow(
      'Failed to record payment failure: failure history unavailable'
    )
  })

  it('keeps a past-due transition retryable when subscription persistence fails', async () => {
    mockRetrieveSubscription.mockResolvedValue({
      id: 'sub_current',
      status: 'past_due',
      customer: 'cus_owner',
      metadata: {},
      items: { data: [{ quantity: 1, price: { id: 'price_pro_monthly' } }] },
    })
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'pro' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() => mutationQuery({ message: 'status write unavailable' }))

    await expect(handlePaymentFailed(invoice())).rejects.toThrow(
      'Failed to mark subscription past due: status write unavailable'
    )
  })
})
