jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      getUser: jest.fn(),
      refreshSession: jest.fn(),
      signOut: jest.fn(),
      setSession: jest.fn(),
    },
    from: jest.fn(),
  },
}))
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }))
jest.mock('@/lib/premium/hooks', () => ({ usePremium: () => ({ isPremium: false }) }))
const mockCentralSignOut = jest.fn()
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => ({ signOut: mockCentralSignOut }),
}))
jest.mock('@/lib/auth/token-refresh', () => ({
  tokenRefreshCoordinator: { switchSession: jest.fn() },
}))
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { act, renderHook } from '@testing-library/react'
import { invalidateStoredRefreshToken, useMultiAccount } from '../useMultiAccount'
import { useMultiAccountStore, type StoredAccount } from '@/lib/stores/multiAccountStore'
import {
  __resetViewerScopeForTests,
  getViewerScope,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockSupabase = (
  jest.requireMock('@/lib/supabase/client') as {
    supabase: {
      auth: Record<
        'getSession' | 'getUser' | 'refreshSession' | 'signOut' | 'setSession',
        jest.Mock
      >
      from: jest.Mock
    }
  }
).supabase
const mockSharedAuth = mockSupabase.auth
const mockCreateClient = (jest.requireMock('@supabase/supabase-js') as { createClient: jest.Mock })
  .createClient
const mockSwitchSession = (
  jest.requireMock('@/lib/auth/token-refresh') as {
    tokenRefreshCoordinator: { switchSession: jest.Mock }
  }
).tokenRefreshCoordinator.switchSession
const mockLogger = (
  jest.requireMock('@/lib/logger') as {
    logger: Record<'info' | 'warn' | 'error', jest.Mock>
  }
).logger
const mockIsolatedRefreshSession = jest.fn()
const mockIsolatedSignOut = jest.fn()
const mockProfileMaybeSingle = jest.fn()

function account(userId: string, refreshToken: string, isActive: boolean): StoredAccount {
  return {
    userId,
    email: `${userId}@example.com`,
    handle: userId,
    avatarUrl: null,
    refreshToken,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    isActive,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('multi-account refresh-token revocation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    useMultiAccountStore.setState({ accounts: [] })
    mockCreateClient.mockReturnValue({
      auth: {
        refreshSession: mockIsolatedRefreshSession,
        signOut: mockIsolatedSignOut,
      },
    })
    mockSupabase.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ maybeSingle: mockProfileMaybeSingle }),
      }),
    })
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockIsolatedRefreshSession.mockResolvedValue({ data: { session: null }, error: null })
    mockCentralSignOut.mockResolvedValue(undefined)
  })

  it('uses a non-persistent isolated client without touching the active session client', async () => {
    mockIsolatedRefreshSession.mockResolvedValue({
      data: { session: { access_token: 'rotated-access' } },
      error: null,
    })
    mockIsolatedSignOut.mockResolvedValue({ error: null })

    await invalidateStoredRefreshToken('stored-refresh-token')

    expect(mockCreateClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        }),
      })
    )
    expect(mockIsolatedRefreshSession).toHaveBeenCalledWith({
      refresh_token: 'stored-refresh-token',
    })
    expect(mockIsolatedSignOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(mockSharedAuth.refreshSession).not.toHaveBeenCalled()
    expect(mockSharedAuth.signOut).not.toHaveBeenCalled()
    expect(mockSharedAuth.setSession).not.toHaveBeenCalled()
  })

  it('does not report a transport failure as a confirmed invalid token', async () => {
    const networkError = { message: 'fetch failed', status: 0 }
    mockIsolatedRefreshSession.mockResolvedValue({
      data: { session: null },
      error: networkError,
    })

    await invalidateStoredRefreshToken('stored-refresh-token')

    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[multi-account] Stored refresh token revocation was not confirmed:',
      networkError
    )
    expect(mockLogger.info).not.toHaveBeenCalled()
    expect(mockIsolatedSignOut).not.toHaveBeenCalled()
  })
})

