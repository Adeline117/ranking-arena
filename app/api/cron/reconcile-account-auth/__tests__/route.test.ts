/** @jest-environment node */

const mockRpc = jest.fn()
const mockUpdate = jest.fn()
const mockSignOut = jest.fn()
const mockGetUser = jest.fn()
const mockDeleteUser = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => (request: unknown) => handler(request),
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    rpc: mockRpc,
    auth: {
      admin: {
        updateUserById: mockUpdate,
        signOut: mockSignOut,
        getUserById: mockGetUser,
        deleteUser: mockDeleteUser,
      },
    },
  }),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { GET } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

describe('account Auth reconciler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdate.mockResolvedValue({ error: null })
    mockSignOut.mockResolvedValue({ error: null })
    mockDeleteUser.mockResolvedValue({ error: null })
  })

  it('re-bans, globally signs out, fresh-reads Auth, and re-resolves DB authority', async () => {
    const minimum = new Date(Date.now() + 3_600_000).toISOString()
    mockRpc.mockImplementation(async (name: string) =>
      name === 'list_account_auth_reconciliation_candidates_atomic'
        ? { data: [{ user_id: USER_ID }], error: null }
        : {
            data: { state: 'banned', ban_duration: '3600s', minimum_banned_until: minimum },
            error: null,
          }
    )
    mockGetUser.mockResolvedValue({
      data: { user: { banned_until: new Date(Date.now() + 3_700_000).toISOString() } },
      error: null,
    })
    await expect(GET({} as never)).resolves.toEqual({ candidates: 1, reconciled: 1, failures: 0 })
    expect(mockUpdate).toHaveBeenCalledWith(USER_ID, { ban_duration: '3600s' })
    expect(mockSignOut).toHaveBeenCalledWith(USER_ID, 'global')
    expect(
      mockRpc.mock.calls.filter(
        ([name]) => name === 'resolve_account_auth_reconciliation_authority_atomic'
      )
    ).toHaveLength(2)
  })

  it('retries against the new authority when it changes during an Auth write', async () => {
    const minimum = new Date(Date.now() + 3_600_000).toISOString()
    const authorities = [
      { state: 'banned', ban_duration: '3600s', minimum_banned_until: minimum },
      { state: 'active' },
      { state: 'active' },
      { state: 'active' },
    ]
    mockRpc.mockImplementation(async (name: string) =>
      name === 'list_account_auth_reconciliation_candidates_atomic'
        ? { data: [{ user_id: USER_ID }], error: null }
        : { data: authorities.shift(), error: null }
    )
    mockGetUser
      .mockResolvedValueOnce({
        data: { user: { banned_until: new Date(Date.now() + 3_700_000).toISOString() } },
        error: null,
      })
      .mockResolvedValueOnce({ data: { user: { banned_until: null } }, error: null })
    await expect(GET({} as never)).resolves.toEqual({ candidates: 1, reconciled: 1, failures: 0 })
    expect(mockUpdate).toHaveBeenNthCalledWith(1, USER_ID, { ban_duration: '3600s' })
    expect(mockUpdate).toHaveBeenNthCalledWith(2, USER_ID, { ban_duration: 'none' })
  })

  it('rejects a successful Auth write whose ban is shorter than the DB minimum', async () => {
    const minimum = new Date(Date.now() + 3_600_000).toISOString()
    mockRpc.mockImplementation(async (name: string) =>
      name === 'list_account_auth_reconciliation_candidates_atomic'
        ? { data: [{ user_id: USER_ID }], error: null }
        : {
            data: { state: 'banned', ban_duration: '3600s', minimum_banned_until: minimum },
            error: null,
          }
    )
    mockGetUser.mockResolvedValue({
      data: { user: { banned_until: new Date(Date.now() + 60_000).toISOString() } },
      error: null,
    })
    await expect(GET({} as never)).rejects.toThrow('Auth reconciliation failed for 1/1')
  })

  it('does not accept even a sub-second shortfall from the exact DB ban deadline', async () => {
    const minimumMs = Date.now() + 3_600_000
    const minimum = new Date(minimumMs).toISOString()
    mockRpc.mockImplementation(async (name: string) =>
      name === 'list_account_auth_reconciliation_candidates_atomic'
        ? { data: [{ user_id: USER_ID }], error: null }
        : {
            data: { state: 'banned', ban_duration: '876000h', minimum_banned_until: minimum },
            error: null,
          }
    )
    mockGetUser.mockResolvedValue({
      data: { user: { banned_until: new Date(minimumMs - 1).toISOString() } },
      error: null,
    })

    await expect(GET({} as never)).rejects.toThrow('Auth reconciliation failed for 1/1')
  })

  it('isolates one failed candidate and still reconciles the next candidate', async () => {
    const second = '22222222-2222-4222-8222-222222222222'
    mockRpc.mockImplementation(async (name: string, args: { p_user_id?: string }) => {
      if (name === 'list_account_auth_reconciliation_candidates_atomic') {
        return { data: [{ user_id: USER_ID }, { user_id: second }], error: null }
      }
      return args.p_user_id === USER_ID
        ? { data: null, error: { message: 'bad first candidate' } }
        : { data: { state: 'active' }, error: null }
    })
    mockGetUser.mockResolvedValue({ data: { user: { banned_until: null } }, error: null })
    await expect(GET({} as never)).rejects.toThrow('Auth reconciliation failed for 1/2')
    expect(mockUpdate).toHaveBeenCalledWith(second, { ban_duration: 'none' })
  })

  it('fails closed on a malformed fresh Auth ban timestamp', async () => {
    mockRpc.mockImplementation(async (name: string) =>
      name === 'list_account_auth_reconciliation_candidates_atomic'
        ? { data: [{ user_id: USER_ID }], error: null }
        : { data: { state: 'active' }, error: null }
    )
    mockGetUser.mockResolvedValue({ data: { user: { banned_until: 'not-a-date' } }, error: null })
    await expect(GET({} as never)).rejects.toThrow('Auth reconciliation failed for 1/1')
  })

  it('deletes and fresh-verifies an orphan Auth user under exact absent-delete authority', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'list_account_auth_reconciliation_candidates_atomic') {
        return { data: [{ user_id: USER_ID }], error: null }
      }
      if (name === 'finalize_account_hard_deletion_takeover_atomic') {
        return { data: 'completed', error: null }
      }
      return {
        data: { state: 'delete_absent', hard_delete_takeover_required: true },
        error: null,
      }
    })
    mockGetUser
      .mockResolvedValueOnce({ data: { user: { id: USER_ID } }, error: null })
      .mockResolvedValueOnce({
        data: { user: null },
        error: { status: 404, code: 'user_not_found', message: 'User not found' },
      })
    await expect(GET({} as never)).resolves.toEqual({
      candidates: 1,
      reconciled: 1,
      failures: 0,
    })
    expect(mockDeleteUser).toHaveBeenCalledWith(USER_ID)
    expect(mockRpc).toHaveBeenCalledWith('finalize_account_hard_deletion_takeover_atomic', {
      p_user_id: USER_ID,
    })
  })

  it('does not settle an absent Auth candidate when takeover finalization is rejected', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'list_account_auth_reconciliation_candidates_atomic') {
        return { data: [{ user_id: USER_ID }], error: null }
      }
      if (name === 'finalize_account_hard_deletion_takeover_atomic') {
        return { data: 'invalid', error: null }
      }
      return {
        data: { state: 'delete_absent', hard_delete_takeover_required: true },
        error: null,
      }
    })
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { status: 404, code: 'user_not_found', message: 'User not found' },
    })

    await expect(GET({} as never)).rejects.toThrow('Hard deletion takeover finalization failed')
  })

  it('does not delete Auth when a missing profile has only manual authority', async () => {
    mockRpc.mockImplementation(async (name: string) =>
      name === 'list_account_auth_reconciliation_candidates_atomic'
        ? { data: [{ user_id: USER_ID }], error: null }
        : { data: { state: 'manual' }, error: null }
    )
    await expect(GET({} as never)).rejects.toThrow('Auth reconciliation failed for 1/1')
    expect(mockDeleteUser).not.toHaveBeenCalled()
  })
})
