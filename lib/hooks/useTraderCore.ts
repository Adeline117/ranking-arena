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

import { useRef } from 'react'
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
  const pollKey = `${source}:${exchangeTraderId}:${tf}`

  const url = `/api/traders/${encodeURIComponent(exchangeTraderId)}/core?source=${encodeURIComponent(source)}&tf=${tf}`

  const query = useQuery<TraderCoreResponse>({
    queryKey: ['trader-core', source, exchangeTraderId, tf],
    queryFn: async () => {
      const res = await fetcher<ApiSuccessResponse<TraderCoreResponse>>(url)
      return res.data
    },
    enabled: enabled && Boolean(source) && Boolean(exchangeTraderId),
    staleTime: STALE_SLOW,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      const data = q.state.data
      if (!data || data.cacheState !== 'pending') {
        pollRef.current = null
        return false
      }
      if (!pollRef.current || pollRef.current.key !== pollKey) {
        pollRef.current = { key: pollKey, startedAt: Date.now(), attempt: 0 }
      }
      const poll = pollRef.current
      if (Date.now() - poll.startedAt > POLL_GIVE_UP_MS) return false
      const interval = Math.min(POLL_BASE_MS * 2 ** poll.attempt, POLL_CAP_MS)
      poll.attempt += 1
      return interval
    },
  })

  const data = query.data
  // A stale hit carries full modules with cacheState 'pending' — render it.
  const modules: TraderCoreModules | null = data && 'stats' in data ? data : null
  const pollGaveUp =
    data?.cacheState === 'pending' &&
    pollRef.current !== null &&
    Date.now() - pollRef.current.startedAt > POLL_GIVE_UP_MS

  return {
    modules,
    /** Tier-C still fetching upstream (skeleton or stale-data badge). */
    isPendingUpstream: data?.cacheState === 'pending',
    /** 90s polling window exhausted — show ModuleDegraded with retry. */
    isDegraded: Boolean(pollGaveUp) || Boolean(query.error),
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      pollRef.current = null // a manual retry restarts the polling window
      return query.refetch()
    },
  }
}
