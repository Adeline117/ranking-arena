/**
 * Hook for fetching rankings from the new /api/rankings endpoint.
 * Supports window switching via URL query params.
 */

'use client'

import useSWR from 'swr'
import { useMemo } from 'react'
import type {
  RankingsResponse,
  SnapshotWindow,
  Platform,
} from '@/lib/types/trading-platform'

const fetcher = async (url: string): Promise<RankingsResponse> => {
  const res = await fetch(url)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Network error' }))
    throw new Error(error.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export interface UseRankingsV2Options {
  window?: SnapshotWindow
  platform?: Platform
  sortBy?: 'arena_score' | 'roi' | 'pnl' | 'win_rate' | 'max_drawdown'
  sortDir?: 'asc' | 'desc'
  limit?: number
  offset?: number
  /** Auto-refresh interval in ms (default: 60000 = 1 min) */
  refreshInterval?: number
}

export interface UseRankingsV2Result {
  data: RankingsResponse | undefined
  error: Error | undefined
  isLoading: boolean
  isValidating: boolean
  isStale: boolean
  mutate: () => void
}

export function useRankingsV2(options: UseRankingsV2Options = {}): UseRankingsV2Result {
  const {
    window = '90D',
    platform,
    sortBy = 'arena_score',
    sortDir = 'desc',
    limit = 1000,
    offset = 0,
    refreshInterval = 60000,
  } = options

  const url = useMemo(() => {
    const params = new URLSearchParams()
    params.set('window', window)
    if (platform) params.set('platform', platform)
    params.set('sort_by', sortBy)
    params.set('sort_dir', sortDir)
    params.set('limit', String(limit))
    if (offset > 0) params.set('offset', String(offset))
    return `/api/rankings?${params.toString()}`
  }, [window, platform, sortBy, sortDir, limit, offset])

  const { data, error, isLoading, isValidating, mutate } = useSWR<RankingsResponse>(
    url,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 30000,
      errorRetryCount: 2,
    }
  )

  return {
    data,
    error,
    isLoading,
    isValidating,
    isStale: data?.is_stale ?? false,
    mutate: () => mutate(),
  }
}
