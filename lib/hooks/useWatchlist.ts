'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useAchievements } from '@/lib/hooks/useAchievements'

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
}

const WATCHLIST_QUERY_KEY = ['watchlist']
const WATCHLIST_API = '/api/watchlist'

export function useWatchlist() {
  const { isLoggedIn, getAuthHeadersAsync } = useAuthSession()
  const { tryUnlock } = useAchievements()
  const queryClient = useQueryClient()

  const fetchWatchlist = useCallback(async (): Promise<WatchlistItem[]> => {
    if (!isLoggedIn) return []
    const headers = await getAuthHeadersAsync()
    const res = await fetch(WATCHLIST_API, { headers })
    if (!res.ok) return []
    const data = await res.json()
    return data.watchlist || []
  }, [isLoggedIn, getAuthHeadersAsync])

  const {
    data,
    error,
    isLoading: _queryLoading,
  } = useQuery<WatchlistItem[]>({
    queryKey: WATCHLIST_QUERY_KEY,
    queryFn: fetchWatchlist,
    enabled: isLoggedIn,
    refetchOnWindowFocus: false,
    staleTime: 30000,
  })

  const watchlist = useMemo(() => data || [], [data])
  const watchlistSet = useMemo(
    () => new Set(watchlist.map((w) => `${w.source}:${w.source_trader_id}`)),
    [watchlist]
  )

  const isWatched = useCallback(
    (source: string, sourceTraderID: string) => watchlistSet.has(`${source}:${sourceTraderID}`),
    [watchlistSet]
  )

  const addToWatchlist = useCallback(
    async (source: string, sourceTraderID: string, handle?: string) => {
      if (!isLoggedIn) return
      const previousData = watchlist
      const newItem: WatchlistItem = {
        source,
        source_trader_id: sourceTraderID,
        handle: handle || null,
        created_at: new Date().toISOString(),
      }
      // Optimistic update
      queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, [...watchlist, newItem])
      try {
        const headers = await getAuthHeadersAsync()
        const res = await fetch(WATCHLIST_API, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, source_trader_id: sourceTraderID, handle }),
        })
        if (!res.ok) throw new Error(`watchlist add: ${res.status}`)
        queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY })
        tryUnlock('first_watchlist')
      } catch {
        // Rollback on failure
        queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, previousData)
      }
    },
    [isLoggedIn, watchlist, queryClient, getAuthHeadersAsync, tryUnlock]
  )

  const removeFromWatchlist = useCallback(
    async (source: string, sourceTraderID: string) => {
      if (!isLoggedIn) return
      const previousData = watchlist
      // Optimistic update
      queryClient.setQueryData<WatchlistItem[]>(
        WATCHLIST_QUERY_KEY,
        watchlist.filter((w) => !(w.source === source && w.source_trader_id === sourceTraderID))
      )
      try {
        const headers = await getAuthHeadersAsync()
        const res = await fetch(WATCHLIST_API, {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, source_trader_id: sourceTraderID }),
        })
        if (!res.ok) throw new Error(`watchlist remove: ${res.status}`)
        queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY })
      } catch {
        // Rollback on failure
        queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, previousData)
      }
    },
    [isLoggedIn, watchlist, queryClient, getAuthHeadersAsync]
  )

  return {
    watchlist,
    isWatched,
    addToWatchlist,
    removeFromWatchlist,
    isLoading: !data && !error && isLoggedIn,
  }
}
