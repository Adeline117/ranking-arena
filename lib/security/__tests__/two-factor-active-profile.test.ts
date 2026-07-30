const mockGetUserAccountStatus = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getUserAccountStatus: (...args: unknown[]) => mockGetUserAccountStatus(...args),
}))

import { hasActiveTwoFactorProfile } from '../two-factor-active-profile'

describe('2FA pre-release active-profile admission', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('binds admission to the freshly verified Auth identity', async () => {
    mockGetUserAccountStatus.mockResolvedValue('active')

    await expect(
      hasActiveTwoFactorProfile({ id: 'user-id', email: 'verified@example.com' })
    ).resolves.toBe(true)
    expect(mockGetUserAccountStatus).toHaveBeenCalledWith('user-id', {
      verifiedEmail: 'verified@example.com',
    })
  })

  it.each(['suspended', 'missing', 'unavailable'])('fails closed for %s', async (status) => {
    mockGetUserAccountStatus.mockResolvedValue(status)

    await expect(
      hasActiveTwoFactorProfile({ id: 'user-id', email: 'verified@example.com' })
    ).resolves.toBe(false)
  })

  it('preserves a verified null email identity', async () => {
    mockGetUserAccountStatus.mockResolvedValue('active')

    await hasActiveTwoFactorProfile({ id: 'passwordless-user', email: undefined })

    expect(mockGetUserAccountStatus).toHaveBeenCalledWith('passwordless-user', {
      verifiedEmail: null,
    })
  })
})
