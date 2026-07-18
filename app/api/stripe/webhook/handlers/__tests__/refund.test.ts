import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockLeaveProOfficialGroup = jest.fn()
const mockListCheckoutSessions = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  leaveProOfficialGroup: (...args: unknown[]) => mockLeaveProOfficialGroup(...args),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        list: (...args: unknown[]) => mockListCheckoutSessions(...args),
      },
    },
  }),
}))

import { handleChargeRefunded } from '../refund'

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

function refundedCharge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: 'ch_refunded',
    customer: 'cus_owner',
    payment_intent: 'pi_refunded',
    amount: 2500,
    amount_refunded: 2500,
    refunded: true,
    currency: 'usd',
    ...overrides,
  } as Stripe.Charge
}

function arrangeFullRefund(
  options: {
    historyError?: DbError
    subscriptionLookupError?: DbError
    cancellationError?: DbError
    currentProfileError?: DbError
    downgradeError?: DbError
  } = {}
) {
  mockFrom
    .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'pro' }))
    .mockImplementationOnce(() => mutationQuery(options.historyError))
    .mockImplementationOnce(() =>
      lookupQuery({ id: 'subscription-row', status: 'active' }, options.subscriptionLookupError)
    )
    .mockImplementationOnce(() => mutationQuery(options.cancellationError))
    .mockImplementationOnce(() => lookupQuery({ pro_plan: 'monthly' }, options.currentProfileError))
    .mockImplementationOnce(() => mutationQuery(options.downgradeError))
}

function arrangeLifetimeRefund(options: {
  checkoutPlan: 'lifetime' | 'monthly'
  downgradeError?: DbError
}) {
  mockListCheckoutSessions.mockResolvedValue({
    data: [{ metadata: { plan: options.checkoutPlan } }],
  })
  mockFrom
    .mockImplementationOnce(() => lookupQuery({ id: 'user-1', subscription_tier: 'pro' }))
    .mockImplementationOnce(() => mutationQuery())
    .mockImplementationOnce(() => lookupQuery(null))
    .mockImplementationOnce(() => lookupQuery({ pro_plan: 'lifetime' }))
  if (options.checkoutPlan === 'lifetime') {
    mockFrom.mockImplementationOnce(() => mutationQuery(options.downgradeError))
  }
}

describe('refund webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockLeaveProOfficialGroup.mockResolvedValue(true)
    mockListCheckoutSessions.mockResolvedValue({ data: [] })
  })

  it('throws when the refunded-charge owner lookup fails', async () => {
    mockFrom.mockReturnValue(lookupQuery(null, { message: 'owner lookup failed' }))

    await expect(handleChargeRefunded(refundedCharge())).rejects.toThrow(
      'Failed to find refunded charge owner: owner lookup failed'
    )
  })

  it.each([
    [
      'refund history upsert',
      { historyError: { message: 'history unavailable' } },
      'Failed to record refund: history unavailable',
    ],
    [
      'active-subscription lookup',
      { subscriptionLookupError: { message: 'subscription lookup failed' } },
      'Failed to find active subscription for refunded charge: subscription lookup failed',
    ],
    [
      'subscription cancellation',
      { cancellationError: { message: 'cancellation update failed' } },
      'Failed to cancel subscription after full refund: cancellation update failed',
    ],
    [
      'entitlement lookup',
      { currentProfileError: { message: 'entitlement lookup failed' } },
      'Failed to verify refunded entitlement: entitlement lookup failed',
    ],
    [
      'profile downgrade',
      { downgradeError: { message: 'downgrade update failed' } },
      'Failed to downgrade refunded user: downgrade update failed',
    ],
  ])('throws when the %s fails', async (_stage, options, expectedMessage) => {
    arrangeFullRefund(options)

    await expect(handleChargeRefunded(refundedCharge())).rejects.toThrow(expectedMessage)
  })

  it('propagates official-group persistence failure so the refund is retried', async () => {
    arrangeFullRefund()
    mockLeaveProOfficialGroup.mockRejectedValue(new Error('atomic_leave_failed'))

    await expect(handleChargeRefunded(refundedCharge())).rejects.toThrow('atomic_leave_failed')
  })

  it('preserves lifetime group access when an unrelated charge is refunded', async () => {
    arrangeLifetimeRefund({ checkoutPlan: 'monthly' })

    await expect(handleChargeRefunded(refundedCharge())).resolves.toBeUndefined()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('keeps a lifetime refund retryable when Stripe charge metadata lookup fails', async () => {
    arrangeLifetimeRefund({ checkoutPlan: 'lifetime' })
    mockListCheckoutSessions.mockRejectedValue(new Error('Stripe lookup unavailable'))

    await expect(handleChargeRefunded(refundedCharge())).rejects.toThrow(
      'Failed to identify lifetime refund: Stripe lookup unavailable'
    )
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('revokes lifetime group access only when the lifetime purchase itself is refunded', async () => {
    arrangeLifetimeRefund({ checkoutPlan: 'lifetime' })

    await expect(handleChargeRefunded(refundedCharge())).resolves.toBeUndefined()
    expect(mockLeaveProOfficialGroup).toHaveBeenCalledWith('user-1')
  })

  it('keeps the successful full-refund path intact', async () => {
    arrangeFullRefund()

    await expect(handleChargeRefunded(refundedCharge())).resolves.toBeUndefined()
    expect(mockLeaveProOfficialGroup).toHaveBeenCalledWith('user-1')
  })
})
