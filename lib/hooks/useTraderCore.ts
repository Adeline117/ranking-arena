'use client'

/**
 * useTraderCore — one request per timeframe for the serving-mode profile
 * core modules (spec §2.4-2/§2.4-4).
 *
 * - React Query dedupes concurrent callers (client-side single-flight).
 * - Query key includes the timeframe: only the selected TF is fetched;
 *   a cold switch returns a local skeleton instead of mislabelling the prior
 *   timeframe's metrics under the newly selected period.
 * - cacheState 'pending' (Tier-C in flight or stale-refresh) → poll with
 *   2s/4s/8s exponential backoff capped at 15s, giving up after 90s.
 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetcher } from '@/lib/hooks/fetchers'
import { STALE_SLOW } from '@/lib/hooks/cache-presets'
import type {
  TraderCoreModules,
  TraderCoreResponse,
  ServingTimeframe,
} from '@/lib/data/serving/types'
import type { ApiSuccessResponse } from '@/lib/types/index'

const POLL_BASE_MS = 2_000
const POLL_CAP_MS = 15_000
const POLL_GIVE_UP_MS = 90_000

export interface UseTraderCoreOptions {
  source: string
  exchangeTraderId: string
  tf: ServingTimeframe
  enabled?: boolean
}

export function useTraderCore({
  source,
  exchangeTraderId,
  tf,
  enabled = true,
}: UseTraderCoreOptions) {
  const pollRef = useRef<{ key: string; startedAt: number; attempt: number } | null>(null)
  const [deadlineTick, setDeadlineTick] = useState(0)
  const pollKey = `${source}:${exchangeTraderId}:${tf}`

  const url = `/api/traders/${encodeURIComponent(exchangeTraderId)}/core?source=${encodeURIComponent(source)}&tf=${tf}`

  const query = useQuery<TraderCoreResponse>({
    queryKey: ['trader-core', source, exchangeTraderId, tf],
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<TraderCoreResponse>>(url)
      if (res.data.cacheState === 'pending') {
        if (!pollRef.current || pollRef.current.key !== pollKey) {
          pollRef.current = { key: pollKey, startedAt: Date.now(), attempt: 0 }
        }
      } else if (pollRef.current?.key === pollKey) {
        pollRef.current = null
      }
      return res.data
    },
    enabled: enabled && Boolean(source) && Boolean(exchangeTraderId),
    staleTime: STALE_SLOW,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data || data.cacheState !== 'pending' || q.state.error) {
        pollRef.current = null
        return false
      }
      if (!pollRef.current || pollRef.current.key !== pollKey) {
        pollRef.current = { key: pollKey, startedAt: Date.now(), attempt: 0 }
      }
      const poll = pollRef.current
      const remainingMs = POLL_GIVE_UP_MS - (Date.now() - poll.startedAt)
      if (remainingMs <= 0) return false
      // Never let the final 15s backoff overshoot the user-visible recovery
      // deadline. The final scheduled read makes the hook re-render at the
      // exact boundary, so a retained pending response becomes retryable on
      // time instead of drifting one more polling interval.
      const interval = Math.min(POLL_BASE_MS * 2 ** poll.attempt, POLL_CAP_MS, remainingMs)
      poll.attempt += 1
      return interval
    },
    refetchIntervalInBackground: false,
  })

  const data = query.data

  useEffect(() => {
    if (data?.cacheState !== 'pending' || query.error) return
    // A restored query can contain a pending shell before queryFn runs. Start
    // a fresh, bounded foreground window for that exact subject rather than
    // inheriting an untracked loading state from a prior observer.
    if (!pollRef.current || pollRef.current.key !== pollKey) {
      pollRef.current = { key: pollKey, startedAt: Date.now(), attempt: 0 }
      setDeadlineTick((tick) => tick + 1)
      return
    }

    const deadlineAt = pollRef.current.startedAt + POLL_GIVE_UP_MS
    const refreshDeadlineState = () => setDeadlineTick((tick) => tick + 1)
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) return

    const deadlineTimer = window.setTimeout(refreshDeadlineState, remainingMs)
    // Browsers can pause timers while a tab is hidden. Re-check the deadline
    // when it becomes visible so a returning user never sees a permanent
    // loading label for a recovery window that already expired.
    const refreshIfDeadlineExpired = () => {
      if (Date.now() >= deadlineAt) refreshDeadlineState()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshIfDeadlineExpired()
    }
    window.addEventListener('focus', refreshIfDeadlineExpired)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearTimeout(deadlineTimer)
      window.removeEventListener('focus', refreshIfDeadlineExpired)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [data?.cacheState, deadlineTick, pollKey, query.error])

  // A stale hit carries full modules with cacheState 'pending' — render it.
  const modules: TraderCoreModules | null = data && 'stats' in data ? data : null
  const activePoll = pollRef.current?.key === pollKey ? pollRef.current : null
  const pollGaveUp =
    data?.cacheState === 'pending' &&
    activePoll !== null &&
    Date.now() - activePoll.startedAt >= POLL_GIVE_UP_MS
  const isDegraded = Boolean(pollGaveUp) || Boolean(query.error)
  const isPendingUpstream = data?.cacheState === 'pending' && !isDegraded

  return {
    modules,
    /** Tier-C still fetching upstream (skeleton or stale-data badge). */
    isPendingUpstream,
    /** 90s polling window exhausted — show ModuleDegraded with retry. */
    isDegraded,
    /** A manual retry is in flight; keep its retry affordance non-duplicative. */
    isRefreshing: query.isFetching,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      pollRef.current = null // a manual retry restarts the polling window
      return query.refetch()
    },
  }
}
