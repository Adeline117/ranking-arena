/** @jest-environment node */

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockDeleteUser = jest.fn()
const mockGetUserById = jest.fn()
const mockStop = jest.fn()
const mockExpire = jest.fn()
const mockPersist = jest.fn()
const mockReady = jest.fn()

const supabase = {
  from: mockFrom,
  rpc: mockRpc,
  auth: { admin: { deleteUser: mockDeleteUser, getUserById: mockGetUserById } },
}

jest.mock('@/lib/env', () => ({ env: { STRIPE_SECRET_KEY: 'sk_test_cleanup' } }))

jest.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => supabase }))
jest.mock('@/lib/stripe', () => ({ getStripe: () => ({ test: true }) }))
jest.mock('@/lib/stripe/account-deletion', () => ({
  discoverStripeSubscriptionBilling: jest.fn(),
  stopStripeSubscriptionRenewals: (...args: unknown[]) => mockStop(...args),
  expireOpenSubscriptionCheckouts: (...args: unknown[]) => mockExpire(...args),
}))
jest.mock('@/lib/stripe/account-deletion-settlement', () => ({
  persistAccountDeletionOneTimeSettlementScan: (...args: unknown[]) => mockPersist(...args),
  checkAccountDeletionOneTimeSettlementsReady: (...args: unknown[]) => mockReady(...args),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => (request: unknown) => handler(request),
}))

import { GET } from '../route'

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  original_email: 'user@example.com',
  stripe_customer_id: null,
  api_stripe_subscription_id: null,
}

function chain(result: { data?: unknown; error?: unknown }) {
  const build = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'then'
            ? (resolve: (value: unknown) => void) => resolve(result)
            : jest.fn().mockImplementation(build),
      }
    )
  return build()
}

function database(...results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  mockFrom.mockImplementation(() => {
    const result = queue.shift()
    if (!result) throw new Error('unexpected database query')
    return chain(result)
  })
}

function purgeAck() {
  return { status: 'purged', memberships_removed: 0, bans_removed: 0, owner_memberships_removed: 0 }
}

function missingAuthUser() {
  return {
    data: { user: null },
    error: { status: 404, code: 'user_not_found', message: 'User not found' },
  }
}

