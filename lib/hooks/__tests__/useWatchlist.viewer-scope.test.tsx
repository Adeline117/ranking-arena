import type { ReactElement, ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'

const mockUseAuthSession = jest.fn()
const mockAuthedFetch = jest.fn()
const mockTryUnlock = jest.fn()

jest.mock('@/lib/hooks/useAuthSession', () => ({
  useAuthSession: () => mockUseAuthSession(),
}))
jest.mock('@/lib/api/client', () => ({
  authedFetch: (...args: unknown[]) => mockAuthedFetch(...args),
}))
jest.mock('@/lib/hooks/useAchievements', () => ({
  useAchievements: () => ({ tryUnlock: mockTryUnlock }),
}))

import { isWatchlistViewerChangedError, useWatchlist } from '@/lib/hooks/useWatchlist'

function authFor(userId: string, sessionGeneration: number) {
  return {
    accessToken: `token-${userId}-${sessionGeneration}`,
    authChecked: true,
    isLoggedIn: true,
    loading: false,
    sessionGeneration,
    userId,
    viewerKey: `user:${userId}` as const,
  }
}

function item(id: string) {
  return {
    source: 'binance',
    source_trader_id: id,
    handle: id,
    created_at: '2026-07-28T00:00:00.000Z',
  }
}

function ok(ids: string[]) {
  return {
    ok: true,
    status: 200,
    data: { watchlist: ids.map(item) },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useWatchlist viewer ownership', () => {
  let currentAuth: ReturnType<typeof authFor>
  let queryClient: QueryClient
  let Wrapper: ({ children }: { children: ReactNode }) => ReactElement

  beforeEach(() => {
    jest.clearAllMocks()
    __resetViewerScopeForTests()
    const scope = synchronizeViewerScope(true, 'user-a')
    currentAuth = authFor('user-a', scope.sessionGeneration)
    mockUseAuthSession.mockImplementation(() => currentAuth)
    mockAuthedFetch.mockResolvedValue(ok([]))
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    Wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  })

  afterEach(() => queryClient.clear())

  it('hides A data on the first B render and loads B under a distinct cache key', async () => {
    const userB = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (method !== 'GET') return Promise.resolve(ok([]))
        return scope.expectedUserId === 'user-a' ? Promise.resolve(ok(['a-only'])) : userB.promise
      }
    )
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'a-only')).toBe(true))
    const userAGeneration = currentAuth.sessionGeneration

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender()

    expect(view.result.current.watchlist).toEqual([])
    expect(view.result.current.isWatched('binance', 'a-only')).toBe(false)
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => userB.resolve(ok(['b-only'])))
    await waitFor(() => expect(view.result.current.isWatched('binance', 'b-only')).toBe(true))
    expect(view.result.current.isWatched('binance', 'a-only')).toBe(false)
    expect(queryClient.getQueryData(['watchlist', `user:user-a`, userAGeneration])).toEqual([
      item('a-only'),
    ])
    expect(
      queryClient.getQueryData(['watchlist', `user:user-b`, scopeB.sessionGeneration])
    ).toEqual([item('b-only')])
  })

  it('drops a delayed A read after B owns the hook', async () => {
    const userA = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        _method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => (scope.expectedUserId === 'user-a' ? userA.promise : Promise.resolve(ok(['b-only'])))
    )
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(mockAuthedFetch).toHaveBeenCalledTimes(1))

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender()
    await waitFor(() => expect(view.result.current.isWatched('binance', 'b-only')).toBe(true))

    await act(async () => userA.resolve(ok(['a-only'])))
    expect(view.result.current.isWatched('binance', 'b-only')).toBe(true)
    expect(view.result.current.isWatched('binance', 'a-only')).toBe(false)
  })

  it('does not publish or award a delayed A write under B', async () => {
    const userAWrite = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation(
      (
        _url: string,
        method: string,
        _token: string,
        _body: unknown,
        _timeout: number,
        scope: { expectedUserId: string }
      ) => {
        if (method === 'POST' && scope.expectedUserId === 'user-a') return userAWrite.promise
        return Promise.resolve(scope.expectedUserId === 'user-b' ? ok(['b-only']) : ok([]))
      }
    )
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    let write!: Promise<void>
    act(() => {
      write = view.result.current.addToWatchlist('binance', 'a-new', 'Alice')
    })
    const writeResult = write.then(
      () => null,
      (error: unknown) => error
    )

    const scopeB = synchronizeViewerScope(true, 'user-b')
    currentAuth = authFor('user-b', scopeB.sessionGeneration)
    view.rerender()
    await waitFor(() => expect(view.result.current.isWatched('binance', 'b-only')).toBe(true))

    await act(async () => {
      userAWrite.resolve(ok(['a-new']))
      expect(isWatchlistViewerChangedError(await writeResult)).toBe(true)
    })
    expect(view.result.current.isWatched('binance', 'b-only')).toBe(true)
    expect(view.result.current.isWatched('binance', 'a-new')).toBe(false)
    expect(mockTryUnlock).not.toHaveBeenCalled()
  })

  it('cancels an older read so it cannot overwrite a completed write', async () => {
    const oldRead = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch.mockImplementation((_url: string, method: string) =>
      method === 'GET' ? oldRead.promise : Promise.resolve(ok(['new-write']))
    )
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() =>
      expect(mockAuthedFetch.mock.calls.some(([, method]) => method === 'GET')).toBe(true)
    )

    await act(async () => {
      await view.result.current.addToWatchlist('binance', 'new-write', 'New')
    })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'new-write')).toBe(true))

    await act(async () => oldRead.resolve(ok(['old-read'])))
    expect(view.result.current.isWatched('binance', 'new-write')).toBe(true)
    expect(view.result.current.isWatched('binance', 'old-read')).toBe(false)
  })

  it('cancels a refetch that starts while a write is in flight', async () => {
    const writeResponse = deferred<ReturnType<typeof ok>>()
    const staleRefetch = deferred<ReturnType<typeof ok>>()
    let readCount = 0
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method !== 'GET') return writeResponse.promise
      readCount += 1
      return readCount === 1 ? Promise.resolve(ok([])) : staleRefetch.promise
    })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))

    let write!: Promise<void>
    act(() => {
      write = view.result.current.addToWatchlist('binance', 'new-write', 'New')
    })
    await waitFor(() =>
      expect(mockAuthedFetch.mock.calls.some(([, method]) => method === 'POST')).toBe(true)
    )
    act(() => {
      void view.result.current.refetch()
    })
    await waitFor(() => expect(readCount).toBe(2))

    await act(async () => {
      writeResponse.resolve(ok(['new-write']))
      await write
    })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'new-write')).toBe(true))

    await act(async () => staleRefetch.resolve(ok(['stale-refetch'])))
    expect(view.result.current.isWatched('binance', 'new-write')).toBe(true)
    expect(view.result.current.isWatched('binance', 'stale-refetch')).toBe(false)
  })

  it('serializes sibling writes so response snapshots cannot land out of order', async () => {
    const firstWrite = deferred<ReturnType<typeof ok>>()
    let writeCount = 0
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method === 'GET') return Promise.resolve(ok([]))
      writeCount += 1
      return writeCount === 1 ? firstWrite.promise : Promise.resolve(ok(['first', 'second']))
    })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.isLoading).toBe(false))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = view.result.current.addToWatchlist('binance', 'first', 'First')
      second = view.result.current.addToWatchlist('binance', 'second', 'Second')
    })
    await waitFor(() => expect(writeCount).toBe(1))

    await act(async () => {
      firstWrite.resolve(ok(['first']))
      await Promise.all([first, second])
    })
    expect(writeCount).toBe(2)
    await waitFor(() => expect(view.result.current.isWatched('binance', 'first')).toBe(true))
    expect(view.result.current.isWatched('binance', 'second')).toBe(true)
  })

  it('reconciles server truth when a write fails after cancelling the initial read', async () => {
    const cancelledInitialRead = deferred<ReturnType<typeof ok>>()
    let readCount = 0
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method !== 'GET') {
        return Promise.resolve({ ok: false, status: 503, data: null })
      }
      readCount += 1
      return readCount === 1 ? cancelledInitialRead.promise : Promise.resolve(ok(['server-truth']))
    })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(readCount).toBe(1))

    const writeResult = view.result.current
      .addToWatchlist('binance', 'attempted', 'Attempted')
      .then(
        () => null,
        (error: unknown) => error
      )
    const error = await writeResult

    expect(error).toMatchObject({ status: 503 })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'server-truth')).toBe(true))
    expect(view.result.current.isLoading).toBe(false)
    expect(view.result.current.error).toBeNull()

    await act(async () => cancelledInitialRead.resolve(ok(['cancelled-old-read'])))
    expect(view.result.current.isWatched('binance', 'server-truth')).toBe(true)
    expect(view.result.current.isWatched('binance', 'cancelled-old-read')).toBe(false)
  })

  it('reconciles after a malformed successful write response', async () => {
    let readCount = 0
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method === 'GET') {
        readCount += 1
        return Promise.resolve(readCount === 1 ? ok(['before']) : ok(['after']))
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { watchlist: [item('after'), { source: 'binance', source_trader_id: 42 }] },
      })
    })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'before')).toBe(true))

    const error = await view.result.current.addToWatchlist('binance', 'after', 'After').then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toMatchObject({ status: 502 })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'after')).toBe(true))
    expect(view.result.current.isWatched('binance', 'before')).toBe(false)
    expect(readCount).toBe(2)
    expect(mockTryUnlock).not.toHaveBeenCalled()
  })

  it('cancels a pre-write refetch before recovering from a malformed write', async () => {
    const cancelledInitialRead = deferred<ReturnType<typeof ok>>()
    const preWriteRefetch = deferred<ReturnType<typeof ok>>()
    const malformedWrite = deferred<{
      ok: boolean
      status: number
      data: { watchlist: unknown[] }
    }>()
    let readCount = 0
    mockAuthedFetch.mockImplementation((_url: string, method: string) => {
      if (method !== 'GET') return malformedWrite.promise
      readCount += 1
      if (readCount === 1) return cancelledInitialRead.promise
      if (readCount === 2) return preWriteRefetch.promise
      return Promise.resolve(ok(['post-write-truth']))
    })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(readCount).toBe(1))

    const write = view.result.current.addToWatchlist('binance', 'post-write-truth', 'After').then(
      () => null,
      (reason: unknown) => reason
    )
    await waitFor(() =>
      expect(mockAuthedFetch.mock.calls.some(([, method]) => method === 'POST')).toBe(true)
    )
    act(() => {
      void view.result.current.refetch()
    })
    await waitFor(() => expect(readCount).toBe(2))

    await act(async () => {
      malformedWrite.resolve({
        ok: true,
        status: 200,
        data: {
          watchlist: [item('post-write-truth'), { source: 'binance', source_trader_id: 42 }],
        },
      })
      expect(await write).toMatchObject({ status: 502 })
    })
    expect(readCount).toBe(3)
    await waitFor(() =>
      expect(view.result.current.isWatched('binance', 'post-write-truth')).toBe(true)
    )

    await act(async () => {
      preWriteRefetch.resolve(ok(['pre-write-stale']))
      cancelledInitialRead.resolve(ok(['initial-stale']))
    })
    expect(view.result.current.isWatched('binance', 'post-write-truth')).toBe(true)
    expect(view.result.current.isWatched('binance', 'pre-write-stale')).toBe(false)
    expect(view.result.current.isWatched('binance', 'initial-stale')).toBe(false)
  })

  it('does not reuse watchlist data after the same user starts a new session generation', async () => {
    const secondSession = deferred<ReturnType<typeof ok>>()
    mockAuthedFetch
      .mockResolvedValueOnce(ok(['old-session']))
      .mockReturnValueOnce(secondSession.promise)
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.isWatched('binance', 'old-session')).toBe(true))

    const transition = beginViewerTransition('user-a')
    const nextScope = commitViewerTransition(transition, 'user-a')!
    currentAuth = authFor('user-a', nextScope.sessionGeneration)
    view.rerender()

    expect(view.result.current.watchlist).toEqual([])
    expect(view.result.current.isWatched('binance', 'old-session')).toBe(false)
    await act(async () => secondSession.resolve(ok(['new-session'])))
    await waitFor(() => expect(view.result.current.isWatched('binance', 'new-session')).toBe(true))
  })

  it('surfaces a failed read instead of treating it as an authoritative empty list', async () => {
    mockAuthedFetch.mockResolvedValue({ ok: false, status: 503, data: null })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.error).toBeInstanceOf(Error))
    expect(view.result.current.watchlist).toEqual([])
    expect(view.result.current.error).toMatchObject({ status: 503 })
  })

  it('rejects a partially malformed list instead of publishing a truncated subset', async () => {
    mockAuthedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { watchlist: [item('valid'), { source: 'binance', source_trader_id: 42 }] },
    })
    const view = renderHook(() => useWatchlist(), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.error).toBeInstanceOf(Error))
    expect(view.result.current.isWatched('binance', 'valid')).toBe(false)
    expect(view.result.current.error).toMatchObject({ status: 502 })
  })
})
