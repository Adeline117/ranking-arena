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

    view.rerender({ source: 'hyperliquid_perp', exchangeTraderId: 'trader-b' })

    expect(view.result.current.aggregate).toBeNull()
    expect(view.result.current.isPendingUpstream).toBe(false)
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => {
      pendingB.resolve(response(aggregate('hyperliquid_perp', 3)))
      await pendingB.promise
    })
    await waitFor(() => expect(view.result.current.aggregate?.copierCount).toBe(3))

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

const HISTORY_KINDS = ['position_history', 'orders', 'transfers'] as const

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

  it.each([
    undefined,
    { state: 'partial', reason: 'interactive_preview' } as HistoryCompleteness,
    {
      state: 'complete',
      reason: 'verified_terminal_history',
    } as HistoryCompleteness,
  ])(
    'always returns null for positions, regardless of history metadata %#',
    async (completeness) => {
      ;(fetcher as jest.Mock).mockResolvedValue(
        recordsResponse(recordsPage({ cacheState: 'cold-fetched', completeness }))
      )
      const client = queryClient()
      const view = renderHook(
        () =>
          useTraderRecords({
            source: 'gmx',
            exchangeTraderId: 'trader-a',
            kind: 'positions',
            enabled: true,
          }),
        { wrapper: recordsWrapper(client) }
      )

      await waitFor(() => expect(view.result.current.isLoading).toBe(false))
      expect(view.result.current.completeness).toBeNull()

      view.unmount()
      client.clear()
    }
  )

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
          kind: 'orders',
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
