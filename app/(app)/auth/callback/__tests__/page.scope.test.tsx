import { act, render, waitFor } from '@testing-library/react'
import type { Session, User } from '@supabase/supabase-js'
import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  getAuthRedirectAcquisitionReceipt,
  getCurrentAuthOperation,
  guardedAuthStorage,
  withAuthSessionWriter,
} from '@/lib/auth/session-operation'
import { __resetViewerScopeForTests, synchronizeViewerScope } from '@/lib/auth/viewer-scope'

const mockReplace = jest.fn()
let mockSearchParams = new URLSearchParams()
const mockGetSession = jest.fn()
const mockGetUser = jest.fn()
const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockUpdate = jest.fn()
const mockEq = jest.fn()
const mockMaybeSingle = jest.fn()
const mockSignOutIfCurrent = jest.fn()
const mockAddAccount = jest.fn()
const mockStore = { accounts: [] as Array<{ isActive: boolean }>, addAccount: mockAddAccount }

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: {
    signOutIfCurrent: (...args: unknown[]) => mockSignOutIfCurrent(...args),
  },
}))

jest.mock('@/lib/stores/multiAccountStore', () => ({
  useMultiAccountStore: { getState: () => mockStore },
}))

jest.mock('@/app/components/Providers/LanguageProvider', () => ({
  useLanguage: () => ({ t: (key: string) => key, language: 'en' }),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import AuthCallbackPage from '../page'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function user(userId: string, overrides: Partial<User> = {}): User {
  return {
    id: userId,
    email: `${userId}@example.com`,
    aud: 'authenticated',
    role: 'authenticated',
    created_at: '2025-01-01T00:00:00.000Z',
    app_metadata: {},
    user_metadata: {},
    ...overrides,
  } as User
}

function session(userId: string, userOverrides: Partial<User> = {}): Session {
  return {
    access_token: `access-${userId}`,
    refresh_token: `refresh-${userId}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: user(userId, userOverrides),
  }
}

function profile(userId: string) {
  return {
    id: userId,
    handle: `handle-${userId}`,
    avatar_url: null,
    onboarding_completed: true,
  }
}

describe('OAuth callback identity ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    mockStore.accounts = []
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
    __resetAuthOperationsForTests()
    __resetViewerScopeForTests()
    synchronizeViewerScope(true, 'user-a')

    const builder = {
      select: mockSelect,
      update: mockUpdate,
      eq: mockEq,
      maybeSingle: mockMaybeSingle,
    }
    mockFrom.mockReturnValue(builder)
    mockSelect.mockReturnValue(builder)
    mockUpdate.mockReturnValue(builder)
    mockEq.mockReturnValue(builder)
  })

  it('commits one verified token/user/profile identity to the add-account store', async () => {
    mockSearchParams = new URLSearchParams('addAccount=true')
    const capturedSession = session('user-a', { email: 'captured@example.com' })
    const verifiedUser = user('user-a', { email: 'verified@example.com' })
    mockGetSession.mockResolvedValue({ data: { session: capturedSession }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: verifiedUser }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: profile('user-a'), error: null })

    render(<AuthCallbackPage />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(mockGetUser).toHaveBeenCalledWith('access-user-a')
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockSelect).toHaveBeenCalledWith('id, handle, avatar_url, onboarding_completed')
    expect(mockEq).toHaveBeenCalledWith('id', 'user-a')
    expect(mockAddAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        email: 'verified@example.com',
        handle: 'handle-user-a',
        refreshToken: 'refresh-user-a',
        isActive: true,
      })
    )
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
  })

  it('does not let an old A callback adopt B returned by a delayed initial session read', async () => {
    mockSearchParams = new URLSearchParams('addAccount=true&returnUrl=%2Ffrom-a')
    window.localStorage.setItem('arena_adding_account', 'true')
    const sessionRead = deferred<{
      data: { session: Session }
      error: null
    }>()
    beginAuthIdentityOperation('user-a')
    mockGetSession.mockReturnValue(sessionRead.promise)
    mockGetUser.mockResolvedValue({ data: { user: user('user-b') }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: profile('user-b'), error: null })

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1))

    beginAuthIdentityOperation('user-b')
    synchronizeViewerScope(true, 'user-b')
    await act(async () =>
      sessionRead.resolve({ data: { session: session('user-b') }, error: null })
    )

    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockAddAccount).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('arena_adding_account')).toBe('true')
  })

  it('accepts a session acquired by this tab redirect after the initial boundary changes', async () => {
    mockSearchParams = new URLSearchParams('addAccount=true&returnUrl=%2Ffeed')
    window.history.replaceState(
      {},
      '',
      '/auth/callback?addAccount=true&returnUrl=%2Ffeed&code=oauth-code'
    )
    const sessionRead = deferred<{
      data: { session: Session }
      error: null
    }>()
    const acquiredSession = session('user-a')
    mockGetSession.mockReturnValue(sessionRead.promise)
    mockGetUser.mockResolvedValue({ data: { user: acquiredSession.user }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: profile('user-a'), error: null })

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1))

    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(acquiredSession))
    expect(getAuthRedirectAcquisitionReceipt()).toMatchObject({
      userId: 'user-a',
      navigationKey: '/auth/callback?addAccount=true&returnUrl=%2Ffeed',
    })
    await act(async () => sessionRead.resolve({ data: { session: acquiredSession }, error: null }))

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(mockGetUser).toHaveBeenCalledWith('access-user-a')
    expect(mockAddAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', refreshToken: 'refresh-user-a' })
    )
    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
  })

  it('rejects B after B supersedes the operation named by A redirect receipt', async () => {
    mockSearchParams = new URLSearchParams('addAccount=true')
    window.history.replaceState({}, '', '/auth/callback?addAccount=true&code=oauth-code-a')
    const acquiredSessionA = session('user-a')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(acquiredSessionA))
    const receiptA = getAuthRedirectAcquisitionReceipt()
    expect(receiptA).toMatchObject({ userId: 'user-a' })

    const sessionRead = deferred<{
      data: { session: Session }
      error: null
    }>()
    mockGetSession.mockReturnValue(sessionRead.promise)
    mockGetUser.mockResolvedValue({ data: { user: user('user-b') }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: profile('user-b'), error: null })

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1))

    beginAuthIdentityOperation('user-b')
    synchronizeViewerScope(true, 'user-b')
    await act(async () =>
      sessionRead.resolve({ data: { session: session('user-b') }, error: null })
    )

    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockAddAccount).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(getAuthRedirectAcquisitionReceipt()).toEqual(receiptA)
  })

  it('allows token rotation for the receipt principal without changing its operation', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=oauth-code-a')
    const acquiredSession = session('user-a')
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(acquiredSession))
    const receipt = getAuthRedirectAcquisitionReceipt()
    const operation = getCurrentAuthOperation()
    expect(receipt?.operationId).toBe(operation?.id)

    const sessionRead = deferred<{
      data: { session: Session }
      error: null
    }>()
    const rotatedSession = {
      ...acquiredSession,
      access_token: 'rotated-access-user-a',
      refresh_token: 'rotated-refresh-user-a',
    }
    mockGetSession.mockReturnValue(sessionRead.promise)
    mockGetUser.mockResolvedValue({ data: { user: rotatedSession.user }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: profile('user-a'), error: null })

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1))
    await withAuthSessionWriter(operation!, async () => {
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(rotatedSession))
    })
    expect(getAuthRedirectAcquisitionReceipt()).toEqual(receipt)
    expect(getCurrentAuthOperation()?.id).toBe(operation?.id)

    await act(async () => sessionRead.resolve({ data: { session: rotatedSession }, error: null }))

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    expect(mockGetUser).toHaveBeenCalledWith('rotated-access-user-a')
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
    expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
  })

  it('fails closed and rolls back only the exact session when its profile is missing', async () => {
    const capturedSession = session('user-a', {
      user_metadata: { avatar_url: 'https://example.com/avatar.png' },
    })
    mockGetSession.mockResolvedValue({ data: { session: capturedSession }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: capturedSession.user }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockSignOutIfCurrent.mockImplementation(async () => {
      synchronizeViewerScope(true, null)
      return true
    })

    render(<AuthCallbackPage />)

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/login?error=profile_provisioning_failed')
    )
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-user-a')
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockAddAccount).not.toHaveBeenCalled()
  })

  it('drops A profile completion after an A-to-B auth operation wins', async () => {
    const profileRead = deferred<{ data: ReturnType<typeof profile>; error: null }>()
    const capturedSession = session('user-a')
    mockGetSession.mockResolvedValue({ data: { session: capturedSession }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: capturedSession.user }, error: null })
    mockMaybeSingle.mockReturnValue(profileRead.promise)

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(1))

    beginAuthIdentityOperation('user-b')
    synchronizeViewerScope(true, 'user-b')
    await act(async () => profileRead.resolve({ data: profile('user-a'), error: null }))

    await waitFor(() => expect(mockGetUser).toHaveBeenCalledTimes(1))
    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
    expect(mockAddAccount).not.toHaveBeenCalled()
  })

  it('does not let A redirect B while an exact failure rollback is settling', async () => {
    const rollback = deferred<boolean>()
    const capturedSession = session('user-a')
    mockGetSession.mockResolvedValue({ data: { session: capturedSession }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: capturedSession.user }, error: null })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockSignOutIfCurrent.mockReturnValue(rollback.promise)

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockSignOutIfCurrent).toHaveBeenCalledTimes(1))

    beginAuthIdentityOperation('user-b')
    synchronizeViewerScope(true, 'user-b')
    await act(async () => rollback.resolve(true))

    expect(mockReplace).not.toHaveBeenCalled()
    expect(mockAddAccount).not.toHaveBeenCalled()
  })

  it('rolls back a captured session whose access token verifies as another user', async () => {
    const capturedSession = session('user-a')
    mockGetSession.mockResolvedValue({ data: { session: capturedSession }, error: null })
    mockGetUser.mockResolvedValue({ data: { user: user('user-b') }, error: null })
    mockSignOutIfCurrent.mockImplementation(async () => {
      synchronizeViewerScope(true, null)
      return true
    })

    render(<AuthCallbackPage />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login?error=auth_failed'))
    expect(mockSignOutIfCurrent).toHaveBeenCalledWith('user-a', 'access-user-a')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockAddAccount).not.toHaveBeenCalled()
  })

  it('expires an empty-session retry before it can adopt a newer B operation', async () => {
    jest.useFakeTimers()
    let view: ReturnType<typeof render> | null = null
    try {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null })

      view = render(<AuthCallbackPage />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(mockGetSession).toHaveBeenCalledTimes(1)

      beginAuthIdentityOperation('user-b')
      synchronizeViewerScope(true, 'user-b')
      await act(async () => {
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mockGetSession).toHaveBeenCalledTimes(1)
      expect(mockReplace).not.toHaveBeenCalled()
      expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
    } finally {
      view?.unmount()
      jest.useRealTimers()
    }
  })

  it('accepts this tab redirect acquisition while an empty-session retry is sleeping', async () => {
    jest.useFakeTimers()
    let view: ReturnType<typeof render> | null = null
    try {
      mockSearchParams = new URLSearchParams('returnUrl=%2Ffeed')
      window.history.replaceState({}, '', '/auth/callback?returnUrl=%2Ffeed&code=oauth-code')
      const acquiredSession = session('user-a')
      mockGetSession
        .mockResolvedValueOnce({ data: { session: null }, error: null })
        .mockResolvedValueOnce({ data: { session: acquiredSession }, error: null })
      mockGetUser.mockResolvedValue({ data: { user: acquiredSession.user }, error: null })
      mockMaybeSingle.mockResolvedValue({ data: profile('user-a'), error: null })

      view = render(<AuthCallbackPage />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(mockGetSession).toHaveBeenCalledTimes(1)

      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(acquiredSession))
      expect(getAuthRedirectAcquisitionReceipt()).toMatchObject({
        userId: 'user-a',
        navigationKey: '/auth/callback?returnUrl=%2Ffeed',
      })
      await act(async () => {
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()
      })

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/feed'))
      expect(mockGetSession).toHaveBeenCalledTimes(2)
      expect(mockGetUser).toHaveBeenCalledWith('access-user-a')
      expect(mockSignOutIfCurrent).not.toHaveBeenCalled()
      expect(getAuthRedirectAcquisitionReceipt()).toBeNull()
    } finally {
      view?.unmount()
      jest.useRealTimers()
    }
  })

  it('does not rebase direct-session retries when B wins the initial empty read', async () => {
    const initialRead = deferred<{
      data: { session: null }
      error: null
    }>()
    beginAuthIdentityOperation('user-a')
    mockGetSession.mockReturnValue(initialRead.promise)

    render(<AuthCallbackPage />)
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1))

    beginAuthIdentityOperation('user-b')
    synchronizeViewerScope(true, 'user-b')
    await act(async () => initialRead.resolve({ data: { session: null }, error: null }))

    expect(mockGetSession).toHaveBeenCalledTimes(1)
    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
