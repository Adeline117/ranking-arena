'use client'

/**
 * useMarketSpotData — single SWR hook for /api/market/spot
 *
 * All market-page components that need spot data should receive it as props
 * from the parent (MarketPageClient), which calls this hook once.
 * This eliminates 3-4 duplicate fetches that were hitting the same endpoint.
 *
 * PriceTicker keeps its own SWR because it is used outside the market page.
 */

import useSWR from 'swr'
import { fetcher } from './useSWR'

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
  return useSWR<SpotCoin[]>(
    '/api/market/spot',
    fetcher,
    {
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      dedupingInterval: 10_000,
    },
  )
}