describe('hard deletion recovery fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockImplementation(async (name: string) => {
      const acks: Record<string, unknown> = {
        list_account_hard_deletion_candidates_atomic: [account],
        claim_account_hard_deletion_atomic: 'claimed',
        release_account_hard_deletion_atomic: 'released',
        arm_account_hard_deletion_atomic: 'armed',
        purge_deleted_account_group_edges: purgeAck(),
        finalize_account_hard_deletion_worker_atomic: 'completed',
      }
      return { data: acks[name], error: null }
    })
    mockStop.mockResolvedValue({
      customerId: null,
      observedSubscriptionIds: [],
      changedSubscriptionIds: [],
    })
    mockExpire.mockResolvedValue({
      expiredSessionIds: [],
      racedSubscriptionIds: [],
      racedOneTimeSessionIds: [],
      oneTimeSettlements: [],
    })
    mockPersist.mockResolvedValue({ scanToken: 'scan' })
    mockReady.mockResolvedValue({
      ready: true,
      pendingSessionIds: [],
      pendingLifetimeReservations: 0,
      pendingTips: 0,
    })
    mockDeleteUser.mockResolvedValue({ error: null })
    mockGetUserById
      .mockReset()
      .mockResolvedValueOnce({ data: { user: { id: account.id } }, error: null })
      .mockResolvedValue(missingAuthUser())
  })

  it('does no billing or deletion when another hard-delete worker owns the lease', async () => {
    database()
    mockRpc.mockImplementation(async (name: string) => ({
      data:
        name === 'list_account_hard_deletion_candidates_atomic'
          ? [account]
          : name === 'claim_account_hard_deletion_atomic'
            ? 'busy'
            : null,
      error: null,
    }))
    await expect(GET({} as never)).resolves.toEqual({ count: 0, total: 1 })
    expect(mockStop).not.toHaveBeenCalled()
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })

  it('releases only a pre-arm claim while settlement remains pending', async () => {
    database({ data: null, error: null })
    mockReady.mockResolvedValue({
      ready: false,
      pendingSessionIds: ['cs_1'],
      pendingLifetimeReservations: 0,
      pendingTips: 0,
    })
    await expect(GET({} as never)).resolves.toEqual({ count: 0, total: 1 })
    const names = mockRpc.mock.calls.map(([name]) => name)
    expect(names).toContain('release_account_hard_deletion_atomic')
    expect(names).not.toContain('arm_account_hard_deletion_atomic')
  })

  it('arms durably before group/Auth/profile deletion and completes afterward', async () => {
    database({ data: null, error: null }, { data: null, error: null })
    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })
    const names = mockRpc.mock.calls.map(([name]) => name)
    expect(names.indexOf('arm_account_hard_deletion_atomic')).toBeLessThan(
      names.indexOf('purge_deleted_account_group_edges')
    )
    expect(names.indexOf('purge_deleted_account_group_edges')).toBeLessThan(
      names.indexOf('finalize_account_hard_deletion_worker_atomic')
    )
    expect(mockDeleteUser).toHaveBeenCalledWith(account.id)
    expect(mockGetUserById).toHaveBeenCalledTimes(2)
    expect(names).not.toContain('release_account_hard_deletion_atomic')
  })

  it('does not report deletion when the atomic worker finalizer is not acknowledged', async () => {
    database({ data: null, error: null })
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finalize_account_hard_deletion_worker_atomic') {
        return { data: 'invalid', error: null }
      }
      const acks: Record<string, unknown> = {
        list_account_hard_deletion_candidates_atomic: [account],
        claim_account_hard_deletion_atomic: 'claimed',
        arm_account_hard_deletion_atomic: 'armed',
        purge_deleted_account_group_edges: purgeAck(),
      }
      return { data: acks[name], error: null }
    })

    await expect(GET({} as never)).rejects.toThrow('Hard deletion completion failed: invalid')
    expect(mockRpc.mock.calls.map(([name]) => name)).toContain(
      'finalize_account_hard_deletion_worker_atomic'
    )
  })

  it('keeps irreversible intent pending when deleteUser reports success but Auth still exists', async () => {
    database({ data: null, error: null })
    mockGetUserById.mockReset().mockResolvedValue({
      data: { user: { id: account.id } },
      error: null,
    })

    await expect(GET({} as never)).rejects.toThrow(
      'Auth delete was not confirmed: Auth user remains present'
    )
    expect(mockDeleteUser).toHaveBeenCalledWith(account.id)
    expect(mockGetUserById).toHaveBeenCalledTimes(2)
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'finalize_account_hard_deletion_worker_atomic'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'release_account_hard_deletion_atomic'
    )
  })

  it('continues when deleteUser reports an error but a fresh probe confirms Auth absent', async () => {
    database({ data: null, error: null }, { data: null, error: null })
    mockDeleteUser.mockResolvedValue({ error: { message: 'request timed out' } })

    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })
    expect(mockDeleteUser).toHaveBeenCalledWith(account.id)
    expect(mockGetUserById).toHaveBeenCalledTimes(2)
    expect(mockRpc.mock.calls.map(([name]) => name)).toContain(
      'finalize_account_hard_deletion_worker_atomic'
    )
  })

  it('resumes a hard-delete retry when Auth is already confirmed missing', async () => {
    database({ data: null, error: null }, { data: null, error: null })
    mockRpc.mockImplementation(async (name: string) => {
      const acks: Record<string, unknown> = {
        list_account_hard_deletion_candidates_atomic: [account],
        claim_account_hard_deletion_atomic: 'hard_delete_pending',
        purge_deleted_account_group_edges: purgeAck(),
        finalize_account_hard_deletion_worker_atomic: 'completed',
      }
      return { data: acks[name], error: null }
    })
    mockGetUserById.mockReset().mockResolvedValue(missingAuthUser())

    await expect(GET({} as never)).resolves.toEqual({ count: 1, total: 1 })
    expect(mockGetUserById).toHaveBeenCalledTimes(1)
    expect(mockDeleteUser).not.toHaveBeenCalled()
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'arm_account_hard_deletion_atomic'
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).toContain(
      'finalize_account_hard_deletion_worker_atomic'
    )
  })

  it('does not release irreversible intent after arm when purge fails', async () => {
    database({ data: null, error: null })
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'purge_deleted_account_group_edges') {
        return { data: null, error: { message: 'lock timeout' } }
      }
      const acks: Record<string, string> = {
        claim_account_hard_deletion_atomic: 'claimed',
        arm_account_hard_deletion_atomic: 'armed',
      }
      return {
        data: name === 'list_account_hard_deletion_candidates_atomic' ? [account] : acks[name],
        error: null,
      }
    })
    await expect(GET({} as never)).rejects.toThrow('Group edge purge failed: lock timeout')
    expect(mockRpc.mock.calls.map(([name]) => name)).not.toContain(
      'release_account_hard_deletion_atomic'
    )
  })
})
