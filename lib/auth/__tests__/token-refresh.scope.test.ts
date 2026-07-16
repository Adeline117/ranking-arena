const mockGetSession = jest.fn()
const mockRefreshSession = jest.fn()
const mockSetSession = jest.fn()
const mockSignOut = jest.fn()
const mockAdminSignOut = jest.fn()
const mockSignInWithPassword = jest.fn()
const mockVerifyOtp = jest.fn()
const mockUpdateUser = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
      setSession: mockSetSession,
      signOut: mockSignOut,
      admin: { signOut: mockAdminSignOut },
      signInWithPassword: mockSignInWithPassword,
      verifyOtp: mockVerifyOtp,
      updateUser: mockUpdateUser,
    },
  },
}))

import {
  fetchWithTokenRefresh,
  registerAuthStateSetter,
  tokenRefreshCoordinator,
} from '../token-refresh'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  getViewerScope,
  synchronizeViewerScope,
} from '../viewer-scope'
import {
  AUTH_STORAGE_KEY,
  __resetAuthOperationsForTests,
  beginAuthIdentityOperation,
  guardedAuthStorage,
  withAuthSessionWriter,
} from '../session-operation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fetchResponse(status: number): Response {
  return { status } as Response
}

function session(userId: string, accessToken: string) {
  return {
    user: { id: userId, email: `${userId}@example.test` },
    access_token: accessToken,
    refresh_token: `refresh-${userId}`,
  }
}

