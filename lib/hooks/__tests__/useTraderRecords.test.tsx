import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useCopierAggregate } from '../useTraderRecords'
import { fetcher } from '@/lib/hooks/fetchers'
import type { CopierAggregate } from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

jest.mock('@/lib/hooks/fetchers', () => ({ fetcher: jest.fn() }))

function aggregate(source: string, copierCount: number): CopierAggregate {
  return {
    copierCount,
    copierCountMax: copierCount,
    totalCopierPnl: null,
    pnlDistribution: [],
    depth: 'full',
    provenance: { source, asOf: '2026-07-29T12:00:00.000Z' },
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
