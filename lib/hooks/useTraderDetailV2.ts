/**
 * Legacy hook for the platform/key trader-detail API.
 *
 * It remains a read-only compatibility client. V1 does not admit legacy
 * refresh jobs, so this hook neither posts a refresh request nor polls queue
 * state after a user action.
 */

'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { STALE_SLOW } from './cache-presets'
import {
  isV1LegacyRefreshJobsPublished,
  V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE,
} from '@/lib/ingest/v1-legacy-refresh-jobs-publication'
import type { Platform, RefreshResponse, TraderDetailResponse } from '@/lib/types/trading-platform'

const FETCH_TIMEOUT_MS = 15_000

const fetcher = async (url: string): Promise<TraderDetailResponse> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Network error' }))
    throw new Error(error.error || `HTTP ${res.status}`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error('Invalid response format')
  }
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface UseTraderDetailV2Options {
  platform: Platform
  traderKey: string
  /** Retained for compatibility; V1 does not automatically refetch this legacy detail view. */
  refreshInterval?: number
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface UseTraderDetailV2Result {
  data: TraderDetailResponse | undefined
  error: Error | undefined
  isLoading: boolean
  isValidating: boolean
  /** Whether data is stale (older than threshold) */
  isStale: boolean
  /** Fixed V1 unavailable result; this never creates a background job. */
  triggerRefresh: () => Promise<RefreshResponse | null>
  /** Always false because V1 does not start refresh work. */
  isRefreshing: boolean
  /** Refresh unavailability message after an attempted legacy action. */
  refreshError: string | null
  /** Invalidate the local query cache. */
  mutate: () => void
}

export function useTraderDetailV2({
  platform,
  traderKey,
}: UseTraderDetailV2Options): UseTraderDetailV2Result {
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const queryKey = useMemo(() => ['trader-detail-v2', platform, traderKey], [platform, traderKey])

  const {
    data,
    error,
    isLoading,
    isFetching: isValidating,
  } = useQuery<TraderDetailResponse>({
    queryKey,
    placeholderData: (prev) => prev,
    queryFn: () => fetcher(`/api/trader/${platform}/${traderKey}`),
    enabled: !!traderKey,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: STALE_SLOW,
    retry: false,
  })

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey })
  }, [queryClient, queryKey])

  const triggerRefresh = useCallback(async (): Promise<RefreshResponse | null> => {
    if (!isV1LegacyRefreshJobsPublished()) {
      setRefreshError(V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE)
      return null
    }

    // Reopening requires a separately reviewed request and completion contract.
    setRefreshError(V1_LEGACY_REFRESH_JOBS_NOT_PUBLISHED_CODE)
    return null
  }, [])

  return {
    data,
    error: error as Error | undefined,
    isLoading,
    isValidating,
    isStale: data?.is_stale ?? false,
    triggerRefresh,
    isRefreshing: false,
    refreshError,
    mutate: invalidate,
  }
}
