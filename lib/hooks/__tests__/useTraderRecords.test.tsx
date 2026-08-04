import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
})
