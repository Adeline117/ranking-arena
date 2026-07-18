import type Stripe from 'stripe'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockLeaveProOfficialGroup = jest.fn()

jest.mock('../shared', () => ({
  getSupabase: () => ({ from: mockFrom, rpc: mockRpc }),
  withRetry: (operation: () => unknown) => operation(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/lib/stripe', () => ({
  SUBSCRIPTION_STATUS_MAP: { active: 'active', canceled: 'canceled', trialing: 'trialing' },
  STRIPE_API_PRICE_IDS: { starter: 'price_api_starter', pro: 'price_api_pro' },
  API_TIER_LIMITS: { free: 100, starter: 10_000, pro: 0 },
  STRIPE_PRICE_IDS: {
    monthly: 'price_pro_monthly',
    yearly: 'price_pro_yearly',
    lifetime: 'price_pro_lifetime',
  },
}))

jest.mock('@/lib/env', () => ({
  env: { STRIPE_PRO_YEARLY_PRICE_ID: 'price_pro_yearly' },
}))

jest.mock('@/app/api/pro-official-group/route', () => ({
  leaveProOfficialGroup: (...args: unknown[]) => mockLeaveProOfficialGroup(...args),
}))

jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))
jest.mock('@/lib/notifications/telegram', () => ({
  sendTelegramAlert: jest.fn().mockResolvedValue(undefined),
}))

import { handleSubscriptionCanceled, handleSubscriptionUpdate } from '../subscription'

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
    update: jest.Mock
    eq: jest.Mock
    then: Promise<typeof result>['then']
  } = {
    update: jest.fn(),
    eq: jest.fn(),
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  }
  query.update.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_current',
    customer: 'cus_owner',
    status: 'active',
    start_date: 1_700_000_000,
    cancel_at_period_end: false,
    items: {
      data: [{ price: { id: 'price_pro_monthly' } }],
    },
    ...overrides,
  } as Stripe.Subscription
}

function arrangeRegularCancellation(
  options: {
    subscriptionUpdateError?: DbError
    currentSubscriptionError?: DbError
    currentProfileError?: DbError
    profileDowngradeError?: DbError
  } = {}
) {
  mockFrom
    .mockImplementationOnce(() => lookupQuery({ id: 'user-1' }))
    .mockImplementationOnce(() => mutationQuery(options.subscriptionUpdateError))
    .mockImplementationOnce(() =>
      lookupQuery(
        { stripe_subscription_id: 'sub_current', status: 'canceled' },
        options.currentSubscriptionError
      )
    )
    .mockImplementationOnce(() => lookupQuery({ pro_plan: 'monthly' }, options.currentProfileError))
    .mockImplementationOnce(() => mutationQuery(options.profileDowngradeError))
}

describe('subscription webhook persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReset()
    mockRpc.mockResolvedValue({ data: true, error: null })
    mockLeaveProOfficialGroup.mockResolvedValue(true)
  })

  it('throws when the subscription owner lookup fails', async () => {
    mockFrom.mockReturnValue(
      lookupQuery(null, { message: 'user_profiles temporarily unavailable' })
    )

    await expect(handleSubscriptionUpdate(subscription())).rejects.toThrow(
      'Failed to find subscription owner: user_profiles temporarily unavailable'
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps the successful subscription update path intact', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery({ id: 'user-1' }))

    await expect(handleSubscriptionUpdate(subscription())).resolves.toBeUndefined()
    expect(mockRpc).toHaveBeenCalledWith(
      'update_subscription_and_profile',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_stripe_sub_id: 'sub_current',
        p_tier: 'pro',
      })
    )
  })

  it('keeps an unknown paid price retryable without granting Pro', async () => {
    mockFrom.mockReturnValueOnce(lookupQuery({ id: 'user-1' }))

    await expect(
      handleSubscriptionUpdate(
        subscription({
          items: {
            data: [{ price: { id: 'price_unconfigured' } }],
          } as Stripe.ApiList<Stripe.SubscriptionItem>,
        })
      )
    ).rejects.toThrow('Cannot map Stripe price price_unconfigured to a Pro plan')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    [
      'subscription cancellation record',
      { subscriptionUpdateError: { message: 'subscriptions update failed' } },
      'Failed to cancel subscription record: subscriptions update failed',
    ],
    [
      'current-subscription safety lookup',
      { currentSubscriptionError: { message: 'current subscription lookup failed' } },
      'Failed to verify current subscription before downgrade: current subscription lookup failed',
    ],
    [
      'lifetime entitlement safety lookup',
      { currentProfileError: { message: 'lifetime lookup failed' } },
      'Failed to verify lifetime entitlement: lifetime lookup failed',
    ],
    [
      'profile downgrade',
      { profileDowngradeError: { message: 'profile downgrade failed' } },
      'Failed to downgrade user tier: profile downgrade failed',
    ],
  ])('throws when the %s fails', async (_stage, options, expectedMessage) => {
    arrangeRegularCancellation(options)

    await expect(handleSubscriptionCanceled(subscription())).rejects.toThrow(expectedMessage)
  })

  it('throws when the canceled-subscription owner lookup fails', async () => {
    mockFrom.mockReturnValue(
      lookupQuery(null, { message: 'canceled owner lookup temporarily failed' })
    )

    await expect(handleSubscriptionCanceled(subscription())).rejects.toThrow(
      'Failed to find canceled subscription owner: canceled owner lookup temporarily failed'
    )
  })

  it('propagates official-group persistence failure so cancellation is retried', async () => {
    arrangeRegularCancellation()
    mockLeaveProOfficialGroup.mockRejectedValue(new Error('atomic_leave_failed'))

    await expect(handleSubscriptionCanceled(subscription())).rejects.toThrow('atomic_leave_failed')
  })

  it('does not remove official-group access for a late cancellation of an older subscription', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() =>
        lookupQuery({ stripe_subscription_id: 'sub_newer', status: 'active' })
      )

    await expect(handleSubscriptionCanceled(subscription())).resolves.toBeUndefined()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('does not remove lifetime official-group access when a subscription is canceled', async () => {
    mockFrom
      .mockImplementationOnce(() => lookupQuery({ id: 'user-1' }))
      .mockImplementationOnce(() => mutationQuery())
      .mockImplementationOnce(() =>
        lookupQuery({ stripe_subscription_id: 'sub_current', status: 'canceled' })
      )
      .mockImplementationOnce(() => lookupQuery({ pro_plan: 'lifetime' }))

    await expect(handleSubscriptionCanceled(subscription())).resolves.toBeUndefined()
    expect(mockLeaveProOfficialGroup).not.toHaveBeenCalled()
  })

  it('keeps the successful cancellation path intact', async () => {
    arrangeRegularCancellation()

    await expect(handleSubscriptionCanceled(subscription())).resolves.toBeUndefined()
    expect(mockLeaveProOfficialGroup).toHaveBeenCalledWith('user-1')
  })
})
