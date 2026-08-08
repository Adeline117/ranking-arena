import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { selectLiveSourceCapability, useSourceCapabilities } from '../useSourceCapabilities'
import { fetcher } from '@/lib/hooks/fetchers'
import type { SourceCapability } from '@/lib/data/serving/types'

jest.mock('@/lib/hooks/fetchers', () => ({ fetcher: jest.fn() }))

function capability(copiers: boolean, positions = true): SourceCapability {
  return {
    timeframes: { '7': 'native', '30': 'native', '90': 'native' },
    inceptionTf: false,
    metrics: ['roi'],
    surfaces: {
      positions,
      position_history: false,
      orders: false,
      transfers: false,
      copiers,
    },
    copierDepth: copiers ? 'full' : 'none',
    currency: 'USDT',
    isOnchain: false,
    derivedBoardNote: false,
    exchangeName: 'Test Exchange',
  }
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('useSourceCapabilities authority refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    onlineManager.setOnline(true)
  })

  afterEach(() => onlineManager.setOnline(true))

  it('uses the v2 query generation, direct route, and live refresh policy', async () => {
    ;(fetcher as jest.Mock).mockResolvedValue({
      success: true,
      data: { bitunix_futures: capability(true) },
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const view = renderHook(() => useSourceCapabilities(true), { wrapper: wrapper(client) })

    await waitFor(() => expect(view.result.current.capabilities).not.toBeNull())
    expect(fetcher).toHaveBeenCalledWith('/api/sources/capabilities')

    const query = client.getQueryCache().find({
      queryKey: ['source-capabilities', 'serving-metric-authority-v2'],
      exact: true,
    })
    expect(query).toBeDefined()
    expect(query?.options).toMatchObject({
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: 'always',
      refetchInterval: 15_000,
      gcTime: 0,
    })

    view.unmount()
    client.clear()
  })

  it('always prefers a live source value over an SSR seed', () => {
    const seed = capability(true)
    const live = capability(false, false)

    expect(selectLiveSourceCapability('bitunix_futures', { bitunix_futures: live }, seed)).toBe(
      live
    )
  })

  it('preserves only non-copier seed surfaces while the live read is unavailable', () => {
    const seed = capability(true)
    const selected = selectLiveSourceCapability('bitunix_futures', null, seed)

    expect(selected).not.toBe(seed)
    expect(selected?.surfaces).toEqual({
      positions: true,
      position_history: false,
      orders: false,
      transfers: false,
      copiers: false,
    })
    expect(seed.surfaces.copiers).toBe(true)
  })

  it('revokes stale live copier authority when a background refresh fails', async () => {
    const seed = capability(true)
    let failRefresh = false
    ;(fetcher as jest.Mock).mockImplementation(() =>
      failRefresh
        ? Promise.reject(new Error('authority refresh failed'))
        : Promise.resolve({
            success: true,
            data: { bitunix_futures: capability(true) },
          })
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const view = renderHook(() => useSourceCapabilities(true), { wrapper: wrapper(client) })

    await waitFor(() =>
      expect(view.result.current.capabilities?.bitunix_futures.surfaces.copiers).toBe(true)
    )

    failRefresh = true
    await act(async () => {
      await client.refetchQueries({
        queryKey: ['source-capabilities', 'serving-metric-authority-v2'],
        exact: true,
      })
    })

    await waitFor(() => expect(view.result.current.capabilities).toBeNull())
    expect(
      selectLiveSourceCapability('bitunix_futures', view.result.current.capabilities, seed)
        ?.surfaces.copiers
    ).toBe(false)

    view.unmount()
    client.clear()
  })

  it('does not authorize a cached matrix while a new mount revalidates it', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const key = ['source-capabilities', 'serving-metric-authority-v2']
    client.setQueryData(key, { bitunix_futures: capability(true) })
    let resolveFresh!: (value: { success: true; data: Record<string, SourceCapability> }) => void
    const fresh = new Promise<{
      success: true
      data: Record<string, SourceCapability>
    }>((resolve) => {
      resolveFresh = resolve
    })
    ;(fetcher as jest.Mock).mockReturnValue(fresh)

    const view = renderHook(() => useSourceCapabilities(true), { wrapper: wrapper(client) })

    expect(view.result.current.capabilities).toBeNull()
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => {
      resolveFresh({
        success: true,
        data: { bitunix_futures: capability(false) },
      })
      await fresh
    })
    await waitFor(() =>
      expect(view.result.current.capabilities?.bitunix_futures.surfaces.copiers).toBe(false)
    )

    view.unmount()
    client.clear()
  })

  it('drops live copier authority while an offline refresh is paused', async () => {
    ;(fetcher as jest.Mock).mockResolvedValue({
      success: true,
      data: { bitunix_futures: capability(true) },
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    const view = renderHook(() => useSourceCapabilities(true), { wrapper: wrapper(client) })

    await waitFor(() =>
      expect(view.result.current.capabilities?.bitunix_futures.surfaces.copiers).toBe(true)
    )

    await act(async () => {
      onlineManager.setOnline(false)
      void view.result.current.refetch()
      await Promise.resolve()
    })
    await waitFor(() => expect(view.result.current.capabilities).toBeNull())
    expect(view.result.current.isLoading).toBe(true)

    await act(async () => {
      onlineManager.setOnline(true)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(view.result.current.capabilities?.bitunix_futures.surfaces.copiers).toBe(true)
    )

    view.unmount()
    client.clear()
  })

  it('never returns cached authority while disabled', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    client.setQueryData(['source-capabilities', 'serving-metric-authority-v2'], {
      bitunix_futures: capability(true),
    })

    const view = renderHook(() => useSourceCapabilities(false), { wrapper: wrapper(client) })

    expect(view.result.current.capabilities).toBeNull()
    expect(view.result.current.isLoading).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()

    view.unmount()
    client.clear()
  })
})
