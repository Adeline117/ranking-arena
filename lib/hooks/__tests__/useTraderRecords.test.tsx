import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCopierAggregate, useTraderRecords } from '../useTraderRecords'
import { fetcher } from '@/lib/hooks/fetchers'
import type { CopierAggregate, RecordsPage } from '@/lib/data/serving/types'
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

describe('useTraderRecords history completeness', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['cold-fetched', 'partial', 'interactive_preview'],
    ['warm', 'unknown', 'history_evidence_not_bound'],
    ['pending', 'unknown', 'history_evidence_not_bound'],
  ] as const)(
    'fails closed for a legacy %s page without completeness metadata',
    async (cacheState, state, reason) => {
      ;(fetcher as jest.Mock).mockResolvedValue(recordsResponse(recordsPage({ cacheState })))
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      })

      function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      }

      const view = renderHook(
        () =>
          useTraderRecords({
            source: 'gmx',
            exchangeTraderId: 'trader-a',
            kind: 'position_history',
            enabled: true,
          }),
        { wrapper: Wrapper }
      )

      await waitFor(() => expect(view.result.current.completeness?.state).toBe(state))
      expect(view.result.current.completeness?.reason).toBe(reason)

      view.unmount()
      queryClient.clear()
    }
  )

  it('aggregates every page without allowing later pages to upgrade trust', async () => {
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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const view = renderHook(
      () =>
        useTraderRecords({
          source: 'gmx',
          exchangeTraderId: 'trader-a',
          kind: 'position_history',
          enabled: true,
        }),
      { wrapper: Wrapper }
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
    queryClient.clear()
  })

  it('aggregates page clocks conservatively without a later-page freshness upgrade', async () => {
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
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
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

    await waitFor(() => expect(view.result.current.provenance?.sourceAsOf).not.toBeNull())
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
    queryClient.clear()
  })
})
