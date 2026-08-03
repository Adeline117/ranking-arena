import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { linkedAccountsFetcher, useLinkedAccounts } from '../useLinkedAccounts'

const originalFetch = global.fetch

function subject(platform: string, traderKey: string) {
  return { platform, traderKey }
}

function account(platform: string, traderKey: string, overrides: Record<string, unknown> = {}) {
  return {
    platform,
    traderKey,
    handle: traderKey,
    label: 'private label',
    isPrimary: true,
    roi: 10,
    pnl: 500,
    arenaScore: 80,
    winRate: 60,
    maxDrawdown: 12,
    rank: 5,
    ...overrides,
  }
}

function payload(responseSubject: { platform: string; traderKey: string }, accounts: unknown[]) {
  return {
    success: true,
    data: {
      subject: responseSubject,
      aggregated:
        accounts.length >= 2
          ? { combinedPnl: 1_000, bestRoi: { value: 10 }, weightedScore: 80 }
          : null,
      accounts,
      totalAccounts: accounts.length,
    },
  }
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('useLinkedAccounts public identity boundary', () => {
  let queryClient: QueryClient
  let Wrapper: ({ children }: { children: ReactNode }) => React.JSX.Element
  let mockFetch: jest.Mock

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } },
    })
    Wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    mockFetch = jest.fn()
    global.fetch = mockFetch
  })

  afterEach(() => {
    queryClient.clear()
    onlineManager.setOnline(true)
  })
  afterAll(() => {
    global.fetch = originalFetch
  })

  it('does not expose trader A accounts while trader B is pending', async () => {
    const pendingB = deferred<Response>()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('trader_key=a')) {
        return Promise.resolve(
          response(
            payload(subject('bybit', 'a'), [
              account('bybit', 'a'),
              account('binance_futures', 'a-2', { isPrimary: false }),
            ])
          )
        )
      }
      return pendingB.promise
    })

    const view = renderHook(({ platform, traderKey }) => useLinkedAccounts(platform, traderKey), {
      initialProps: { platform: 'bybit', traderKey: 'a' },
      wrapper: Wrapper,
    })
    await waitFor(() => expect(view.result.current.hasMultipleAccounts).toBe(true))
    expect(view.result.current.authoritativeReady).toBe(true)

    view.rerender({ platform: 'bybit', traderKey: 'b' })
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(view.result.current.hasMultipleAccounts).toBe(false)
    expect(view.result.current.authoritativeReady).toBe(false)

    await act(async () => {
      pendingB.resolve(response(payload(subject('bybit', 'b'), [])))
      await pendingB.promise
    })
    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.linkedAccounts).toEqual([])
  })

  it('distinguishes a disabled query from an authoritative empty response', async () => {
    const view = renderHook(({ platform, traderKey }) => useLinkedAccounts(platform, traderKey), {
      initialProps: { platform: undefined, traderKey: undefined },
      wrapper: Wrapper,
    })

    expect(view.result.current.authoritativeReady).toBe(false)
    expect(view.result.current.isLoading).toBe(false)
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()

    mockFetch.mockResolvedValue(response(payload(subject('bybit', 'a'), [])))
    view.rerender({ platform: 'bybit', traderKey: 'a' })

    expect(view.result.current.authoritativeReady).toBe(false)
    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.linkedAccounts).toEqual([])
  })

  it('treats an exact empty live response as authoritative', async () => {
    mockFetch.mockResolvedValue(response(payload(subject('bybit', 'a'), [])))
    const view = renderHook(() => useLinkedAccounts('bybit', 'a'), { wrapper: Wrapper })

    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toContain('contract=2')
  })

  it('never exposes same-subject cache before this mount completes a live read', async () => {
    queryClient.setQueryData(['linked-accounts-v2', 'bybit', 'a'], {
      subject: subject('bybit', 'a'),
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      accounts: [account('bybit', 'a'), account('okx', 'old-link', { isPrimary: false })],
      totalAccounts: 2,
    })
    const live = deferred<Response>()
    mockFetch.mockReturnValue(live.promise)

    const view = renderHook(() => useLinkedAccounts('bybit', 'a'), { wrapper: Wrapper })
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(view.result.current.isLoading).toBe(true)
    expect(view.result.current.authoritativeReady).toBe(false)

    await act(async () => {
      live.resolve(response(payload(subject('bybit', 'a'), [])))
      await live.promise
    })
    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.linkedAccounts).toEqual([])
  })

  it('keeps same-subject cached membership hidden after live revalidation fails', async () => {
    queryClient.setQueryData(['linked-accounts-v2', 'bybit', 'a'], {
      subject: subject('bybit', 'a'),
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      accounts: [account('bybit', 'a'), account('okx', 'old-link', { isPrimary: false })],
      totalAccounts: 2,
    })
    mockFetch.mockRejectedValue(new Error('network unavailable'))

    const view = renderHook(() => useLinkedAccounts('bybit', 'a'), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(view.result.current.hasMultipleAccounts).toBe(false)
    expect(view.result.current.authoritativeReady).toBe(false)
  })

  it('withdraws authoritative data while a successful account is revalidating', async () => {
    const revalidation = deferred<Response>()
    mockFetch
      .mockResolvedValueOnce(
        response(
          payload(subject('bybit', 'a'), [
            account('bybit', 'a'),
            account('okx', 'linked-account', { isPrimary: false }),
          ])
        )
      )
      .mockReturnValueOnce(revalidation.promise)

    const view = renderHook(() => useLinkedAccounts('bybit', 'a'), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.hasMultipleAccounts).toBe(true)

    act(() => {
      void queryClient.refetchQueries({
        queryKey: ['linked-accounts-v2', 'bybit', 'a'],
        exact: true,
      })
    })

    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(false))
    expect(view.result.current.isLoading).toBe(true)
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(view.result.current.hasMultipleAccounts).toBe(false)

    await act(async () => {
      revalidation.resolve(response(payload(subject('bybit', 'a'), [])))
      await revalidation.promise
    })
    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.linkedAccounts).toEqual([])
  })

  it('withdraws previously authoritative data after a live revalidation error', async () => {
    mockFetch
      .mockResolvedValueOnce(
        response(
          payload(subject('bybit', 'a'), [
            account('bybit', 'a'),
            account('okx', 'linked-account', { isPrimary: false }),
          ])
        )
      )
      .mockRejectedValue(new Error('network unavailable'))

    const view = renderHook(() => useLinkedAccounts('bybit', 'a'), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.authoritativeReady).toBe(true))
    expect(view.result.current.hasMultipleAccounts).toBe(true)

    act(() => {
      void queryClient.refetchQueries({
        queryKey: ['linked-accounts-v2', 'bybit', 'a'],
        exact: true,
      })
    })

    await waitFor(() => expect(view.result.current.error).toBeTruthy())
    expect(view.result.current.authoritativeReady).toBe(false)
    expect(view.result.current.linkedAccounts).toEqual([])
    expect(view.result.current.hasMultipleAccounts).toBe(false)
  })

  it('hides previously verified membership while an offline revalidation is paused', async () => {
    mockFetch.mockResolvedValue(
      response(
        payload(subject('bybit', 'a'), [
          account('bybit', 'a'),
          account('okx', 'linked-account', { isPrimary: false }),
        ])
      )
    )
    const view = renderHook(() => useLinkedAccounts('bybit', 'a'), { wrapper: Wrapper })
    await waitFor(() => expect(view.result.current.hasMultipleAccounts).toBe(true))

    onlineManager.setOnline(false)
    act(() => {
      void queryClient.refetchQueries({
        queryKey: ['linked-accounts-v2', 'bybit', 'a'],
        exact: true,
      })
    })

    await waitFor(() => expect(view.result.current.linkedAccounts).toEqual([]))
    expect(view.result.current.isLoading).toBe(true)
    expect(view.result.current.authoritativeReady).toBe(false)
  })

  it('rejects a valid-shaped response bound to another trader', async () => {
    mockFetch.mockResolvedValue(response(payload(subject('bybit', 'b'), [account('bybit', 'b')])))
    await expect(linkedAccountsFetcher('/aggregate-for-a', subject('bybit', 'a'))).rejects.toThrow(
      'failed its public contract'
    )
  })

  it('throws on non-2xx and malformed payloads instead of caching success-null', async () => {
    mockFetch.mockResolvedValueOnce(response({}, 500))
    await expect(linkedAccountsFetcher('/failed', subject('bybit', 'a'))).rejects.toMatchObject({
      status: 500,
    })
    mockFetch.mockResolvedValueOnce(response({ data: { accounts: 'bad' } }))
    await expect(linkedAccountsFetcher('/malformed', subject('bybit', 'a'))).rejects.toThrow(
      'failed its public contract'
    )
    mockFetch.mockResolvedValueOnce(
      response({
        ...payload(subject('bybit', 'a'), []),
        success: false,
      })
    )
    await expect(linkedAccountsFetcher('/failed-envelope', subject('bybit', 'a'))).rejects.toThrow(
      'failed its public contract'
    )
  })
})