function jwt(userId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode({ sub: userId })}.signature`
}

async function seedStoredSession(userId: string, accessToken: string): Promise<void> {
  const operation = beginAuthIdentityOperation(userId)
  await withAuthSessionWriter(operation, async () => {
    guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session(userId, accessToken)))
  })
}

describe('TokenRefreshCoordinator viewer binding', () => {
  beforeEach(async () => {
    await tokenRefreshCoordinator.settleInflightRefreshes()
    tokenRefreshCoordinator.observeSession(null)
    __resetViewerScopeForTests()
    __resetAuthOperationsForTests()
    mockGetSession.mockReset()
    mockRefreshSession.mockReset()
    mockSetSession.mockReset()
    mockSignOut.mockReset().mockResolvedValue({ error: null })
    mockAdminSignOut.mockReset().mockResolvedValue({ error: null })
    mockSignInWithPassword.mockReset()
    mockVerifyOtp.mockReset()
    mockUpdateUser.mockReset()
    registerAuthStateSetter(() => {})
    global.fetch = jest.fn()
  })

  it('coalesces refreshes only within the same user epoch', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const refresh = deferred<{
      data: { session: ReturnType<typeof session> }
      error: null
    }>()
    mockRefreshSession.mockReturnValueOnce(refresh.promise)

    const first = tokenRefreshCoordinator.forceRefresh({
      expectedUserId: 'user-a',
      sessionGeneration: scope.sessionGeneration,
    })
    const second = tokenRefreshCoordinator.forceRefresh({
      expectedUserId: 'user-a',
      sessionGeneration: scope.sessionGeneration,
    })
    refresh.resolve({ data: { session: session('user-a', 'token-a2') }, error: null })

    await expect(first).resolves.toBe('token-a2')
    await expect(second).resolves.toBe('token-a2')
    expect(mockRefreshSession).toHaveBeenCalledTimes(1)
    expect(getViewerScope()).toEqual(scope)
  })

  it('routes proactive expiry refresh through the leased session writer', async () => {
    jest.useFakeTimers()
    try {
      const scope = synchronizeViewerScope(true, 'user-a')
      const expiringSession = {
        ...session('user-a', 'token-a1'),
        expires_at: Math.floor(Date.now() / 1_000) + 120,
      }
      const refreshedSession = {
        ...session('user-a', 'token-a2'),
        expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      }
      mockRefreshSession.mockImplementationOnce(async () => {
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(refreshedSession))
        return { data: { session: refreshedSession }, error: null }
      })

      tokenRefreshCoordinator.observeSession(
        expiringSession as Parameters<typeof tokenRefreshCoordinator.observeSession>[0]
      )
      await jest.advanceTimersByTimeAsync(61_000)
      await tokenRefreshCoordinator.settleInflightRefreshes()

      expect(mockRefreshSession).toHaveBeenCalledTimes(1)
      expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
        access_token: 'token-a2',
        user: { id: 'user-a' },
      })
      expect(getViewerScope()).toEqual(scope)
    } finally {
      tokenRefreshCoordinator.observeSession(null)
      jest.useRealTimers()
    }
  })

  it('bounds logout waiting when a refresh never settles', async () => {
    jest.useFakeTimers()
    try {
      const scope = synchronizeViewerScope(true, 'user-a')
      const stuckRefresh = deferred<{
        data: { session: null }
        error: { message: string }
      }>()
      mockRefreshSession.mockReturnValueOnce(stuckRefresh.promise)
      void tokenRefreshCoordinator.forceRefresh({
        expectedUserId: 'user-a',
        sessionGeneration: scope.sessionGeneration,
      })
      while (mockRefreshSession.mock.calls.length < 1) await Promise.resolve()

      const settlement = tokenRefreshCoordinator.settleInflightRefreshes(3_000)
      await jest.advanceTimersByTimeAsync(3_000)

      await expect(settlement).resolves.toBe(false)
      stuckRefresh.resolve({ data: { session: null }, error: { message: 'cancelled' } })
      await tokenRefreshCoordinator.settleInflightRefreshes()
    } finally {
      jest.useRealTimers()
      __resetViewerScopeForTests()
    }
  })

  it('discards an A refresh that finishes after an A to B transition begins', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const refresh = deferred<{
      data: { session: ReturnType<typeof session> }
      error: null
    }>()
    mockRefreshSession.mockReturnValueOnce(refresh.promise)

    const request = tokenRefreshCoordinator.forceRefresh({
      expectedUserId: 'user-a',
      sessionGeneration: scope.sessionGeneration,
    })
    beginViewerTransition('user-b')
    refresh.resolve({ data: { session: session('user-a', 'late-token-a') }, error: null })

    await expect(request).resolves.toBeNull()
    expect(getViewerScope().viewerKey).toBe('pending')
  })

  it('prevents a real late refresh storage/state side effect from overwriting B', async () => {
    await seedStoredSession('user-a', 'token-a1')
    const scope = synchronizeViewerScope(true, 'user-a')
    const refreshA = deferred<{
      data: { session: ReturnType<typeof session> }
      error: null
    }>()
    const publishedStates: Array<{ userId: string | null; accessToken: string | null }> = []
    registerAuthStateSetter((state) => {
      publishedStates.push({ userId: state.userId, accessToken: state.accessToken })
    })
    mockRefreshSession
      .mockImplementationOnce(async () => {
        const result = await refreshA.promise
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(result.data.session))
        return result
      })
      .mockImplementationOnce(async () => {
        const result = { data: { session: session('user-b', 'token-b') }, error: null }
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(result.data.session))
        return result
      })

    const refreshing = tokenRefreshCoordinator.forceRefresh({
      expectedUserId: 'user-a',
      sessionGeneration: scope.sessionGeneration,
    })
    while (mockRefreshSession.mock.calls.length < 1) await Promise.resolve()
    const switching = tokenRefreshCoordinator.switchSession('refresh-user-b', 'user-b')

    refreshA.resolve({ data: { session: session('user-a', 'late-token-a') }, error: null })

    await expect(refreshing).resolves.toBeNull()
    await expect(switching).resolves.toMatchObject({ user: { id: 'user-b' } })
    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      access_token: 'token-b',
      user: { id: 'user-b' },
    })
    expect(publishedStates).toEqual([{ userId: 'user-b', accessToken: 'token-b' }])
  })

  it('returns logout before the shared auth lock and rejects the late A write', async () => {
    await seedStoredSession('user-a', 'token-a1')
    const scope = synchronizeViewerScope(true, 'user-a')
    const refreshA = deferred<{
      data: { session: ReturnType<typeof session> }
      error: null
    }>()
    const lockedSignOut = deferred<{ error: null }>()
    const publishedStates: Array<{ userId: string | null; accessToken: string | null }> = []
    registerAuthStateSetter((state) => {
      publishedStates.push({ userId: state.userId, accessToken: state.accessToken })
    })
    mockRefreshSession.mockImplementationOnce(async () => {
      const result = await refreshA.promise
      guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(result.data.session))
      return result
    })
    mockSignOut.mockReturnValueOnce(lockedSignOut.promise)

    const refreshing = tokenRefreshCoordinator.forceRefresh({
      expectedUserId: 'user-a',
      sessionGeneration: scope.sessionGeneration,
    })
    while (mockRefreshSession.mock.calls.length < 1) await Promise.resolve()

    await expect(tokenRefreshCoordinator.signOut()).resolves.toBeUndefined()
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(mockSignOut).not.toHaveBeenCalled()
    expect(publishedStates).toEqual([{ userId: null, accessToken: null }])

    refreshA.resolve({ data: { session: session('user-a', 'late-token-a') }, error: null })
    await expect(refreshing).resolves.toBeNull()
    while (mockSignOut.mock.calls.length < 1) await Promise.resolve()
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    lockedSignOut.resolve({ error: null })
    await Promise.resolve()
  })

  it('rolls back only the exact principal that still owns browser auth', async () => {
    await seedStoredSession('user-a', jwt('user-a'))
    synchronizeViewerScope(true, 'user-a')

    await expect(tokenRefreshCoordinator.signOutIfCurrent('user-a')).resolves.toBe(true)
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
  })

  it('does not let a late A rollback sign out the current B principal', async () => {
    await seedStoredSession('user-b', jwt('user-b'))
    synchronizeViewerScope(true, 'user-b')

    await expect(tokenRefreshCoordinator.signOutIfCurrent('user-a')).resolves.toBe(false)
    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      user: { id: 'user-b' },
    })
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('does not roll back a newer session for the same principal', async () => {
    const newerToken = jwt('user-a')
    await seedStoredSession('user-a', newerToken)
    synchronizeViewerScope(true, 'user-a')

    await expect(
      tokenRefreshCoordinator.signOutIfCurrent('user-a', `${newerToken}-superseded`)
    ).resolves.toBe(false)
    expect(window.localStorage.getItem(AUTH_STORAGE_KEY)).not.toBeNull()
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('serializes direct password writers and rejects the superseded login result', async () => {
    const passwordA = deferred<{
      data: { session: ReturnType<typeof session>; user: ReturnType<typeof session>['user'] }
      error: null
    }>()
    const publishedStates: Array<{ userId: string | null; accessToken: string | null }> = []
    registerAuthStateSetter((state) => {
      publishedStates.push({ userId: state.userId, accessToken: state.accessToken })
    })
    mockSignInWithPassword
      .mockImplementationOnce(async () => {
        const result = await passwordA.promise
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(result.data.session))
        return result
      })
      .mockImplementationOnce(async () => {
        const sessionB = session('user-b', 'token-b')
        guardedAuthStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionB))
        return { data: { session: sessionB, user: sessionB.user }, error: null }
      })

    const loginA = tokenRefreshCoordinator.signInWithPassword({
      email: 'a@example.test',
      password: 'password-a',
    })
    while (mockSignInWithPassword.mock.calls.length < 1) await Promise.resolve()
    const loginB = tokenRefreshCoordinator.signInWithPassword({
      email: 'b@example.test',
      password: 'password-b',
    })
    const sessionA = session('user-a', 'late-token-a')
    passwordA.resolve({ data: { session: sessionA, user: sessionA.user }, error: null })

    await expect(loginA).resolves.toMatchObject({
      data: { session: null },
      error: { code: 'auth_operation_superseded' },
    })
    await expect(loginB).resolves.toMatchObject({
      data: { session: { user: { id: 'user-b' } } },
      error: null,
    })
    expect(JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? '{}')).toMatchObject({
      access_token: 'token-b',
      user: { id: 'user-b' },
    })
    expect(publishedStates).toEqual([{ userId: 'user-b', accessToken: 'token-b' }])
  })

  it('returns the exact leased session after an auth user update without reacquiring it', async () => {
    await seedStoredSession('user-a', 'token-a1')
    const scope = synchronizeViewerScope(true, 'user-a')
    mockUpdateUser.mockResolvedValueOnce({
      data: { user: { id: 'user-a', email: 'user-a@example.test' } },
      error: null,
    })

    await expect(
      tokenRefreshCoordinator.updateUserWithSession(
        { password: 'correct-horse-battery-staple' },
        { expectedUserId: 'user-a', sessionGeneration: scope.sessionGeneration }
      )
    ).resolves.toMatchObject({
      data: {
        user: { id: 'user-a' },
        session: { access_token: 'token-a1', user: { id: 'user-a' } },
      },
      error: null,
    })
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('does not send an initial request whose captured A scope is already stale', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    beginViewerTransition('user-b')

    const result = await fetchWithTokenRefresh(
      '/api/private',
      { headers: { Authorization: 'Bearer token-a' } },
      { expectedUserId: 'user-a', sessionGeneration: scope.sessionGeneration }
    )

    expect(result.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('derives JWT ownership before sending when no caller scope is supplied', async () => {
    synchronizeViewerScope(true, 'user-b')

    const result = await fetchWithTokenRefresh('/api/private', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt('user-a')}` },
    })

    expect(result.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('requires an explicit principal scope for opaque credentials', async () => {
    synchronizeViewerScope(true, 'user-a')

    const result = await fetchWithTokenRefresh('/api/private', {
      headers: { Authorization: 'Bearer opaque-token' },
    })

    expect(result.status).toBe(401)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('cannot let an older switch completion overwrite a newer logout transition', async () => {
    synchronizeViewerScope(true, 'user-a')
    const switchResponse = deferred<{
      data: { session: ReturnType<typeof session> }
      error: null
    }>()
    mockRefreshSession.mockReturnValueOnce(switchResponse.promise)

    const switching = tokenRefreshCoordinator.switchSession('refresh-user-b', 'user-b')
    while (mockRefreshSession.mock.calls.length < 1) await Promise.resolve()
    beginViewerTransition(null)
    switchResponse.resolve({ data: { session: session('user-b', 'token-b') }, error: null })

    await expect(switching).resolves.toBeNull()
    expect(getViewerScope().viewerKey).toBe('pending')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('cannot let a server-issued session overwrite a newer logout transition', async () => {
    synchronizeViewerScope(true, 'user-a')
    const establishment = deferred<{
      data: { session: ReturnType<typeof session> }
      error: null
    }>()
    mockSetSession.mockReturnValueOnce(establishment.promise)

    const login = tokenRefreshCoordinator.establishSession(
      { access_token: jwt('user-b'), refresh_token: 'refresh-user-b' },
      'user-b'
    )
    while (mockSetSession.mock.calls.length < 1) await Promise.resolve()
    beginViewerTransition(null)
    establishment.resolve({ data: { session: session('user-b', 'token-b') }, error: null })

    await expect(login).resolves.toBeNull()
    expect(getViewerScope().viewerKey).toBe('pending')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('checks scope after refresh resolution and before issuing the retry', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    ;(global.fetch as jest.Mock).mockResolvedValueOnce(fetchResponse(401))
    mockRefreshSession.mockResolvedValueOnce({
      data: { session: session('user-a', 'token-a2') },
      error: null,
    })
    // Simulate an account transition at the exact boundary where refresh has
    // resolved but its awaiting request has not issued the retry yet.
    registerAuthStateSetter(() => {
      beginViewerTransition('user-b')
    })

    const result = await fetchWithTokenRefresh(
      '/api/private',
      { headers: { Authorization: 'Bearer token-a1' } },
      { expectedUserId: 'user-a', sessionGeneration: scope.sessionGeneration }
    )

    expect(result.status).toBe(401)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('discards a successful retry response when logout happens while it is in flight', async () => {
    const scope = synchronizeViewerScope(true, 'user-a')
    const retry = deferred<Response>()
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce(fetchResponse(401))
      .mockReturnValueOnce(retry.promise)
    mockRefreshSession.mockResolvedValueOnce({
      data: { session: session('user-a', 'token-a2') },
      error: null,
    })

    const request = fetchWithTokenRefresh(
      '/api/private',
      { headers: { Authorization: 'Bearer token-a1' } },
      { expectedUserId: 'user-a', sessionGeneration: scope.sessionGeneration }
    )
    while ((global.fetch as jest.Mock).mock.calls.length < 2) await Promise.resolve()
    beginViewerTransition(null)
    retry.resolve(fetchResponse(200))

    await expect(request).resolves.toMatchObject({ status: 401 })
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
