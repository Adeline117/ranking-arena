'use client'

import { useQuery } from '@tanstack/react-query'
import { buildProductFactsSnapshot, type ProductFactsSnapshot } from '@/lib/config/product-facts'

interface HeroStatsResponse {
  sourceBoardCount?: number
  /** Deprecated compatibility field from older deployments. */
  exchangeCount?: number
  traderCount?: number
  isDefault?: boolean
}

/** Shared client-side view of the trust-sensitive product facts. */
export function useProductFacts(): ProductFactsSnapshot {
  const { data } = useQuery<HeroStatsResponse>({
    queryKey: ['product-facts'],
    queryFn: async () => {
      const response = await fetch('/api/hero-stats')
      if (!response.ok) throw new Error('Unable to load product facts')
      return response.json() as Promise<HeroStatsResponse>
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  })

  return buildProductFactsSnapshot({
    ...data,
    sourceBoardCount: data?.sourceBoardCount ?? data?.exchangeCount,
  })
}
