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
import { STALE_REALTIME } from './cache-presets'

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

export function useMarketSpotData() {
  return useQuery<SpotCoin[]>({
    queryKey: ['market-spot'],
    placeholderData: (prev) => prev,
    queryFn: () => fetcher<SpotCoin[]>('/api/market/spot'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    staleTime: STALE_REALTIME,
  })
}
