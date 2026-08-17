import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCopierAggregate, useTraderRecords } from '../useTraderRecords'
import { fetcher } from '@/lib/hooks/fetchers'
import type { CopierAggregate, HistoryCompleteness, RecordsPage } from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

jest.mock('@/lib/hooks/fetchers', () => ({ fetcher: jest.fn() }))

function aggregate(source: string, copierCount: number): CopierAggregate {
  return {
    copierCount,
    copierCountMax: copierCount,
    totalCopierPnl: null,
    pnlDistribution: [],
    depth: 'full',
    receiptBound: true,
    provenance: {
      source,
      sourceAsOf: null,
      observedAt: '2026-07-29T12:00:00.000Z',
      publishedAt: null,
    },
  }
}

function response(data: CopierAggregate): ApiSuccessResponse<CopierAggregate> {
  return { success: true, data }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useCopierAggregate subject identity', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    onlineManager.setOnline(true)
  })

  afterEach(() => onlineManager.setOnline(true))

  it('never exposes the previous subject as placeholder data', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const pendingB = deferred<ApiSuccessResponse<CopierAggregate>>()
    ;(fetcher as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/trader-a/')) return Promise.resolve(response(aggregate('gmx', 12)))
      return pendingB.promise
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      ({ source, exchangeTraderId }) =>
        useCopierAggregate({ source, exchangeTraderId, enabled: true }),
      {
        initialProps: { source: 'gmx', exchangeTraderId: 'trader-a' },
        wrapper: Wrapper,
      }
    )

    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(12))
    expect(view.result.current.aggregate?.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })

    view.rerender({ source: 'hyperliquid_perp', exchangeTraderId: 'trader-b' })

    expect(view.result.current.aggregate).toBeNull()
    expect(view.result.current.isPendingUpstream).toBe(false)
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => {
      pendingB.resolve(response(aggregate('hyperliquid_perp', 3)))
      await pendingB.promise
    })
    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(3))
    expect(view.result.current.aggregate?.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })

    view.unmount()
    queryClient.clear()
  })

  it('quarantines an unbound aggregate without presenting it as active collection', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    ;(fetcher as jest.Mock).mockResolvedValue(
      response({ ...aggregate('gmx', 99), receiptBound: false })
    )

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(view.result.current.isPendingUpstream).toBe(false)
    expect(view.result.current.aggregate).toBeNull()
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('records_contract=csr2'))
    expect(
      queryClient.getQueryCache().find({
        queryKey: ['trader-copiers', 'csr2', 'gmx', 'trader-a'],
        exact: true,
      })
    ).toBeDefined()

    view.unmount()
    queryClient.clear()
  })

  it('never flashes a cached aggregate while its receipt authority is revalidated', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const key = ['trader-copiers', 'csr2', 'gmx', 'trader-a']
    queryClient.setQueryData(key, aggregate('gmx', 41))
    const fresh = deferred<ApiSuccessResponse<CopierAggregate>>()
    ;(fetcher as jest.Mock).mockReturnValue(fresh.promise)

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    expect(view.result.current.aggregate).toBeNull()
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => {
      fresh.resolve(response(aggregate('gmx', 42)))
      await fresh.promise
    })
    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(42))
    expect(queryClient.getQueryCache().find({ queryKey: key })?.options.gcTime).toBe(0)

    view.unmount()
    queryClient.clear()
  })

  it('revokes a previously successful aggregate when background authority refresh fails', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    let failRefresh = false
    ;(fetcher as jest.Mock).mockImplementation(() =>
      failRefresh
        ? Promise.reject(new Error('receipt authority refresh failed'))
        : Promise.resolve(response(aggregate('gmx', 12)))
    )

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(12))
    failRefresh = true
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ['trader-copiers', 'csr2', 'gmx', 'trader-a'],
        exact: true,
      })
    })

    await waitFor(() => expect(view.result.current.aggregate).toBeNull())
    expect(view.result.current.error).toBeInstanceOf(Error)

    view.unmount()
    queryClient.clear()
  })

  it('hides a successful aggregate and exposes retryable unavailability while offline revalidation is paused', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    ;(fetcher as jest.Mock).mockResolvedValue(response(aggregate('gmx', 12)))

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(12))
    await act(async () => {
      onlineManager.setOnline(false)
      void view.result.current.refetch()
      await Promise.resolve()
    })

    await waitFor(() => expect(view.result.current.aggregate).toBeNull())
    expect(view.result.current.isLoading).toBe(false)

    await act(async () => {
      onlineManager.setOnline(true)
      await Promise.resolve()
    })
    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(12))

    view.unmount()
    queryClient.clear()
  })

  it('does not leave a pending receipt permanently collecting while its revalidation is paused', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    ;(fetcher as jest.Mock).mockResolvedValue({
      success: true,
      data: { cacheState: 'pending' as const },
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(true))
    await act(async () => {
      onlineManager.setOnline(false)
      void view.result.current.refetch()
      await Promise.resolve()
    })

    await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(false))
    expect(view.result.current.aggregate).toBeNull()
    expect(view.result.current.isLoading).toBe(false)

    view.unmount()
    queryClient.clear()
  })

  it('revalidates a successful aggregate every fifteen foreground seconds', async () => {
    jest.useFakeTimers()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    ;(fetcher as jest.Mock).mockResolvedValue(response(aggregate('gmx', 8)))

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(view.result.current.aggregate?.copierCount).toBe(8)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(view.result.current.aggregate?.copierCount).toBe(8)
    } finally {
      view.unmount()
      queryClient.clear()
      jest.useRealTimers()
    }
  })

  it('starts a fresh bounded pending window after many successful aggregate updates', async () => {
    jest.useFakeTimers()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    let pending = false
    ;(fetcher as jest.Mock).mockImplementation(() =>
      Promise.resolve(
        pending
          ? { success: true, data: { cacheState: 'pending' as const } }
          : response(aggregate('gmx', 8))
      )
    )

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )
    const key = ['trader-copiers', 'csr2', 'gmx', 'trader-a']

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(view.result.current.aggregate?.copierCount).toBe(8)

      // Reproduce a long-lived authority query whose lifetime update counter
      // already exceeds the pending retry cap.
      for (let count = 0; count < 20; count += 1) {
        queryClient.setQueryData(key, aggregate('gmx', count))
      }
      pending = true
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: key, exact: true })
        await Promise.resolve()
      })
      await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(true))
      const readsAtPending = (fetcher as jest.Mock).mock.calls.length

      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_000)
      })
      expect((fetcher as jest.Mock).mock.calls.length).toBe(readsAtPending + 2)
      expect(view.result.current.isPendingUpstream).toBe(true)
    } finally {
      view.unmount()
      queryClient.clear()
      jest.useRealTimers()
    }
  })

  it('leaves the pending state on poll failure and automatically retries at fifteen seconds', async () => {
    jest.useFakeTimers()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    let mode: 'pending' | 'error' | 'aggregate' = 'pending'
    ;(fetcher as jest.Mock).mockImplementation(() => {
      if (mode === 'error') return Promise.reject(new Error('pending poll failed'))
      if (mode === 'aggregate') return Promise.resolve(response(aggregate('gmx', 6)))
      return Promise.resolve({ success: true, data: { cacheState: 'pending' as const } })
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(view.result.current.isPendingUpstream).toBe(true)

      mode = 'error'
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000)
        await Promise.resolve()
      })
      await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(false))
      expect(view.result.current.aggregate).toBeNull()
      expect(view.result.current.error).toBeInstanceOf(Error)

      mode = 'aggregate'
      await act(async () => {
        await jest.advanceTimersByTimeAsync(15_000)
      })
      expect(view.result.current.error).toBeNull()
      expect(view.result.current.aggregate?.copierCount).toBe(6)
    } finally {
      view.unmount()
      queryClient.clear()
      jest.useRealTimers()
    }
  })

  it('polls an explicit pending bridge every two seconds and stops on aggregate success', async () => {
    jest.useFakeTimers()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    let reads = 0
    ;(fetcher as jest.Mock).mockImplementation(() => {
      reads += 1
      return Promise.resolve(
        reads < 3
          ? { success: true, data: { cacheState: 'pending' as const } }
          : response(aggregate('gmx', 4))
      )
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(view.result.current.isPendingUpstream).toBe(true)
      expect(reads).toBe(1)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_000)
        await Promise.resolve()
      })
      expect(reads).toBe(3)
      await act(async () => {
        await Promise.resolve()
      })
      await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(4))

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000)
      })
      expect(reads).toBe(3)
    } finally {
      view.unmount()
      queryClient.clear()
      jest.useRealTimers()
    }
  })

  it('caps a continuously pending foreground window, exposes recovery, and restarts only on retry', async () => {
    jest.useFakeTimers()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    ;(fetcher as jest.Mock).mockResolvedValue({
      success: true,
      data: { cacheState: 'pending' as const },
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () => useCopierAggregate({ source: 'gmx', exchangeTraderId: 'trader-a', enabled: true }),
      { wrapper: Wrapper }
    )

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(40_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(15)
      expect(view.result.current.isPendingUpstream).toBe(false)
      expect(view.result.current.aggregate).toBeNull()
      expect(view.result.current.isLoading).toBe(false)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(15)

      await act(async () => {
        await view.result.current.refetch()
      })
      expect(fetcher).toHaveBeenCalledTimes(16)
      await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(true))

      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(18)
    } finally {
      view.unmount()
      queryClient.clear()
      jest.useRealTimers()
    }
  })
})

