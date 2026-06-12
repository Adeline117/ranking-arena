'use client'

/**
 * useSourceCapabilities — client-side consumption of the per-source
 * capability matrix (spec §6). Near-static data: long stale time, no
 * window-focus refetch. SSR paths read the RPC directly; this hook is for
 * client islands that need capabilities without a server prop (e.g.
 * rankings filters, exchange pages).
 */

import { useQuery } from '@tanstack/react-query'
import { fetcher } from '@/lib/hooks/fetchers'
import { STALE_STATIC } from '@/lib/hooks/cache-presets'
import type { SourceCapability } from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

export function useSourceCapabilities(enabled = true) {
  const query = useQuery<Record<string, SourceCapability>>({
    queryKey: ['source-capabilities'],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<Record<string, SourceCapability>>>(
        '/api/sources/capabilities'
      )
      return res.data
    },
    enabled,
    staleTime: STALE_STATIC,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  })

  return {
    capabilities: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  }
}
