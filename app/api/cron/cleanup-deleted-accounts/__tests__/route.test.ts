/** @jest-environment node */

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockDeleteUser = jest.fn()
const mockStopStripeSubscriptionRenewals = jest.fn()
const mockExpireOpenSubscriptionCheckouts = jest.fn()
const mockStripeClient = { marker: 'stripe-client' }

const mockSupabase = {
  from: mockFrom,
  rpc: mockRpc,
  auth: {
    admin: {
      deleteUser: mockDeleteUser,
    },
  },
}

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockSupabase,
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: () => mockStripeClient,
}))

jest.mock('@/lib/stripe/account-deletion', () => ({
  stopStripeSubscriptionRenewals: (...args: unknown[]) =>
    mockStopStripeSubscriptionRenewals(...args),
  expireOpenSubscriptionCheckouts: (...args: unknown[]) =>
    mockExpireOpenSubscriptionCheckouts(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => handler(request),
}))

import { GET } from '../route'

function chainable(result: { data?: unknown; error?: unknown }) {
  const handler = (): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return (resolve: (value: unknown) => void) => resolve(result)
          return jest.fn().mockImplementation(handler)
        },
      }
    )
  return handler()
}

function queueDatabaseResults(...results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  mockFrom.mockImplementation(() => {
    const result = queue.shift()
    if (!result) throw new Error('Unexpected database query')
    return chainable(result)
  })
}

function purgedResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'purged',
    memberships_removed: 2,
    bans_removed: 1,
    owner_memberships_removed: 1,
    ...overrides,
  }
}

