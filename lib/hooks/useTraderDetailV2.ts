/**
 * Hook for fetching trader details from the new /api/trader/:platform/:trader_key endpoint.
 * Provides loading/error/stale states and refresh capability.
 */

'use client'

import useSWR from 'swr'
import { useState, useCallback, useRef, useEffect } from 'react'
import type {
  TraderDetailResponse,
  RefreshResponse,
  Platform,
} from '@/lib/types/trading-platform'

const FETCH_TIMEOUT_MS = 15_000

const fetcher = async (url: string): Promise<TraderDetailResponse> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Network error' }))
    throw new Error(error.error || `HTTP ${res.status}`)
  }
  return res.json()
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface UseTraderDetailV2Options {
  platform: Platform
  traderKey: string
  /** SWR refresh interval in ms (default: 0 = no auto-refresh) */
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
  const abortControllerRef = useRef<AbortController | null>(null)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current)
        pollTimeoutRef.current = null
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [])

  const triggerRefresh = useCallback(async (): Promise<RefreshResponse | null> => {
    if (!traderKey || isRefreshing) return null

    setIsRefreshing(true)
    setRefreshError(null)

    try {
      const res = await fetch(`/api/trader/${platform}/${traderKey}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_type: 'full_refresh', priority: 1 }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      const result: RefreshResponse = await res.json()

      // Poll for completion (check every 5s, max 60s)
      if (result.created) {
        // Abort any existing polling
        if (abortControllerRef.current) {
          abortControllerRef.current.abort()
        }
        if (pollTimeoutRef.current) {
          clearTimeout(pollTimeoutRef.current)
        }

        const controller = new AbortController()
        abortControllerRef.current = controller
        pollForCompletion(platform, traderKey, mutate, controller.signal, pollTimeoutRef)
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
 * Uses AbortSignal for proper cleanup on component unmount.
 */
function pollForCompletion(
  platform: string,
  traderKey: string,
  mutate: () => void,
  signal: AbortSignal,
  timeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  maxAttempts = 12,
  intervalMs = 5000
): void {
  let attempts = 0

  const poll = () => {
    if (signal.aborted) return
    attempts++
    if (attempts >= maxAttempts) return

    timeoutRef.current = setTimeout(async () => {
      if (signal.aborted) return
      try {
        const res = await fetch(`/api/trader/${platform}/${traderKey}`, { signal })
        if (res.ok) {
          const data: TraderDetailResponse = await res.json()
          if (!data.refresh_job || data.refresh_job.status === 'success') {
            mutate()
            return
          }
        }
      } catch {
        if (signal.aborted) return
      }
      poll()
    }, intervalMs)
  }

  poll()
}
