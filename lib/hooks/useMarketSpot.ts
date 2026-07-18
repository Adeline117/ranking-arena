'use client'

/**
 * useMarketSpotData — single React Query hook for /api/market/spot
 *
 * All market-page components that need spot data should receive it as props
 * from the parent (MarketPageClient), which calls this hook once.
 * This eliminates 3-4 duplicate fetches that were hitting the same endpoint.
 *
 * PriceTicker keeps its own useQuery because it is used outside the market page.
 */

import { useQuery } from '@tanstack/react-query'
import { fetcher } from './fetchers'
import { STALE_REALTIME, REFETCH_REALTIME } from './cache-presets'

export interface SpotCoin {
  id: string
  symbol: string
  name: string
  image: string
  price: number
  change1h?: number
  change24h: number
  change7d?: number
  high24h: number
  low24h: number
  volume24h: number
  marketCap: number
  rank: number
}

/**
 * @param initialData SSR-fetched spot coins (from page.tsx getSpotMarketData).
 *   When provided, it seeds React Query so the hook does NOT immediately refetch
 *   the same ~33KB/100-coin dataset on mount — the SSR already delivered it.
 * @param initialDataUpdatedAt Epoch milliseconds captured with the SSR payload.
 *   This must not be Date.now() at render time: the server and browser render at
 *   different moments, and cached SSR data may already be older than staleTime.
 */
export function useMarketSpotData(initialData?: SpotCoin[], initialDataUpdatedAt?: number) {
  const hasSeed = !!initialData && initialData.length > 0
  return useQuery<SpotCoin[]>({
    queryKey: ['market-spot'],
    placeholderData: (prev) => prev,
    queryFn: () => fetcher<SpotCoin[]>('/api/market/spot'),
    refetchInterval: REFETCH_REALTIME,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: STALE_REALTIME,
    ...(hasSeed
      ? {
          initialData,
          // Unknown collection time is deliberately stale rather than being
          // relabeled as freshly fetched during each render.
          initialDataUpdatedAt: initialDataUpdatedAt ?? 0,
        }
      : {}),
  })
}