function recordsResponse(data: RecordsPage): ApiSuccessResponse<RecordsPage> {
  return { success: true, data }
}

function recordsPage(overrides: Partial<RecordsPage> = {}): RecordsPage {
  return {
    rows: [],
    nextCursor: null,
    provenance: {
      source: 'gmx',
      sourceAsOf: null,
      observedAt: '2026-07-29T12:00:00.000Z',
      publishedAt: null,
    },
    cacheState: 'warm',
    ...overrides,
  }
}

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

function recordsWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const HISTORY_KINDS = ['position_history'] as const

describe.each(HISTORY_KINDS)('useTraderRecords %s completeness', (kind) => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['cold-fetched', 'partial', 'interactive_preview'],
    ['warm', 'unknown', 'history_evidence_not_bound'],
    ['pending', 'unknown', 'history_evidence_not_bound'],
  ] as const)(
    'fails closed for a legacy %s page without metadata',
    async (cacheState, state, reason) => {
      ;(fetcher as jest.Mock).mockResolvedValue(recordsResponse(recordsPage({ cacheState })))
      const client = queryClient()
      const view = renderHook(
        () =>
          useTraderRecords({
            source: 'gmx',
            exchangeTraderId: 'trader-a',
            kind,
            enabled: true,
          }),
        { wrapper: recordsWrapper(client) }
      )

      await waitFor(() => expect(view.result.current.completeness?.state).toBe(state))
      expect(view.result.current.completeness?.reason).toBe(reason)

      view.unmount()
      client.clear()
    }
  )

  it('combines every page with unknown weaker than partial and complete', async () => {
    ;(fetcher as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('cursor=page-3')) {
        return Promise.resolve(recordsResponse(recordsPage()))
      }
      if (url.includes('cursor=page-2')) {
        return Promise.resolve(
          recordsResponse(
            recordsPage({
              nextCursor: 'page-3',
              completeness: {
                state: 'complete',
                reason: 'verified_terminal_history',
              },
            })
          )
        )
      }
      return Promise.resolve(
        recordsResponse(
          recordsPage({
            nextCursor: 'page-2',
            completeness: {
              state: 'complete',
              reason: 'verified_terminal_history',
              evidenceState: 'verified',
              scanTerminalState: 'exhausted',
              blockerReasons: [],
            },
          })
        )
      )
    })
    const client = queryClient()
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind,
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    await waitFor(() => expect(view.result.current.completeness?.state).toBe('complete'))
    await act(async () => {
      await view.result.current.fetchNextPage()
    })
    await waitFor(() => expect(view.result.current.completeness?.state).toBe('complete'))
    await act(async () => {
      await view.result.current.fetchNextPage()
    })
    await waitFor(() => expect(view.result.current.completeness?.state).toBe('unknown'))

    view.unmount()
    client.clear()
  })

  it('does not let a later complete page upgrade an unknown first page', async () => {
    ;(fetcher as jest.Mock).mockImplementation((url: string) =>
      Promise.resolve(
        recordsResponse(
          url.includes('cursor=verified')
            ? recordsPage({
                completeness: {
                  state: 'complete',
                  reason: 'verified_terminal_history',
                },
              })
            : recordsPage({ nextCursor: 'verified' })
        )
      )
    )
    const client = queryClient()
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind,
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    await waitFor(() => expect(view.result.current.completeness?.state).toBe('unknown'))
    await act(async () => {
      await view.result.current.fetchNextPage()
    })
    expect(view.result.current.completeness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })

    view.unmount()
    client.clear()
  })
})

