/** @jest-environment node */

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockDeleteUser = jest.fn()
const mockCancelSubscription = jest.fn()

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
  getStripe: () => ({
    subscriptions: { cancel: mockCancelSubscription },
  }),
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
    mockCancelSubscription.mockResolvedValue({ id: 'sub_recurring', status: 'canceled' })
    mockDeleteUser.mockResolvedValue({ error: null })
  })

  it('cancels recurring billing, purges group edges, then deletes Auth and profile', async () => {
    queueDatabaseResults(
      {
        data: [{ id: 'user-expired', original_email: 'deleted@example.com' }],
        error: null,
      },
      {
        data: {
          stripe_subscription_id: 'sub_recurring',
          status: 'active',
          plan: 'monthly',
        },
        error: null,
      },
      { data: null, error: null }
    )
    mockRpc.mockResolvedValue({ data: purgedResult(), error: null })

    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })

    expect(mockCancelSubscription).toHaveBeenCalledWith('sub_recurring')
    expect(mockRpc).toHaveBeenCalledWith('purge_deleted_account_group_edges', {
      p_user_id: 'user-expired',
    })
    expect(mockDeleteUser).toHaveBeenCalledWith('user-expired')
    expect(mockCancelSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[0]
    )
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUser.mock.invocationCallOrder[0]
    )
  })

  it('purges lifetime-account edges without calling Stripe cancellation', async () => {
    queueDatabaseResults(
      { data: [{ id: 'user-lifetime', original_email: null }], error: null },
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

    expect(mockCancelSubscription).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockDeleteUser).toHaveBeenCalledTimes(1)
  })

  it('fails closed before Auth deletion when the group purge RPC errors', async () => {
    queueDatabaseResults(
      { data: [{ id: 'user-expired', original_email: null }], error: null },
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
      { data: [{ id: 'user-expired', original_email: null }], error: null },
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
