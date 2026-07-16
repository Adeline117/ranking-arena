import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTraderCore } from '../useTraderCore'
import { fetcher } from '@/lib/hooks/fetchers'
import type { ApiSuccessResponse } from '@/lib/types/index'
import type { TraderCoreModules, TraderCoreResponse } from '@/lib/data/serving/types'

jest.mock('@/lib/hooks/fetchers', () => ({ fetcher: jest.fn() }))

function modules(timeframe: 30 | 90, pnl: number): TraderCoreModules {
  return {
    timeframe,
    stats: { pnl },
    currency: 'USD',
    series: {},
    extras: {},
    provenance: { source: 'gmx', asOf: '2026-07-15T01:00:00.000Z' },
    cacheState: 'warm',
  }
}

function response(data: TraderCoreResponse): ApiSuccessResponse<TraderCoreResponse> {
  return { success: true, data }
}

describe('useTraderCore timeframe identity', () => {
  it('never exposes the previous timeframe while a cold selection is loading', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const mockFetcher = fetcher as jest.Mock
    mockFetcher.mockResolvedValueOnce(response(modules(90, 900)))

    let resolve30!: (value: ApiSuccessResponse<TraderCoreResponse>) => void
    const pending30 = new Promise<ApiSuccessResponse<TraderCoreResponse>>((resolve) => {
      resolve30 = resolve
    })
    mockFetcher.mockReturnValueOnce(pending30)

    function Wrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }

    const { result, rerender, unmount } = renderHook(
      ({ tf }: { tf: 30 | 90 }) => useTraderCore({ source: 'gmx', exchangeTraderId: '0x123', tf }),
      { initialProps: { tf: 90 as 30 | 90 }, wrapper: Wrapper }
    )

    await waitFor(() => expect(result.current.modules?.timeframe).toBe(90))
    expect(result.current.modules?.stats.pnl).toBe(900)

    rerender({ tf: 30 })

    expect(result.current.modules).toBeNull()

    await act(async () => {
      resolve30(response(modules(30, 300)))
      await pending30
    })
    await waitFor(() => expect(result.current.modules?.timeframe).toBe(30))
    expect(result.current.modules?.stats.pnl).toBe(300)

    unmount()
    queryClient.clear()
  })
})