describe('multi-account viewer-scope commits', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    useMultiAccountStore.setState({ accounts: [] })
    mockSupabase.from.mockReturnValue({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({ maybeSingle: mockProfileMaybeSingle }),
      }),
    })
    mockProfileMaybeSingle.mockResolvedValue({ data: null, error: null })
    mockIsolatedRefreshSession.mockResolvedValue({ data: { session: null }, error: null })
    mockCentralSignOut.mockResolvedValue(undefined)
  })

  it('rejects an A session when getUser resolves as B after an A-to-B interleaving', async () => {
    synchronizeViewerScope(true, 'user-a')
    mockSharedAuth.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: 'user-a' },
          refresh_token: 'refresh-a',
        },
      },
    })
    const userRead = deferred<{ data: { user: { id: string; email: string } } }>()
    mockSharedAuth.getUser.mockReturnValue(userRead.promise)
    const { result } = renderHook(() => useMultiAccount())

    let savePromise!: Promise<boolean>
    act(() => {
      savePromise = result.current.addCurrentAccount()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockSharedAuth.getUser).toHaveBeenCalledTimes(1)

    synchronizeViewerScope(true, 'user-b')
    userRead.resolve({ data: { user: { id: 'user-b', email: 'b@example.com' } } })

    let saved = true
    await act(async () => {
      saved = await savePromise
    })

    expect(saved).toBe(false)
    expect(useMultiAccountStore.getState().accounts).toEqual([])
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('rechecks the viewer scope after profile hydration before committing the store', async () => {
    synchronizeViewerScope(true, 'user-a')
    mockSharedAuth.getSession.mockResolvedValue({
      data: {
        session: {
          user: { id: 'user-a' },
          refresh_token: 'refresh-a',
        },
      },
    })
    mockSharedAuth.getUser.mockResolvedValue({
      data: { user: { id: 'user-a', email: 'a@example.com' } },
    })
    const profileRead = deferred<{
      data: { handle: string; avatar_url: null }
      error: null
    }>()
    mockProfileMaybeSingle.mockReturnValue(profileRead.promise)
    const { result } = renderHook(() => useMultiAccount())

    let savePromise!: Promise<boolean>
    act(() => {
      savePromise = result.current.addCurrentAccount()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockProfileMaybeSingle).toHaveBeenCalledTimes(1)

    synchronizeViewerScope(true, 'user-b')
    profileRead.resolve({ data: { handle: 'alice', avatar_url: null }, error: null })

    let saved = true
    await act(async () => {
      saved = await savePromise
    })

    expect(saved).toBe(false)
    expect(useMultiAccountStore.getState().accounts).toEqual([])
  })

  it('does not overwrite A with a session read that becomes stale during a switch', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    const sessionRead = deferred<{
      data: { session: { user: { id: string }; refresh_token: string } }
    }>()
    mockSharedAuth.getSession.mockReturnValue(sessionRead.promise)
    const { result } = renderHook(() => useMultiAccount())

    let switchPromise!: ReturnType<typeof result.current.switchAccount>
    act(() => {
      switchPromise = result.current.switchAccount('user-b')
    })
    synchronizeViewerScope(true, 'user-b')
    sessionRead.resolve({
      data: { session: { user: { id: 'user-a' }, refresh_token: 'rotated-a' } },
    })

    let switchResult: Awaited<typeof switchPromise> | undefined
    await act(async () => {
      switchResult = await switchPromise
    })

    expect(switchResult).toEqual({ success: false, error: 'stale_session' })
    expect(useMultiAccountStore.getState().accounts).toEqual([
      account('user-a', 'stored-a', true),
      account('user-b', 'stored-b', false),
    ])
    expect(mockSwitchSession).not.toHaveBeenCalled()
  })

  it('requires the current session principal to equal the active account', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    mockSharedAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-b' }, refresh_token: 'rotated-b' } },
    })
    const { result } = renderHook(() => useMultiAccount())

    let switchResult: Awaited<ReturnType<typeof result.current.switchAccount>> | undefined
    await act(async () => {
      switchResult = await result.current.switchAccount('user-b')
    })

    expect(switchResult).toEqual({ success: false, error: 'stale_session' })
    expect(useMultiAccountStore.getState().accounts[0]).toEqual(account('user-a', 'stored-a', true))
    expect(mockSwitchSession).not.toHaveBeenCalled()
  })

  it('preserves the current and target entries when a switch failure is unconfirmed', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    mockSharedAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' }, refresh_token: 'rotated-a' } },
    })
    mockSwitchSession.mockResolvedValue(null)
    const { result } = renderHook(() => useMultiAccount())

    let switchResult: Awaited<ReturnType<typeof result.current.switchAccount>> | undefined
    await act(async () => {
      switchResult = await result.current.switchAccount('user-b')
    })

    expect(switchResult).toEqual({ success: false, error: 'switch_failed' })
    expect(useMultiAccountStore.getState().accounts).toEqual([
      account('user-a', 'rotated-a', true),
      account('user-b', 'stored-b', false),
    ])
  })

  it('treats switching to the already-active principal as a no-op', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({ accounts: [account('user-a', 'stored-a', true)] })
    const { result } = renderHook(() => useMultiAccount())

    let switchResult: Awaited<ReturnType<typeof result.current.switchAccount>> | undefined
    await act(async () => {
      switchResult = await result.current.switchAccount('user-a')
    })

    expect(switchResult).toEqual({ success: true })
    expect(mockSharedAuth.getSession).not.toHaveBeenCalled()
    expect(mockSwitchSession).not.toHaveBeenCalled()
    expect(useMultiAccountStore.getState().accounts).toEqual([account('user-a', 'stored-a', true)])
  })

  it('commits the switched principal using concurrently updated target metadata', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    mockSharedAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' }, refresh_token: 'rotated-a' } },
    })
    const switched = deferred<{
      user: { id: string }
      refresh_token: string
    } | null>()
    mockSwitchSession.mockReturnValue(switched.promise)
    const { result } = renderHook(() => useMultiAccount())

    let switchPromise!: ReturnType<typeof result.current.switchAccount>
    act(() => {
      switchPromise = result.current.switchAccount('user-b')
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      useMultiAccountStore.getState().addAccount({
        ...account('user-b', 'concurrently-updated-b', false),
        handle: 'updated-b',
      })
      synchronizeViewerScope(true, 'user-b')
      switched.resolve({ user: { id: 'user-b' }, refresh_token: 'session-b' })
    })

    let switchResult: Awaited<typeof switchPromise> | undefined
    await act(async () => {
      switchResult = await switchPromise
    })

    expect(switchResult).toEqual({ success: true })
    expect(useMultiAccountStore.getState().accounts).toEqual([
      account('user-a', 'rotated-a', false),
      {
        ...account('user-b', 'session-b', true),
        handle: 'updated-b',
        lastActiveAt: expect.any(String),
      },
    ])
  })

  it('reconstructs a removed target after the global identity switch succeeds', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    mockSharedAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' }, refresh_token: 'rotated-a' } },
    })
    const switched = deferred<{
      user: { id: string }
      refresh_token: string
    } | null>()
    mockSwitchSession.mockReturnValue(switched.promise)
    const { result } = renderHook(() => useMultiAccount())

    let switchPromise!: ReturnType<typeof result.current.switchAccount>
    act(() => {
      switchPromise = result.current.switchAccount('user-b')
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      useMultiAccountStore.getState().removeAccount('user-b')
      synchronizeViewerScope(true, 'user-b')
      switched.resolve({ user: { id: 'user-b' }, refresh_token: 'session-b' })
    })

    let switchResult: Awaited<typeof switchPromise> | undefined
    await act(async () => {
      switchResult = await switchPromise
    })

    expect(switchResult).toEqual({ success: true })
    expect(useMultiAccountStore.getState().accounts).toEqual([
      account('user-a', 'rotated-a', false),
      {
        ...account('user-b', 'session-b', true),
        lastActiveAt: expect.any(String),
      },
    ])
  })

  it('uses the live rotated token when an old render callback removes an account', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'old-b', false)],
    })
    const { result } = renderHook(() => useMultiAccount())
    const staleRemove = result.current.removeAccount
    act(() => {
      useMultiAccountStore.getState().addAccount(account('user-b', 'rotated-b', false))
    })

    await act(async () => staleRemove('user-b'))

    expect(mockIsolatedRefreshSession).toHaveBeenCalledWith({ refresh_token: 'rotated-b' })
    expect(mockIsolatedRefreshSession).not.toHaveBeenCalledWith({ refresh_token: 'old-b' })
    expect(useMultiAccountStore.getState().accounts.map((entry) => entry.userId)).toEqual([
      'user-a',
    ])
  })

  it('logs out the real session when removing the active account', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({ accounts: [account('user-a', 'stored-a', true)] })
    mockCentralSignOut.mockImplementation(async () => {
      synchronizeViewerScope(true, null)
    })
    const { result } = renderHook(() => useMultiAccount())

    await act(async () => result.current.removeAccount('user-a'))

    expect(mockCentralSignOut).toHaveBeenCalledTimes(1)
    expect(mockIsolatedRefreshSession).not.toHaveBeenCalled()
    expect(getViewerScope().viewerKey).toBe('anon')
    expect(useMultiAccountStore.getState().accounts).toEqual([])
  })

  it('linearizes remove after an in-flight switch without re-adding the removed target', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    mockSharedAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' }, refresh_token: 'rotated-a' } },
    })
    const switched = deferred<{ user: { id: string }; refresh_token: string } | null>()
    mockSwitchSession.mockReturnValue(switched.promise)
    mockCentralSignOut.mockImplementation(async () => {
      synchronizeViewerScope(true, null)
    })
    const { result } = renderHook(() => useMultiAccount())

    const switchPromise = result.current.switchAccount('user-b')
    const removePromise = result.current.removeAccount('user-b')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      synchronizeViewerScope(true, 'user-b')
      switched.resolve({ user: { id: 'user-b' }, refresh_token: 'session-b' })
    })
    await act(async () => {
      await switchPromise
      await removePromise
    })

    expect(mockCentralSignOut).toHaveBeenCalledTimes(1)
    expect(getViewerScope().viewerKey).toBe('anon')
    expect(
      useMultiAccountStore.getState().accounts.some((entry) => entry.userId === 'user-b')
    ).toBe(false)
  })

  it('linearizes sign-out-all after an in-flight switch and clears the final live store', async () => {
    synchronizeViewerScope(true, 'user-a')
    useMultiAccountStore.setState({
      accounts: [account('user-a', 'stored-a', true), account('user-b', 'stored-b', false)],
    })
    mockSharedAuth.getSession.mockResolvedValue({
      data: { session: { user: { id: 'user-a' }, refresh_token: 'rotated-a' } },
    })
    const switched = deferred<{ user: { id: string }; refresh_token: string } | null>()
    mockSwitchSession.mockReturnValue(switched.promise)
    mockCentralSignOut.mockImplementation(async () => {
      synchronizeViewerScope(true, null)
    })
    const { result } = renderHook(() => useMultiAccount())

    const switchPromise = result.current.switchAccount('user-b')
    const signOutAllPromise = result.current.signOutAll()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      synchronizeViewerScope(true, 'user-b')
      switched.resolve({ user: { id: 'user-b' }, refresh_token: 'session-b' })
    })
    await act(async () => {
      await switchPromise
      await signOutAllPromise
    })

    expect(mockCentralSignOut).toHaveBeenCalledTimes(1)
    expect(getViewerScope().viewerKey).toBe('anon')
    expect(useMultiAccountStore.getState().accounts).toEqual([])
  })
})
