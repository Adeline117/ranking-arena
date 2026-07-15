const mockGetSession = jest.fn()
const mockRefreshSession = jest.fn()

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
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

describe('TokenRefreshCoordinator viewer binding', () => {
  beforeEach(async () => {
    await tokenRefreshCoordinator.settleInflightRefreshes()
    __resetViewerScopeForTests()
    mockGetSession.mockReset()
    mockRefreshSession.mockReset()
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
