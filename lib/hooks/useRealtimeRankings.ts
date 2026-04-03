'use client'

/**
 * Near-real-time rankings hook
 *
 * Polls /api/rankings/live every 60 seconds for fresh ranking data.
 * Also subscribes to Supabase Realtime on leaderboard_ranks for instant
 * refresh when compute-leaderboard writes new data (~every 30 min).
 * Batches UI updates over a 2-second window to avoid excessive re-renders.
 * Adds a 'ranking-pulse' CSS class on data updates for visual feedback.
 */

import { useEffect, useCallback, useRef, useReducer } from 'react'
import { supabase } from '@/lib/supabase/client'

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
  /** Poll interval in ms (default: 60000 = 60s) */
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
interface RealtimeState {
  isLoading: boolean
  isError: boolean
  isUpdating: boolean
  dataSource: string | null
  lastUpdatedAt: number | null
}

type RealtimeAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; dataSource: string | null; lastUpdatedAt: number }
  | { type: 'FETCH_SUCCESS_NO_CHANGE' }
  | { type: 'FETCH_ERROR' }
  | { type: 'FETCH_END' }
  | { type: 'SET_UPDATING'; value: boolean }

function realtimeReducer(state: RealtimeState, action: RealtimeAction): RealtimeState {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, isLoading: true }
    case 'FETCH_SUCCESS':
      return { ...state, isError: false, dataSource: action.dataSource, lastUpdatedAt: action.lastUpdatedAt }
    case 'FETCH_SUCCESS_NO_CHANGE':
      return { ...state, isError: false }
    case 'FETCH_ERROR':
      return { ...state, isError: true }
    case 'FETCH_END':
      return { ...state, isLoading: false }
    case 'SET_UPDATING':
      return { ...state, isUpdating: action.value }
    default:
      return state
  }
}

const initialRealtimeState: RealtimeState = {
  isLoading: false,
  isError: false,
  isUpdating: false,
  dataSource: null,
  lastUpdatedAt: null,
}

export function useRealtimeRankings({
  period = '90D',
  limit = 50,
  enabled = true,
  pollInterval = 60_000,
  onUpdate,
}: UseRealtimeRankingsOptions): UseRealtimeRankingsReturn {
  const [state, dispatch] = useReducer(realtimeReducer, initialRealtimeState)

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
    dispatch({ type: 'SET_UPDATING', value: true })
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = setTimeout(() => dispatch({ type: 'SET_UPDATING', value: false }), 2000)
  }, [])

  useEffect(() => {
    if (!enabled) return

    let aborted = false

    const fetchLiveRankings = async () => {
      if (aborted) return

      try {
        dispatch({ type: 'FETCH_START' })
        const url = `/api/rankings/live?period=${period}&limit=${limit}&offset=0`
        const res = await fetch(url)

        if (!res.ok) {
          dispatch({ type: 'FETCH_ERROR' })
          return
        }

        const json = await res.json()
        const traders = json.traders as RankingUpdate[] | undefined
        if (!traders?.length) {
          dispatch({ type: 'FETCH_SUCCESS_NO_CHANGE' })
          return
        }

        // Change detection: only trigger update if data actually changed
        const fingerprint = traders.map(t => `${t.id}:${t.arena_score}:${t.rank}`).join('|')
        if (fingerprint === previousDataRef.current) {
          dispatch({ type: 'FETCH_SUCCESS_NO_CHANGE' })
          return
        }
        previousDataRef.current = fingerprint

        // Buffer updates
        for (const trader of traders) {
          const key = `${trader.source}:${trader.id}`
          bufferRef.current.set(key, trader)
        }

        // Flush after 2s batch window
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
        flushTimerRef.current = setTimeout(flush, 2000)

        dispatch({ type: 'FETCH_SUCCESS', dataSource: json.source || null, lastUpdatedAt: Date.now() })
      } catch {
        dispatch({ type: 'FETCH_ERROR' })
      } finally {
        dispatch({ type: 'FETCH_END' })
      }
    }

    // Initial fetch
    fetchLiveRankings()

    // Set up polling — pause when tab is hidden to save bandwidth
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      fetchLiveRankings()
    }, pollInterval)

    // Subscribe to Supabase Realtime for instant refresh when compute-leaderboard writes
    const channel = supabase
      .channel(`rankings-live:${period}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'leaderboard_ranks', filter: `season_id=eq.${period}` },
        () => {
          // Debounce: compute-leaderboard writes many rows at once.
          // Wait 3s after the first notification, then fetch once.
          if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
          flushTimerRef.current = setTimeout(() => {
            if (!aborted) fetchLiveRankings()
          }, 3000)
        }
      )
      .subscribe()

    return () => {
      aborted = true
      clearInterval(intervalId)
      supabase.removeChannel(channel)
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current)
      flush() // Flush remaining buffered updates
    }
  }, [period, limit, enabled, pollInterval, flush])

  return {
    isLoading: state.isLoading,
    isError: state.isError,
    isUpdating: state.isUpdating,
    dataSource: state.dataSource,
    lastUpdatedAt: state.lastUpdatedAt,
  }
}
