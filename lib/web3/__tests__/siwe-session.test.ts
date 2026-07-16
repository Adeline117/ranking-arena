import type { Session, User } from '@supabase/supabase-js'
import {
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
} from '@/lib/auth/session-operation'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const mockVerifyOtp = jest.fn()
const mockSignOut = jest.fn()
const mockSignOutIfCurrent = jest.fn()
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
    signOut: (...args: unknown[]) => mockSignOut(...args),
    signOutIfCurrent: (...args: unknown[]) => mockSignOutIfCurrent(...args),
  },
}))

const mockGetUser = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockMaybeSingle = jest.fn()
const query = {
  select: mockSelect,
  eq: mockEq,
  maybeSingle: mockMaybeSingle,
}

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

import {
  establishRequiredSiweSession,
  parseSiweAuthResult,
  SiweSessionCompletionError,
} from '../siwe-session'

const USER_ID = 'user-1'
const EMAIL = 'wallet@wallet.arena'
const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'

function session(userId = USER_ID): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: userId, email: EMAIL } as User,
  }
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    action: 'existing_user',
    userId: USER_ID,
    handle: 'wallet-user',
    walletAddress: WALLET_ADDRESS,
    verificationToken: 'verification-token',
    email: EMAIL,
    ...overrides,
  }
}

function complete(
  value: unknown,
  options: { signal?: AbortSignal; isCurrent?: () => boolean; expectedWalletAddress?: string } = {}
) {
  return establishRequiredSiweSession(value, {
    expectedWalletAddress: options.expectedWalletAddress ?? WALLET_ADDRESS,
    signal: options.signal,
    isCurrent: options.isCurrent,
  })
}

describe('SIWE session completion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    synchronizeViewerScope(true, USER_ID)

    const activeSession = session()
    const user = { id: USER_ID, email: EMAIL } as User
    mockVerifyOtp.mockResolvedValue({
      data: { session: activeSession, user },
      error: null,
    })
    mockSignOut.mockResolvedValue(undefined)
    mockSignOutIfCurrent.mockResolvedValue(true)
    mockGetUser.mockResolvedValue({ data: { user }, error: null })
    mockFrom.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockMaybeSingle.mockResolvedValue({
      data: { handle: 'wallet-user', avatar_url: null },
      error: null,
    })
  })

  it.each([
    [null, 'non-object response'],
    [result({ verificationToken: undefined }), 'missing token'],
    [result({ email: '' }), 'missing email'],
    [result({ userId: '' }), 'missing user id'],
    [result({ action: 'unknown' }), 'unknown action'],
    [result({ handle: 42 }), 'invalid handle'],
  ])('rejects an untrusted response before OTP exchange (%s: %s)', async (value) => {
    expect(() => parseSiweAuthResult(value)).toThrow(SiweSessionCompletionError)
    await expect(complete(value)).rejects.toThrow(SiweSessionCompletionError)
    expect(mockVerifyOtp).not.toHaveBeenCalled()
  })

  it('requires token and email and binds OTP exchange to the expected user id', async () => {
    await complete(result())

    expect(mockVerifyOtp).toHaveBeenCalledWith(
      {
        email: EMAIL,
        token: 'verification-token',
        type: 'email',
      },
      USER_ID
    )
  })

  it('rejects a server wallet identity that is not equivalent to the signed address', async () => {
    await expect(
      complete(result({ walletAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' }))
    ).rejects.toThrow('Wallet verification identity changed')
    expect(mockVerifyOtp).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
  })

  it.each([
    [{ data: { session: null, user: null }, error: new Error('invalid OTP') }, 'OTP error'],
    [{ data: { session: null, user: { id: USER_ID } }, error: null }, 'missing session'],
    [{ data: { session: session(), user: null }, error: null }, 'missing user'],
    [
      { data: { session: session('other-user'), user: { id: USER_ID } }, error: null },
      'session subject mismatch',
    ],
    [
      { data: { session: session(), user: { id: 'other-user' } }, error: null },
      'verified user mismatch',
    ],
  ])('does not accept an incomplete or mismatched OTP result (%s: %s)', async (otpResult) => {
    mockVerifyOtp.mockResolvedValue(otpResult)

    await expect(complete(result())).rejects.toThrow(SiweSessionCompletionError)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
  })

  it('verifies the exact access token before reading the profile', async () => {
    await complete(result())

    expect(mockGetUser).toHaveBeenCalledWith('access-user-1')
    expect(mockGetUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockFrom.mock.invocationCallOrder[0]
    )
  })

  it('rejects a token whose verified subject differs from the SIWE identity', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'other-user', email: EMAIL } },
      error: null,
    })

    await expect(complete(result())).rejects.toThrow('Authentication identity changed')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith(USER_ID, 'access-user-1')
  })

  it.each([
    [{ data: null, error: null }, 'missing profile'],
    [{ data: null, error: new Error('profile read failed') }, 'profile read error'],
  ])('requires the trigger-provisioned profile (%s: %s)', async (profileResult) => {
    mockMaybeSingle.mockResolvedValue(profileResult)

    await expect(complete(result())).rejects.toThrow()
    expect(mockEq).toHaveBeenCalledWith('id', USER_ID)
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith(USER_ID, 'access-user-1')
  })

  it('rolls back a cancelled completion when the SIWE user still owns the viewer', async () => {
    const controller = new AbortController()
    let resolveProfile!: (value: unknown) => void
    mockMaybeSingle.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve
      })
    )

    const completion = complete(result(), { signal: controller.signal })
    while (!mockMaybeSingle.mock.calls.length) await Promise.resolve()
    controller.abort()
    resolveProfile({ data: { handle: 'wallet-user', avatar_url: null }, error: null })

    await expect(completion).rejects.toThrow('cancelled')
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith(USER_ID, 'access-user-1')
  })

  it('rejects a profile completion superseded by an account switch', async () => {
    let resolveProfile!: (value: unknown) => void
    mockMaybeSingle.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve
      })
    )

    const completion = complete(result())
    await Promise.resolve()
    await Promise.resolve()

    beginAuthIdentityOperation('user-2')
    synchronizeViewerScope(true, 'user-2')
    resolveProfile({ data: { handle: 'wallet-user', avatar_url: null }, error: null })

    await expect(completion).rejects.toThrow('Authentication operation was superseded')
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
  })

  it('returns the exact verified snapshot and required profile on success', async () => {
    const completed = await complete(result())

    expect(completed.snapshot.user.id).toBe(USER_ID)
    expect(completed.snapshot.session.user.id).toBe(USER_ID)
    expect(completed.profile).toEqual({ handle: 'wallet-user', avatar_url: null })
  })
})
