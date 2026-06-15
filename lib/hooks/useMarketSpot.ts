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
 *   Marked fresh-as-of-now so the first background refetch waits out staleTime.
 */
export function useMarketSpotData(initialData?: SpotCoin[]) {
  const hasSeed = !!initialData && initialData.length > 0
  return useQuery<SpotCoin[]>({
    queryKey: ['market-spot'],
    placeholderData: (prev) => prev,
    queryFn: () => fetcher<SpotCoin[]>('/api/market/spot'),
    refetchInterval: REFETCH_REALTIME,
    refetchOnWindowFocus: false,
    staleTime: STALE_REALTIME,
    ...(hasSeed ? { initialData, initialDataUpdatedAt: () => Date.now() } : {}),
  })
}