describe('useTraderRecords completeness isolation', () => {
  beforeEach(() => jest.clearAllMocks())

  it('always returns null completeness for a current-position snapshot', async () => {
    const kind = 'positions' as const
    const completeness = {
      state: 'partial',
      reason: 'interactive_preview',
    } as HistoryCompleteness
    ;(fetcher as jest.Mock).mockResolvedValue(
      recordsResponse(recordsPage({ cacheState: 'cold-fetched', completeness }))
    )
    const client = queryClient()
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind,
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(view.result.current.completeness).toBeNull()

    view.unmount()
    client.clear()
  })

  it.each([
    ['orders', 'warm', 'unknown', 'history_evidence_not_bound'],
    ['orders', 'cold-fetched', 'partial', 'interactive_preview'],
    ['transfers', 'warm', 'unknown', 'history_evidence_not_bound'],
    ['transfers', 'cold-fetched', 'partial', 'interactive_preview'],
  ] as const)(
    'fails closed for append-only %s with legacy %s metadata',
    async (kind, cacheState, state, reason) => {
      ;(fetcher as jest.Mock).mockResolvedValue(recordsResponse(recordsPage({ cacheState })))
      const client = queryClient()
      const view = renderHook(
        () =>
          useTraderRecords({
            source: 'gmx',
            exchangeTraderId: 'trader-a',
            kind,
            enabled: true,
          }),
        { wrapper: recordsWrapper(client) }
      )

      await waitFor(() => expect(view.result.current.completeness?.state).toBe(state))
      expect(view.result.current.completeness?.reason).toBe(reason)

      view.unmount()
      client.clear()
    }
  )

  it('hides cached warm history rows and pagination without a complete verdict', async () => {
    ;(fetcher as jest.Mock).mockResolvedValue(
      recordsResponse(
        recordsPage({
          rows: [{ id: 'legacy-row' }],
          nextCursor: 'legacy-cursor',
          completeness: { state: 'unknown', reason: 'history_evidence_not_bound' },
        })
      )
    )
    const client = queryClient()
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'position_history',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    await waitFor(() => expect(view.result.current.isLoading).toBe(false))
    expect(view.result.current.rows).toEqual([])
    expect(view.result.current.hasNextPage).toBe(false)
    expect(view.result.current.completeness?.state).toBe('unknown')

    view.unmount()
    client.clear()
  })

  it('clears completeness while a new subject is loading', async () => {
    const pendingB = deferred<ApiSuccessResponse<RecordsPage>>()
    ;(fetcher as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/trader-a/')) {
        return Promise.resolve(
          recordsResponse(
            recordsPage({
              completeness: {
                state: 'complete',
                reason: 'verified_terminal_history',
              },
            })
          )
        )
      }
      return pendingB.promise
    })
    const client = queryClient()
    const view = renderHook(
      ({ exchangeTraderId }) =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId,
          kind: 'position_history',
          enabled: true,
        }),
      {
        initialProps: { exchangeTraderId: 'trader-a' },
        wrapper: recordsWrapper(client),
      }
    )

    await waitFor(() => expect(view.result.current.completeness?.state).toBe('complete'))
    view.rerender({ exchangeTraderId: 'trader-b' })

    expect(view.result.current.completeness).toBeNull()
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => {
      pendingB.resolve(recordsResponse(recordsPage()))
      await pendingB.promise
    })
    await waitFor(() => expect(view.result.current.completeness?.state).toBe('unknown'))

    view.unmount()
    client.clear()
  })
})