describe('GET /api/cron/cleanup-deleted-accounts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api', 'sub_recurring'],
      changedSubscriptionIds: ['sub_recurring', 'sub_api'],
    })
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: ['cs_api_open'],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
    })
    mockDeleteUser.mockResolvedValue({ error: null })
  })

  it('closes consumer, API, and open Checkout billing then defers hard deletion', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-expired',
            original_email: 'deleted@example.com',
            stripe_customer_id: 'cus_owner',
            api_stripe_subscription_id: 'sub_api',
          },
        ],
        error: null,
      },
      {
        data: {
          stripe_subscription_id: 'sub_recurring',
          status: 'active',
          plan: 'monthly',
        },
        error: null,
      }
    )

    await expect(GET({} as never)).resolves.toEqual({ count: 0, total: 1 })

    expect(mockExpireOpenSubscriptionCheckouts).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      customerId: 'cus_owner',
    })
    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith({
      stripeClient: mockStripeClient,
      subscriptionIds: ['sub_recurring', 'sub_api'],
      expectedCustomerId: 'cus_owner',
      deletionMode: 'permanent',
    })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts.mock.invocationCallOrder[0]).toBeLessThan(
      mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]
    )
  })

  it('purges lifetime-account edges without calling Stripe cancellation', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-lifetime',
            original_email: null,
            stripe_customer_id: null,
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      {
        data: {
          stripe_subscription_id: 'lifetime_user-lifetime',
          status: 'active',
          plan: 'lifetime',
        },
        error: null,
      },
      { data: null, error: null }
    )
    mockRpc.mockResolvedValue({
      data: purgedResult({
        memberships_removed: 0,
        bans_removed: 0,
        owner_memberships_removed: 0,
      }),
      error: null,
    })

    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })

    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockExpireOpenSubscriptionCheckouts).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockDeleteUser).toHaveBeenCalledTimes(1)
  })

  it('cancels an API-only subscription before hard deletion', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-api',
            original_email: null,
            stripe_customer_id: 'cus_owner',
            api_stripe_subscription_id: 'sub_api',
          },
        ],
        error: null,
      },
      { data: null, error: null }
    )
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_api'],
      changedSubscriptionIds: ['sub_api'],
    })

    await expect(GET({} as never)).resolves.toEqual({ count: 0, total: 1 })

    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: [null, 'sub_api'],
        deletionMode: 'permanent',
      })
    )
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('hard-deletes on a later pass only after billing links and remote work converge', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-converged',
            original_email: null,
            stripe_customer_id: 'cus_owner',
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null }
    )
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: [],
      changedSubscriptionIds: [],
    })
    mockRpc.mockResolvedValue({ data: purgedResult(), error: null })

    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })

    expect(mockRpc).toHaveBeenCalledWith('purge_deleted_account_group_edges', {
      p_user_id: 'user-converged',
    })
    expect(mockDeleteUser).toHaveBeenCalledWith('user-converged')
    expect(mockStopStripeSubscriptionRenewals.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[0]
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUser.mock.invocationCallOrder[0]
    )
  })

  it('fails closed before purge/Auth deletion when an open Checkout remains payable', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-expired',
            original_email: null,
            stripe_customer_id: 'cus_owner',
            api_stripe_subscription_id: 'sub_api',
          },
        ],
        error: null,
      },
      { data: null, error: null }
    )
    mockExpireOpenSubscriptionCheckouts.mockRejectedValue(new Error('Checkout remains payable'))

    await expect(GET({} as never)).rejects.toThrow('Checkout remains payable')

    expect(mockStopStripeSubscriptionRenewals).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('immediately cancels a subscription that completes while hard cleanup expires Checkout', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-raced',
            original_email: null,
            stripe_customer_id: 'cus_owner',
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      { data: null, error: null }
    )
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: ['sub_checkout_race'],
      racedOneTimeSessionIds: [],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: ['sub_checkout_race'],
      changedSubscriptionIds: ['sub_checkout_race'],
    })

    await expect(GET({} as never)).resolves.toEqual({ count: 0, total: 1 })

    expect(mockStopStripeSubscriptionRenewals).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionIds: [null, null, 'sub_checkout_race'],
        deletionMode: 'permanent',
      })
    )
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('defers hard deletion when a one-time Checkout completes during expiry', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-payment-raced',
            original_email: null,
            stripe_customer_id: 'cus_owner',
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      { data: null, error: null }
    )
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: ['cs_tip_race'],
    })
    mockStopStripeSubscriptionRenewals.mockResolvedValue({
      customerId: 'cus_owner',
      observedSubscriptionIds: [],
      changedSubscriptionIds: [],
    })

    await expect(GET({} as never)).resolves.toEqual({ count: 0, total: 1 })

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('leaves the account pending and succeeds on retry after remote cancellation recovers', async () => {
    const linkedAccount = {
      id: 'user-retry',
      original_email: null,
      stripe_customer_id: 'cus_owner',
      api_stripe_subscription_id: 'sub_api',
    }
    queueDatabaseResults({ data: [linkedAccount], error: null }, { data: null, error: null })
    mockStopStripeSubscriptionRenewals.mockRejectedValueOnce(new Error('Stripe unavailable'))

    await expect(GET({} as never)).rejects.toThrow('Stripe unavailable')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()

    queueDatabaseResults(
      {
        data: [
          {
            ...linkedAccount,
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null }
    )
    mockStopStripeSubscriptionRenewals.mockResolvedValueOnce({
      customerId: 'cus_owner',
      observedSubscriptionIds: [],
      changedSubscriptionIds: [],
    })
    mockExpireOpenSubscriptionCheckouts.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
    })
    mockRpc.mockResolvedValueOnce({ data: purgedResult(), error: null })

    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })
    expect(mockDeleteUser).toHaveBeenCalledWith('user-retry')
  })

  it('fails closed before Auth deletion when the group purge RPC errors', async () => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-expired',
            original_email: null,
            stripe_customer_id: null,
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      { data: null, error: null }
    )
    mockRpc.mockResolvedValue({ data: null, error: { message: 'lock timeout' } })

    await expect(GET({} as never)).rejects.toThrow('Group edge purge failed: lock timeout')

    expect(mockDeleteUser).not.toHaveBeenCalled()
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it.each([
    null,
    { status: 'grace_period_active' },
    purgedResult({ memberships_removed: -1 }),
    purgedResult({ bans_removed: 1.5 }),
    purgedResult({ owner_memberships_removed: 3 }),
  ])('rejects an incomplete or invalid purge result before Auth deletion', async (data) => {
    queueDatabaseResults(
      {
        data: [
          {
            id: 'user-expired',
            original_email: null,
            stripe_customer_id: null,
            api_stripe_subscription_id: null,
          },
        ],
        error: null,
      },
      { data: null, error: null }
    )
    mockRpc.mockResolvedValue({ data, error: null })

    await expect(GET({} as never)).rejects.toThrow(
      'Group edge purge returned an invalid or incomplete result'
    )
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('does not call the purge boundary when there are no expired accounts', async () => {
    queueDatabaseResults({ data: [], error: null })

    await expect(GET({} as never)).resolves.toEqual({
      count: 0,
      message: 'No accounts to cleanup',
    })

    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })
})
