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
import { STALE_REALTIME, REFETCH_REALTIME } from './cache-presets'
import {
  fetchMarketSpot,
  type CompleteMarketSpotCoin,
  type MarketSpotSnapshot,
} from '@/lib/market/market-spot-client-contract'

export type SpotCoin = CompleteMarketSpotCoin

/**
 * @param initialSnapshot SSR-fetched spot coins and their provider receipt.
 *   When provided, it seeds React Query so the hook does NOT immediately refetch
 *   the same ~33KB/100-coin dataset on mount — the SSR already delivered it.
 */
export function useMarketSpotData(initialSnapshot?: MarketSpotSnapshot) {
  const hasSeed = !!initialSnapshot?.coins.length
  return useQuery<MarketSpotSnapshot>({
    queryKey: ['market-spot'],
    placeholderData: (prev) => prev,
    queryFn: ({ signal }) => fetchMarketSpot(signal),
    refetchInterval: REFETCH_REALTIME,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: STALE_REALTIME,
    ...(hasSeed
      ? {
          initialData: initialSnapshot,
          initialDataUpdatedAt: Date.parse(initialSnapshot.collectedAt),
        }
      : {}),
  })
}
