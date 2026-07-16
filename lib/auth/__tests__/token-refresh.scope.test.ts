const mockGetSession = jest.fn()
const mockRefreshSession = jest.fn()
const mockSetSession = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
      setSession: mockSetSession,
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

describe('TokenRefreshCoordinator viewer binding', () => {
  beforeEach(async () => {
    await tokenRefreshCoordinator.settleInflightRefreshes()
    __resetViewerScopeForTests()
    mockGetSession.mockReset()
    mockRefreshSession.mockReset()
    mockSetSession.mockReset()
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
