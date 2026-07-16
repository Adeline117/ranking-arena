import { act, renderHook, waitFor } from '@testing-library/react'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
  type ViewerKey,
} from '@/lib/auth/viewer-scope'
import { clearSubscriptionCache, useSubscription } from '../useSubscription'

const mockUseAuthSession = jest.fn()
const mockGetSession = jest.fn()
const mockOnAuthStateChange = jest.fn()
const mockFrom = jest.fn()
const mockSubscriptionResult = jest.fn()
const mockProfileResult = jest.fn()
const mockUnsubscribe = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/premium/hooks', () => ({ BETA_PRO_FEATURES_FREE: false }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))
jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args),
    },
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  userId: string | null
  viewerKey: ViewerKey
  sessionGeneration: number
}

type QueryResult = {
  data: Record<string, unknown> | null
  error: unknown
}

function authFor(userId: string, sessionGeneration: number): MockAuth {
  return {
    accessToken: `token-${userId}-${sessionGeneration}`,
    userId,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  }
}

function sessionResult(userId: string | null, error: unknown = null) {
  return {
    data: { session: userId ? { user: { id: userId } } : null },
    error,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function queryResult(data: Record<string, unknown> | null, error: unknown = null): QueryResult {
  return { data, error }
}

describe('useSubscription viewer ownership', () => {
  let currentAuth: MockAuth

  beforeEach(() => {
    jest.clearAllMocks()
    clearSubscriptionCache()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, ACTOR_A)
    currentAuth = authFor(ACTOR_A, scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    mockGetSession.mockImplementation(() => Promise.resolve(sessionResult(currentAuth.userId)))
    mockOnAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: mockUnsubscribe } },
    })
    mockSubscriptionResult.mockResolvedValue(queryResult(null))
    mockProfileResult.mockResolvedValue(queryResult({ subscription_tier: 'free' }))
    mockFrom.mockImplementation((table: string) => {
      let queryUserId = ''
      const builder: Record<string, jest.Mock> = {}
      builder.select = jest.fn(() => builder)
      builder.eq = jest.fn((column: string, value: string) => {
        if (column === 'user_id' || column === 'id') queryUserId = value
        return builder
      })
      builder.in = jest.fn(() => builder)
      builder.order = jest.fn(() => builder)
      builder.limit = jest.fn(() => builder)
      builder.maybeSingle = jest.fn(() =>
        table === 'subscriptions'
          ? mockSubscriptionResult(queryUserId)
          : mockProfileResult(queryUserId)
      )
      return builder
    })
  })

  it('drops an A query completion after B owns the hook and cache', async () => {
    const subscriptionA = deferred<QueryResult>()
    mockSubscriptionResult.mockImplementation((userId: string) =>
      userId === ACTOR_A ? subscriptionA.promise : Promise.resolve(queryResult(null))
    )
    mockProfileResult.mockResolvedValue(queryResult({ subscription_tier: 'free' }))
    const view = renderHook(() => useSubscription())
    await waitFor(() => expect(mockSubscriptionResult).toHaveBeenCalledWith(ACTOR_A))

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    currentAuth = authFor(ACTOR_B, scopeB.sessionGeneration)
    view.rerender()
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: true, tier: 'free' })
    )
    await waitFor(() => expect(mockSubscriptionResult).toHaveBeenCalledWith(ACTOR_B))
    await waitFor(() =>
      expect(view.result.current).toEqual(
        expect.objectContaining({ isPro: false, isLoading: false, tier: 'free' })
      )
    )

    await act(async () => subscriptionA.resolve(queryResult({ tier: 'pro', status: 'active' })))
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: false, tier: 'free' })
    )
    expect(mockProfileResult).toHaveBeenCalledTimes(1)
    expect(mockProfileResult).toHaveBeenCalledWith(ACTOR_B)
  })

  it('drops a stale getSession completion before it can query or publish', async () => {
    const sessionA = deferred<ReturnType<typeof sessionResult>>()
    mockGetSession
      .mockReturnValueOnce(sessionA.promise)
      .mockResolvedValueOnce(sessionResult(ACTOR_B))
    const view = renderHook(() => useSubscription())
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    currentAuth = authFor(ACTOR_B, scopeB.sessionGeneration)
    view.rerender()
    await waitFor(() => expect(mockGetSession).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))

    await act(async () => sessionA.resolve(sessionResult(ACTOR_A)))
    expect(view.result.current.isPro).toBe(false)
    expect(mockSubscriptionResult).toHaveBeenCalledTimes(1)
    expect(mockSubscriptionResult).toHaveBeenCalledWith(ACTOR_B)
  })

  it('fails closed when either subscription or profile query reports an error', async () => {
    mockSubscriptionResult.mockResolvedValueOnce(
      queryResult(null, { code: 'SUBSCRIPTION_QUERY_FAILED' })
    )
    const first = renderHook(() => useSubscription())
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))
    expect(first.result.current).toEqual(expect.objectContaining({ isPro: false, tier: 'free' }))
    expect(mockProfileResult).not.toHaveBeenCalled()
    first.unmount()

    clearSubscriptionCache()
    mockGetSession.mockClear()
    mockSubscriptionResult.mockReset()
    mockProfileResult.mockReset()
    mockSubscriptionResult.mockResolvedValue(queryResult({ tier: 'pro', status: 'active' }))
    mockProfileResult.mockResolvedValue(queryResult(null, { code: 'PROFILE_QUERY_FAILED' }))
    const second = renderHook(() => useSubscription())
    await waitFor(() => expect(second.result.current.isLoading).toBe(false))
    expect(second.result.current).toEqual(expect.objectContaining({ isPro: false, tier: 'free' }))
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('does not reuse a cache entry across an A-to-A session generation', async () => {
    mockSubscriptionResult
      .mockResolvedValueOnce(queryResult({ tier: 'pro', status: 'active' }))
      .mockResolvedValueOnce(queryResult(null))
    mockProfileResult
      .mockResolvedValueOnce(queryResult({ subscription_tier: 'free' }))
      .mockResolvedValueOnce(queryResult({ subscription_tier: 'free' }))
    const view = renderHook(() => useSubscription())
    await waitFor(() => expect(view.result.current.isPro).toBe(true))

    const transition = beginViewerTransition(ACTOR_A)
    const nextScope = commitViewerTransition(transition, ACTOR_A)!
    currentAuth = authFor(ACTOR_A, nextScope.sessionGeneration)
    view.rerender()
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: true, tier: 'free' })
    )
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(view.result.current.isPro).toBe(false)
    expect(mockSubscriptionResult).toHaveBeenCalledTimes(2)
  })

  it('immediately fails closed when the current viewer becomes pending', async () => {
    mockSubscriptionResult.mockResolvedValue(queryResult({ tier: 'pro', status: 'active' }))
    const view = renderHook(() => useSubscription())
    await waitFor(() => expect(view.result.current.isPro).toBe(true))

    const pendingGeneration = beginViewerTransition(null)
    currentAuth = {
      accessToken: null,
      userId: null,
      viewerKey: 'pending',
      sessionGeneration: pendingGeneration,
    }
    view.rerender()
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: true, tier: 'free' })
    )
  })
})