describe('useTraderRecords provenance aggregation', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each(['orders', 'transfers'] as const)(
    'aggregates every %s page without allowing later pages to upgrade trust',
    async (kind) => {
      ;(fetcher as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('cursor=page-3')) {
          return Promise.resolve(recordsResponse(recordsPage()))
        }
        if (url.includes('cursor=page-2')) {
          return Promise.resolve(
            recordsResponse(
              recordsPage({
                nextCursor: 'page-3',
                completeness: { state: 'partial', reason: 'interactive_preview' },
              })
            )
          )
        }
        return Promise.resolve(
          recordsResponse(
            recordsPage({
              nextCursor: 'page-2',
              completeness: {
                state: 'complete',
                reason: 'verified_terminal_history',
                evidenceState: 'verified',
                scanTerminalState: 'exhausted',
                blockerReasons: [],
              },
            })
          )
        )
      })
      const client = queryClient()
      const view = renderHook(
        () =>
          useTraderRecords({
            source: 'gmx',
            exchangeTraderId: 'trader-a',
            kind,
            enabled: true,
          }),
        { wrapper: recordsWrapper(client) }
      )

      await waitFor(() => expect(view.result.current.completeness?.state).toBe('complete'))
      await act(async () => {
        await view.result.current.fetchNextPage()
      })
      await waitFor(() => expect(view.result.current.completeness?.state).toBe('partial'))
      await act(async () => {
        await view.result.current.fetchNextPage()
      })
      await waitFor(() => expect(view.result.current.completeness?.state).toBe('unknown'))

      view.unmount()
      client.clear()
    }
  )

  it('uses the oldest complete clock and never lets a later page fill a missing clock', async () => {
    ;(fetcher as jest.Mock).mockImplementation((url: string) =>
      Promise.resolve(
        recordsResponse(
          url.includes('cursor=next')
            ? recordsPage({
                provenance: {
                  source: 'gmx',
                  sourceAsOf: null,
                  observedAt: '2026-07-29T11:00:00.000Z',
                  publishedAt: '2026-07-29T12:06:00.000Z',
                },
              })
            : recordsPage({
                nextCursor: 'next',
                provenance: {
                  source: 'gmx',
                  sourceAsOf: '2026-07-29T11:30:00.000Z',
                  observedAt: '2026-07-29T12:00:00.000Z',
                  publishedAt: '2026-07-29T12:05:00.000Z',
                },
              })
        )
      )
    )
    const client = queryClient()
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    await waitFor(() =>
      expect(view.result.current.provenance).toEqual({
        source: 'gmx',
        sourceAsOf: '2026-07-29T11:30:00.000Z',
        observedAt: '2026-07-29T12:00:00.000Z',
        publishedAt: '2026-07-29T12:05:00.000Z',
      })
    )
    await act(async () => {
      await view.result.current.fetchNextPage()
    })
    await waitFor(() =>
      expect(view.result.current.provenance).toEqual({
        source: 'gmx',
        sourceAsOf: null,
        observedAt: '2026-07-29T11:00:00.000Z',
        publishedAt: '2026-07-29T12:05:00.000Z',
      })
    )

    view.unmount()
    client.clear()
  })
})

