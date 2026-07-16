import { act, render, waitFor } from '@testing-library/react'
import type { Session, User } from '@supabase/supabase-js'
import {
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
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
})
