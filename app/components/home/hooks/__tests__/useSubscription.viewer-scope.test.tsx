import { StrictMode, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
  type ViewerKey,
} from '@/lib/auth/viewer-scope'
import type { UserSubscription } from '@/lib/premium'
import { clearSubscriptionCache, useSubscription } from '../useSubscription'

const mockUseAuthSession = jest.fn()
const mockFetchVerifiedSubscription = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/premium/hooks', () => ({ BETA_PRO_FEATURES_FREE: false }))
jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/lib/premium/subscription-client', () => ({
  fetchVerifiedSubscription: (...args: unknown[]) => mockFetchVerifiedSubscription(...args),
}))
jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'

type MockAuth = {
  accessToken: string | null
  userId: string | null
  viewerKey: ViewerKey
  sessionGeneration: number
}

function authFor(userId: string, sessionGeneration: number): MockAuth {
  return {
    accessToken: `token-${userId}-${sessionGeneration}`,
    userId,
    viewerKey: `user:${userId}`,
    sessionGeneration,
  }
}

function subscriptionFor(userId: string, tier: 'free' | 'pro'): UserSubscription {
  return {
    userId,
    tier,
    status: 'active',
    startDate: '2026-07-01T00:00:00.000Z',
    endDate: null,
    trialEndDate: null,
    autoRenew: tier === 'pro',
    usage: {
      apiCallsToday: 0,
      comparisonReportsThisMonth: 0,
      exportsThisMonth: 0,
      currentFollows: 0,
      currentCustomRankings: 0,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function StrictModeWrapper({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>
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
    mockFetchVerifiedSubscription.mockImplementation((_accessToken: string, userId: string) =>
      Promise.resolve(subscriptionFor(userId, 'free'))
    )
  })

  it('drops an A authority completion after B owns the hook and cache', async () => {
    const subscriptionA = deferred<UserSubscription>()
    mockFetchVerifiedSubscription.mockImplementation((_accessToken: string, userId: string) =>
      userId === ACTOR_A ? subscriptionA.promise : Promise.resolve(subscriptionFor(ACTOR_B, 'free'))
    )
    const view = renderHook(() => useSubscription())
    await waitFor(() =>
      expect(mockFetchVerifiedSubscription).toHaveBeenCalledWith(
        currentAuth.accessToken,
        ACTOR_A,
        currentAuth.sessionGeneration
      )
    )

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    currentAuth = authFor(ACTOR_B, scopeB.sessionGeneration)
    view.rerender()
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: true, tier: 'free', error: null })
    )
    await waitFor(() =>
      expect(mockFetchVerifiedSubscription).toHaveBeenCalledWith(
        currentAuth.accessToken,
        ACTOR_B,
        currentAuth.sessionGeneration
      )
    )
    await waitFor(() =>
      expect(view.result.current).toEqual(
        expect.objectContaining({ isPro: false, isLoading: false, tier: 'free', error: null })
      )
    )

    await act(async () => subscriptionA.resolve(subscriptionFor(ACTOR_A, 'pro')))
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: false, tier: 'free', error: null })
    )
  })

  it('reports unknown authority instead of inventing Free after a failed first read', async () => {
    mockFetchVerifiedSubscription.mockRejectedValue(new Error('HTTP 503'))
    const view = renderHook(() => useSubscription())

    await waitFor(() => expect(view.result.current.error).toMatch(/Unable to verify/))
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: false, tier: 'free' })
    )
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('preserves same-viewer last-good Pro when a forced refresh fails', async () => {
    const view = renderHook(() => useSubscription())
    mockFetchVerifiedSubscription.mockResolvedValueOnce(subscriptionFor(ACTOR_A, 'pro'))
    act(() => view.result.current.refresh())
    await waitFor(() => expect(view.result.current.isPro).toBe(true))

    mockFetchVerifiedSubscription.mockRejectedValueOnce(new Error('HTTP 503'))
    act(() => view.result.current.refresh())

    await waitFor(() => expect(view.result.current.error).toMatch(/Unable to verify/))
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: true, isLoading: false, tier: 'pro' })
    )
  })

  it('does not reuse a cache entry across an A-to-A session generation', async () => {
    mockFetchVerifiedSubscription
      .mockResolvedValueOnce(subscriptionFor(ACTOR_A, 'pro'))
      .mockResolvedValueOnce(subscriptionFor(ACTOR_A, 'free'))
    const view = renderHook(() => useSubscription())
    await waitFor(() => expect(view.result.current.isPro).toBe(true))

    const transition = beginViewerTransition(ACTOR_A)
    const nextScope = commitViewerTransition(transition, ACTOR_A)!
    currentAuth = authFor(ACTOR_A, nextScope.sessionGeneration)
    view.rerender()
    expect(view.result.current).toEqual(
      expect.objectContaining({ isPro: false, isLoading: true, tier: 'free', error: null })
    )
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(view.result.current.isPro).toBe(false)
    expect(mockFetchVerifiedSubscription).toHaveBeenCalledTimes(2)
  })

  it('survives StrictMode replay and rejects a completion after the true unmount', async () => {
    const afterUnmount = deferred<UserSubscription>()
    let phase: 'initial' | 'refresh' | 'after-unmount' = 'initial'
    mockFetchVerifiedSubscription.mockImplementation(() => {
      if (phase === 'initial') return Promise.resolve(subscriptionFor(ACTOR_A, 'free'))
      if (phase === 'refresh') return Promise.resolve(subscriptionFor(ACTOR_A, 'pro'))
      return afterUnmount.promise
    })

    const view = renderHook(() => useSubscription(), { wrapper: StrictModeWrapper })
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(view.result.current.isPro).toBe(false)
    expect(mockFetchVerifiedSubscription).toHaveBeenCalled()

    phase = 'refresh'
    act(() => view.result.current.refresh())
    await waitFor(() => expect(view.result.current.isPro).toBe(true))

    phase = 'after-unmount'
    const callsBeforePending = mockFetchVerifiedSubscription.mock.calls.length
    act(() => view.result.current.refresh())
    await waitFor(() =>
      expect(mockFetchVerifiedSubscription.mock.calls.length).toBeGreaterThan(callsBeforePending)
    )
    view.unmount()
    await act(async () => afterUnmount.resolve(subscriptionFor(ACTOR_A, 'free')))

    const callsBeforeRemount = mockFetchVerifiedSubscription.mock.calls.length
    const remount = renderHook(() => useSubscription())
    await waitFor(() => expect(remount.result.current.isLoading).toBe(false))
    expect(remount.result.current.isPro).toBe(true)
    expect(mockFetchVerifiedSubscription).toHaveBeenCalledTimes(callsBeforeRemount)
  })

  it('immediately fails closed when the current viewer becomes pending', async () => {
    mockFetchVerifiedSubscription.mockResolvedValue(subscriptionFor(ACTOR_A, 'pro'))
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
      expect.objectContaining({ isPro: false, isLoading: true, tier: 'free', error: null })
    )
  })
})