describe('useTraderRecords cursor generation reset', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rebuilds the full chain once when a legacy cursor is invalidated', async () => {
    let firstPageReads = 0
    ;(fetcher as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('cursor=legacy-cursor')) {
        const error = Object.assign(new Error('request failed'), {
          status: 409,
          info: {
            success: false,
            error: {
              code: 'records_cursor_invalidated',
              resetRequired: true,
            },
          },
        })
        return Promise.reject(error)
      }
      if (url.includes('cursor=verified-cursor')) {
        return Promise.resolve(
          recordsResponse(
            recordsPage({
              rows: [{ id: 'verified-2' }],
              completeness: {
                state: 'complete',
                reason: 'verified_terminal_history',
              },
            })
          )
        )
      }

      firstPageReads += 1
      return Promise.resolve(
        recordsResponse(
          firstPageReads === 1
            ? recordsPage({
                rows: [{ id: 'legacy-1' }],
                nextCursor: 'legacy-cursor',
                completeness: {
                  state: 'complete',
                  reason: 'verified_terminal_history',
                },
              })
            : recordsPage({
                rows: [{ id: 'verified-1' }],
                nextCursor: 'verified-cursor',
                completeness: {
                  state: 'complete',
                  reason: 'verified_terminal_history',
                },
              })
        )
      )
    })
    const client = queryClient()
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'position_history',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    await waitFor(() => expect(view.result.current.rows).toEqual([{ id: 'legacy-1' }]))
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('records_contract=vph3'))
    await act(async () => {
      await view.result.current.fetchNextPage()
    })

    await waitFor(() => expect(view.result.current.rows).toEqual([{ id: 'verified-1' }]))
    expect(view.result.current.error).toBeNull()
    expect(
      (fetcher as jest.Mock).mock.calls.filter(([url]) =>
        String(url).includes('cursor=legacy-cursor')
      )
    ).toHaveLength(1)
    expect(
      (fetcher as jest.Mock).mock.calls.every(([url]) =>
        String(url).includes('records_contract=vph3')
      )
    ).toBe(true)

    await act(async () => {
      await view.result.current.fetchNextPage()
    })
    await waitFor(() =>
      expect(view.result.current.rows).toEqual([{ id: 'verified-1' }, { id: 'verified-2' }])
    )
    expect(view.result.current.rows).not.toContainEqual({ id: 'legacy-1' })

    view.unmount()
    client.clear()
  })

  it('classifies a first-page failure as an initial error with no rows to preserve', async () => {
    ;(fetcher as jest.Mock).mockRejectedValue(new Error('first page failed'))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.isInitialError).toBe(true))
    expect(view.result.current.rows).toEqual([])
    expect(view.result.current.isFetchNextPageError).toBe(false)
    // Hook policy is retry: 2, so the original request plus two retries fail.
    expect(fetcher).toHaveBeenCalledTimes(3)

    view.unmount()
    queryClient.clear()
  })

  it('preserves cached rows across a next-page failure and retries the same cursor', async () => {
    let failNextPage = true
    let nextPageAttempts = 0
    ;(fetcher as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('cursor=next')) {
        nextPageAttempts += 1
        if (failNextPage) return Promise.reject(new Error('next page failed'))
        return Promise.resolve(
          recordsResponse(recordsPage({ rows: [{ id: 'second' }], nextCursor: null }))
        )
      }
      return Promise.resolve(
        recordsResponse(recordsPage({ rows: [{ id: 'first' }], nextCursor: 'next' }))
      )
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.rows).toEqual([{ id: 'first' }]))
    await act(async () => {
      await view.result.current.fetchNextPage()
    })

    await waitFor(() => expect(view.result.current.isFetchNextPageError).toBe(true))
    expect(view.result.current.isInitialError).toBe(false)
    expect(view.result.current.rows).toEqual([{ id: 'first' }])
    expect(view.result.current.hasNextPage).toBe(true)
    expect(nextPageAttempts).toBe(3)

    failNextPage = false
    await act(async () => {
      await view.result.current.fetchNextPage()
    })

    await waitFor(() =>
      expect(view.result.current.rows).toEqual([{ id: 'first' }, { id: 'second' }])
    )
    expect(view.result.current.isFetchNextPageError).toBe(false)
    expect(nextPageAttempts).toBe(4)

    view.unmount()
    queryClient.clear()
  })

  it('preserves cached rows and exposes a background-refetch failure', async () => {
    let failRefresh = false
    ;(fetcher as jest.Mock).mockImplementation(() => {
      if (failRefresh) return Promise.reject(new Error('refresh failed'))
      return Promise.resolve(recordsResponse(recordsPage({ rows: [{ id: 'cached' }] })))
    })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity } },
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: Wrapper }
    )

    await waitFor(() => expect(view.result.current.rows).toEqual([{ id: 'cached' }]))
    failRefresh = true
    await act(async () => {
      await view.result.current.refetch()
    })

    await waitFor(() => expect(view.result.current.isRefetchError).toBe(true))
    expect(view.result.current.isInitialError).toBe(false)
    expect(view.result.current.isFetchNextPageError).toBe(false)
    expect(view.result.current.rows).toEqual([{ id: 'cached' }])

    failRefresh = false
    await act(async () => {
      await view.result.current.refetch()
    })
    await waitFor(() => expect(view.result.current.isRefetchError).toBe(false))
    expect(view.result.current.rows).toEqual([{ id: 'cached' }])

    view.unmount()
    queryClient.clear()
  })

  it('polls an explicit pending record bridge every two seconds and stops on data', async () => {
    jest.useFakeTimers()
    const client = queryClient()
    let reads = 0
    ;(fetcher as jest.Mock).mockImplementation(() => {
      reads += 1
      return Promise.resolve(
        recordsResponse(
          reads < 3
            ? recordsPage({ cacheState: 'pending' })
            : recordsPage({ rows: [{ id: 'collected' }] })
        )
      )
    })
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0)
      })
      expect(view.result.current.isPendingUpstream).toBe(true)
      expect(view.result.current.isPendingRecoveryRequired).toBe(false)
      expect(reads).toBe(1)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_000)
        await Promise.resolve()
      })
      expect(reads).toBe(3)
      await waitFor(() => expect(view.result.current.rows).toEqual([{ id: 'collected' }]))
      expect(view.result.current.isPendingUpstream).toBe(false)
      expect(view.result.current.isPendingRecoveryRequired).toBe(false)
    } finally {
      view.unmount()
      client.clear()
      jest.useRealTimers()
    }
  })

  it('turns a paused pending record bridge into an explicit recovery state', async () => {
    const client = queryClient()
    ;(fetcher as jest.Mock).mockResolvedValue(
      recordsResponse(recordsPage({ cacheState: 'pending' }))
    )
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    try {
      await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(true))
      await act(async () => {
        onlineManager.setOnline(false)
        void view.result.current.refetch()
        await Promise.resolve()
      })

      await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(false))
      expect(view.result.current.isPendingRecoveryRequired).toBe(true)
      expect(view.result.current.isInitialError).toBe(false)
    } finally {
      onlineManager.setOnline(true)
      view.unmount()
      client.clear()
    }
  })

  it('marks an offline first record read unavailable instead of empty', async () => {
    const client = queryClient()
    onlineManager.setOnline(false)
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    try {
      await waitFor(() => expect(view.result.current.isInitialError).toBe(true))
      expect(view.result.current.rows).toEqual([])
      expect(view.result.current.isLoading).toBe(false)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      onlineManager.setOnline(true)
      view.unmount()
      client.clear()
    }
  })

  it('caps a pending record bridge, exposes recovery, and restarts only on retry', async () => {
    jest.useFakeTimers()
    const client = queryClient()
    ;(fetcher as jest.Mock).mockResolvedValue(
      recordsResponse(recordsPage({ cacheState: 'pending' }))
    )
    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'orders',
          enabled: true,
        }),
      { wrapper: recordsWrapper(client) }
    )

    try {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(40_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(15)
      expect(view.result.current.isPendingUpstream).toBe(false)
      expect(view.result.current.isPendingRecoveryRequired).toBe(true)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(15)

      await act(async () => {
        await view.result.current.refetch()
      })
      expect(fetcher).toHaveBeenCalledTimes(16)
      await waitFor(() => expect(view.result.current.isPendingUpstream).toBe(true))
      expect(view.result.current.isPendingRecoveryRequired).toBe(false)

      await act(async () => {
        await jest.advanceTimersByTimeAsync(4_000)
      })
      expect(fetcher).toHaveBeenCalledTimes(18)
    } finally {
      view.unmount()
      client.clear()
      jest.useRealTimers()
    }
  })
})
