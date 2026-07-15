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

import { tokenRefreshCoordinator } from '../token-refresh'
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
})
