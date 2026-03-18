'use client'

/**
 * Near-real-time rankings hook
 *
 * Polls /api/rankings/live every 120 seconds for fresh ranking data.
 * Batches UI updates over a 2-second window to avoid excessive re-renders.
 * Adds a 'ranking-pulse' CSS class on data updates for visual feedback.
 */

import { useEffect, useCallback, useRef, useState } from 'react'

interface RankingUpdate {
  id: string
  source_trader_id?: string
  source: string
  roi: number
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  arena_score: number | null
  rank: number
  handle?: string | null
  avatar_url?: string | null
  [key: string]: unknown
}

interface UseRealtimeRankingsOptions {
  /** Period filter: '7D', '30D', '90D' */
  period?: string
  /** Number of traders to fetch (default: 50) */
  limit?: number
  /** Whether to enable polling (default: true) */
  enabled?: boolean
  /** Poll interval in ms (default: 120000 = 120s) */
  pollInterval?: number
  /** Callback when ranking data changes */
  onUpdate?: (updates: RankingUpdate[]) => void
}

interface UseRealtimeRankingsReturn {
  /** Whether data is currently being fetched */
  isLoading: boolean
  /** Whether the last fetch encountered an error */
  isError: boolean
  /** Whether data just updated (true for 2s after each update) */
  isUpdating: boolean
  /** Data source: 'redis' or 'database' */
  dataSource: string | null
  /** Last update timestamp */
  lastUpdatedAt: number | null
}

/**
 * Poll /api/rankings/live for near-real-time ranking updates.
 * Batches updates over a 2s window and provides an `isUpdating` flag
 * that can be used to trigger a subtle pulse animation in the UI.
 */
export function useRealtimeRankings({
  period = '90D',
  limit = 50,
  enabled = true,
  pollInterval = 120_000,
  onUpdate,
}: UseRealtimeRankingsOptions): UseRealtimeRankingsReturn {
  const [isLoading, setIsLoading] = useState(false)
  const [isError, setIsError] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [dataSource, setDataSource] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)

  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  const bufferRef = useRef<Map<string, RankingUpdate>>(new Map())
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousDataRef = useRef<string>('') // JSON fingerprint for change detection

  const flush = useCallback(() => {
    if (bufferRef.current.size === 0) return
    const updates = Array.from(bufferRef.current.values())
    bufferRef.current.clear()
    onUpdateRef.current?.(updates)

    // Trigger pulse animation indicator for 2 seconds
    setIsUpdating(true)
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = setTimeout(() => setIsUpdating(false), 2000)
  }, [])

  useEffect(() => {
    if (!enabled) return

    let aborted = false

    const fetchLiveRankings = async () => {
      if (aborted) return

      try {
        setIsLoading(true)
        const url = `/api/rankings/live?period=${period}&limit=${limit}&offset=0`
        const res = await fetch(url)

        if (!res.ok) {
          setIsError(true)
          return
        }

        const json = await res.json()
        setIsError(false)
        setDataSource(json.source || null)

        const traders = json.traders as RankingUpdate[] | undefined
        if (!traders?.length) return

        // Change detection: only trigger update if data actually changed
        const fingerprint = traders.map(t => `${t.id}:${t.arena_score}:${t.rank}`).join('|')
        if (fingerprint === previousDataRef.current) return
        previousDataRef.current = fingerprint

        // Buffer updates
        for (const trader of traders) {
          const key = `${trader.source}:${trader.id}`
          bufferRef.current.set(key, trader)
        }

        // Flush after 2s batch window
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
        flushTimerRef.current = setTimeout(flush, 2000)

        setLastUpdatedAt(Date.now())
      } catch {
        setIsError(true)
      } finally {
        setIsLoading(false)
      }
    }

    // Initial fetch
    fetchLiveRankings()

    // Set up polling
    const intervalId = setInterval(fetchLiveRankings, pollInterval)

    return () => {
      aborted = true
      clearInterval(intervalId)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
      flush() // Flush remaining buffered updates
    }
  }, [period, limit, enabled, pollInterval, flush])

  return {
    isLoading,
    isError,
    isUpdating,
    dataSource,
    lastUpdatedAt,
  }
}
