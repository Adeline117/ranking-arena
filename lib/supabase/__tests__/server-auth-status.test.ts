const mockAuthGetUser = jest.fn()
const mockMaybeSingle = jest.fn()
const mockEq = jest.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockSelect = jest.fn(() => ({ eq: mockEq }))
const mockFrom = jest.fn(() => ({ select: mockSelect }))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { getUser: mockAuthGetUser },
    from: mockFrom,
  })),
}))

import {
  getActiveAppUserFromToken,
  getProvisioningUserFromToken,
  getUserFromToken,
} from '../server'

function authenticateAs(userId: string) {
  mockAuthGetUser.mockResolvedValue({
    data: { user: { id: userId, aud: 'authenticated' } },
    error: null,
  })
}

describe('server auth application-account status', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('fails closed on profile query errors and never caches the failure', async () => {
    authenticateAs('profile-error-user')
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    await expect(getUserFromToken('token')).resolves.toBeNull()
    await expect(getUserFromToken('token')).resolves.toBeNull()

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('allows a missing profile only on the provisioning helper and never caches absence', async () => {
    authenticateAs('missing-then-banned-user')
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({
      data: { banned_at: '2026-07-15T00:00:00.000Z', deleted_at: null },
      error: null,
    })

    await expect(getProvisioningUserFromToken('token')).resolves.toMatchObject({
      id: 'missing-then-banned-user',
    })
    await expect(getProvisioningUserFromToken('token')).resolves.toBeNull()

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('rejects a missing profile from the normal application helper', async () => {
    authenticateAs('strict-missing-user')
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()
    await expect(getUserFromToken('token')).resolves.toBeNull()
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('caches only an existing active profile', async () => {
    authenticateAs('active-cache-user')
    mockMaybeSingle.mockResolvedValue({
      data: { banned_at: null, deleted_at: null },
      error: null,
    })

    await expect(getActiveAppUserFromToken('token')).resolves.toMatchObject({
      id: 'active-cache-user',
    })
    await expect(getActiveAppUserFromToken('token')).resolves.toMatchObject({
      id: 'active-cache-user',
    })

    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ banned_at: '2026-07-15T00:00:00.000Z', deleted_at: null }],
    [{ banned_at: null, deleted_at: '2026-07-15T00:00:00.000Z' }],
  ])('rejects suspended profiles and never caches them', async (profile) => {
    const userId = profile.banned_at ? 'banned-user' : 'deleted-user'
    authenticateAs(userId)
    mockMaybeSingle.mockResolvedValue({ data: profile, error: null })

    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()
    await expect(getActiveAppUserFromToken('token')).resolves.toBeNull()

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the profile query throws', async () => {
    authenticateAs('throwing-profile-user')
    mockMaybeSingle.mockRejectedValue(new Error('network failure'))

    await expect(getUserFromToken('token')).resolves.toBeNull()
  })

  it('rechecks an active profile after the clean-status TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    authenticateAs('ttl-user')
    mockMaybeSingle.mockResolvedValue({
      data: { banned_at: null, deleted_at: null },
      error: null,
    })

    await getActiveAppUserFromToken('token')
    now.mockReturnValue(11_001)
    await getActiveAppUserFromToken('token')

    expect(mockMaybeSingle).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})
