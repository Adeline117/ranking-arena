'use client'

/**
 * useSourceCapabilities — client-side consumption of the per-source
 * capability matrix (spec §6). Source authority can change independently of
 * an ISR page, so serving clients keep this projection live and treat an SSR
 * value as a non-copier first-paint seed only.
 */

import { useQuery } from '@tanstack/react-query'
import { fetcher } from '@/lib/hooks/fetchers'
import { SERVING_METRIC_AUTHORITY_CACHE_EPOCH } from '@/lib/data/serving/cache-policy'
import type { SourceCapability } from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

export function selectLiveSourceCapability(
  source: string,
  liveCapabilities: Record<string, SourceCapability> | null,
  serverSeed: SourceCapability | null | undefined
): SourceCapability | null {
  if (
    liveCapabilities &&
    Object.prototype.hasOwnProperty.call(liveCapabilities, source) &&
    liveCapabilities[source]
  ) {
    return liveCapabilities[source]
  }
  if (!serverSeed) return null

  // An ISR seed can preserve non-copier tabs while the request-scoped read is
  // loading or unavailable, but it can never authorize the privacy-sensitive
  // copier surface. Only the live @1 authority marker mapper may do that.
  return {
    ...serverSeed,
    surfaces: { ...serverSeed.surfaces, copiers: false },
  }
}

export function useSourceCapabilities(enabled = true) {
  const query = useQuery<Record<string, SourceCapability>>({
    queryKey: ['source-capabilities', SERVING_METRIC_AUTHORITY_CACHE_EPOCH],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<Record<string, SourceCapability>>>(
        '/api/sources/capabilities'
      )
      return res.data
    },
    enabled,
    staleTime: 0,
    gcTime: 60 * 60 * 1000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })

  return {
    // A background refetch error cannot preserve a formerly authorized
    // copiers=true value indefinitely. Drop the live matrix on any current
    // query error; TraderProfileClient then falls back to its copier-stripped
    // server seed until a later successful read restores authority.
    capabilities: query.isError ? null : (query.data ?? null),
    isLoading: query.isLoading,
    error: query.error,
  }
}
