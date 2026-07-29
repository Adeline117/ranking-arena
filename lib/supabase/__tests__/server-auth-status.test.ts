const mockAuthGetUser = jest.fn()
const mockRpc = jest.fn()
const mockMaybeSingle = jest.fn()
const mockEq = jest.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockSelect = jest.fn(() => ({ eq: mockEq }))
const mockFrom = jest.fn(() => ({ select: mockSelect }))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { getUser: mockAuthGetUser },
    rpc: mockRpc,
    from: mockFrom,
  })),
}))

import {
  getActiveAppUserFromToken,
  getProvisioningUserFromToken,
  getUserAccountStatus,
  getUserFromToken,
} from '../server'

function authenticateAs(userId: string) {
  mockAuthGetUser.mockResolvedValue({
    data: { user: { id: userId, email: `${userId}@example.com`, aud: 'authenticated' } },
    error: null,
  })
}

describe('server auth application-account status', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('fails closed on profile query errors and never caches the failure', async () => {
    authenticateAs('profile-error-user')
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(getUserFromToken('token')).resolves.toBeNull()
    await expect(getUserFromToken('token')).resolves.toBeNull()

    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('allows a missing profile only on the provisioning helper and never caches absence', async () => {
    authenticateAs('missing-then-banned-user')
    mockRpc
      .mockResolvedValueOnce({ data: 'missing', error: null })
      .mockResolvedValueOnce({ data: 'suspended', error: null })

    await expect(getProvisioningUserFromToken('token')).resolves.toMatchObject({
      id: 'missing-then-banned-user',
    })
    await expect(getProvisioningUserFromToken('token')).resolves.toBeNull()

    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('rejects a missing profile from the normal application helper', async () => {
    authenticateAs('strict-missing-user')
    mockRpc.mockResolvedValue({ data: 'missing', error: null })

    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()
    await expect(getUserFromToken('token')).resolves.toBeNull()
    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('rechecks an active profile on every request and observes a remote deletion immediately', async () => {
    authenticateAs('cross-instance-deletion-user')
    mockRpc
      .mockResolvedValueOnce({ data: 'active', error: null })
      .mockResolvedValueOnce({ data: 'suspended', error: null })

    await expect(getActiveAppUserFromToken('token')).resolves.toMatchObject({
      id: 'cross-instance-deletion-user',
    })
    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()

    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenLastCalledWith('admit_verified_auth_profile_atomic', {
      p_user_id: 'cross-instance-deletion-user',
      p_verified_email: 'cross-instance-deletion-user@example.com',
    })
  })

  it.each([
    [{ banned_at: '2026-07-15T00:00:00.000Z', deleted_at: null }],
    [{ banned_at: null, deleted_at: '2026-07-15T00:00:00.000Z' }],
  ])('rejects suspended profiles and never caches them', async (profile) => {
    const userId = profile.banned_at ? 'banned-user' : 'deleted-user'
    authenticateAs(userId)
    mockRpc.mockResolvedValue({ data: 'suspended', error: null })

    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()
    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()

    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('fails closed when verified profile admission throws', async () => {
    authenticateAs('throwing-profile-user')
    mockRpc.mockRejectedValue(new Error('network failure'))

    await expect(getUserFromToken('token')).resolves.toBeNull()
  })

  it('bypasses a clean cache when Auth reports a newly confirmed email', async () => {
    authenticateAs('email-change-user')
    mockRpc.mockResolvedValue({ data: 'active', error: null })

    await expect(getActiveAppUserFromToken('old-email-token')).resolves.toMatchObject({
      id: 'email-change-user',
    })
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'email-change-user',
          email: 'confirmed-new@example.com',
          aud: 'authenticated',
        },
      },
      error: null,
    })
    await expect(getActiveAppUserFromToken('new-email-token')).resolves.toMatchObject({
      id: 'email-change-user',
    })

    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenLastCalledWith('admit_verified_auth_profile_atomic', {
      p_user_id: 'email-change-user',
      p_verified_email: 'confirmed-new@example.com',
    })
  })

  it.each(['unavailable', 'wrong-shape', null])(
    'fails closed on an invalid verified profile acknowledgement: %s',
    async (ack) => {
      authenticateAs(`invalid-ack-${String(ack)}`)
      mockRpc.mockResolvedValue({ data: ack, error: null })

      await expect(getUserFromToken('token')).resolves.toBeNull()
    }
  )

  it.each([
    ['permanent legacy ban', null],
    ['unexpired legacy ban', '2999-01-01T00:00:00.000Z'],
    ['malformed legacy ban expiry', 'not-a-timestamp'],
  ])('fails the direct status fallback closed for %s', async (_label, banExpiresAt) => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        banned_at: null,
        ban_expires_at: banExpiresAt,
        deleted_at: null,
        email: 'legacy-ban@example.com',
        is_banned: true,
      },
      error: null,
    })

    await expect(getUserAccountStatus('direct-legacy-ban')).resolves.toBe('suspended')
  })

  it('allows the direct status fallback after a legacy temporary ban expires', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        banned_at: null,
        ban_expires_at: '2000-01-01T00:00:00.000Z',
        deleted_at: null,
        email: 'expired-ban@example.com',
        is_banned: true,
      },
      error: null,
    })

    await expect(getUserAccountStatus('direct-expired-ban')).resolves.toBe('active')
  })
})
