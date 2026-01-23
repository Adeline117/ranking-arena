/**
 * Hook for fetching trader details from the new /api/trader/:platform/:trader_key endpoint.
 * Provides loading/error/stale states and refresh capability.
 */

'use client'

import useSWR from 'swr'
import { useState, useCallback } from 'react'
import type {
  TraderDetailResponse,
  RefreshResponse,
  Platform,
} from '@/lib/types/trading-platform'

const fetcher = async (url: string): Promise<TraderDetailResponse> => {
  const res = await fetch(url)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Network error' }))
    throw new Error(error.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export interface UseTraderDetailV2Options {
  platform: Platform
  traderKey: string
  /** SWR refresh interval in ms (default: 0 = no auto-refresh) */
  refreshInterval?: number
}

export interface UseTraderDetailV2Result {
  data: TraderDetailResponse | undefined
  error: Error | undefined
  isLoading: boolean
  isValidating: boolean
  /** Whether data is stale (older than threshold) */
  isStale: boolean
  /** Trigger a background refresh job */
  triggerRefresh: () => Promise<RefreshResponse | null>
  /** Whether refresh is in progress */
  isRefreshing: boolean
  /** Refresh error message */
  refreshError: string | null
  /** Mutate SWR cache */
  mutate: () => void
}

export function useTraderDetailV2({
  platform,
  traderKey,
  refreshInterval = 0,
}: UseTraderDetailV2Options): UseTraderDetailV2Result {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)

  const url = traderKey ? `/api/trader/${platform}/${traderKey}` : null

  const { data, error, isLoading, isValidating, mutate } = useSWR<TraderDetailResponse>(
    url,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 10000,
      errorRetryCount: 2,
    }
  )

  const triggerRefresh = useCallback(async (): Promise<RefreshResponse | null> => {
    if (!traderKey || isRefreshing) return null

    setIsRefreshing(true)
    setRefreshError(null)

    try {
      const res = await fetch(`/api/trader/${platform}/${traderKey}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_type: 'full_refresh', priority: 1 }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      const result: RefreshResponse = await res.json()

      // Poll for completion (check every 5s, max 60s)
      if (result.created) {
        pollForCompletion(platform, traderKey, mutate)
      }

      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed'
      setRefreshError(msg)
      return null
    } finally {
      setIsRefreshing(false)
    }
  }, [platform, traderKey, isRefreshing, mutate])

  return {
    data,
    error,
    isLoading,
    isValidating,
    isStale: data?.is_stale ?? false,
    triggerRefresh,
    isRefreshing,
    refreshError,
    mutate: () => mutate(),
  }
}

/**
 * Poll the trader detail endpoint until data is refreshed or timeout.
 */
function pollForCompletion(
  platform: string,
  traderKey: string,
  mutate: () => void,
  maxAttempts = 12,
  intervalMs = 5000
): void {
  let attempts = 0

  const poll = () => {
    attempts++
    if (attempts >= maxAttempts) return

    setTimeout(async () => {
      try {
        const res = await fetch(`/api/trader/${platform}/${traderKey}`)
        if (res.ok) {
          const data: TraderDetailResponse = await res.json()
          // If refresh job is done (no active job) or data is fresh, stop polling
          if (!data.refresh_job || data.refresh_job.status === 'success') {
            mutate()
            return
          }
        }
      } catch {
        // Ignore poll errors
      }
      poll()
    }, intervalMs)
  }

  poll()
}
