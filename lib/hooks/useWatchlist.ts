'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useAchievements } from '@/lib/hooks/useAchievements'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import { getCsrfHeaders } from '@/lib/api/csrf'

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
    placeholderData: (prev) => prev,
    queryFn: fetchWatchlist,
    enabled: isLoggedIn,
    refetchOnWindowFocus: false,
    staleTime: STALE_STANDARD,
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
      const newItem: WatchlistItem = {
        source,
        source_trader_id: sourceTraderID,
        handle: handle || null,
        created_at: new Date().toISOString(),
      }
      const matches = (w: WatchlistItem) =>
        w.source === source && w.source_trader_id === sourceTraderID
      // Optimistic update — delta insert against CURRENT cache state (never a
      // captured snapshot, which goes stale if the list mutates mid-flight).
      queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, (prev) => {
        const cur = prev || []
        return cur.some(matches) ? cur : [...cur, newItem]
      })
      try {
        const headers = await getAuthHeadersAsync()
        const res = await fetch(WATCHLIST_API, {
          method: 'POST',
          // POST goes through withAuth CSRF validation — without x-csrf-token the
          // write returned 403 for every real user while the UI still showed a
          // success toast. Include CSRF headers like every other write path.
          headers: { ...headers, ...getCsrfHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, source_trader_id: sourceTraderID, handle }),
        })
        if (!res.ok) throw new Error(`watchlist add: ${res.status}`)
        queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY })
        tryUnlock('first_watchlist')
      } catch (err) {
        // Delta reversal: remove exactly the item we optimistically added from
        // the current state, then rethrow so the caller shows a real error toast
        // instead of a fabricated "added to watchlist" success.
        queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, (prev) =>
          (prev || []).filter((w) => !matches(w))
        )
        throw err
      }
    },
    [isLoggedIn, queryClient, getAuthHeadersAsync, tryUnlock]
  )

  const removeFromWatchlist = useCallback(
    async (source: string, sourceTraderID: string) => {
      if (!isLoggedIn) return
      const matches = (w: WatchlistItem) =>
        w.source === source && w.source_trader_id === sourceTraderID
      // Capture only the single toggled item (its identity), NOT a full-list
      // snapshot — so rollback re-adds exactly one item to the current state.
      const removedItem = watchlist.find(matches)
      // Optimistic delta remove against CURRENT cache state.
      queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, (prev) =>
        (prev || []).filter((w) => !matches(w))
      )
      try {
        const headers = await getAuthHeadersAsync()
        const res = await fetch(WATCHLIST_API, {
          method: 'DELETE',
          headers: { ...headers, ...getCsrfHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, source_trader_id: sourceTraderID }),
        })
        if (!res.ok) throw new Error(`watchlist remove: ${res.status}`)
        queryClient.invalidateQueries({ queryKey: WATCHLIST_QUERY_KEY })
      } catch (err) {
        // Delta reversal: re-add the single removed item to the current state
        // (guard against a concurrent re-add), then rethrow so the caller
        // surfaces the real failure instead of a fabricated success toast.
        if (removedItem) {
          queryClient.setQueryData<WatchlistItem[]>(WATCHLIST_QUERY_KEY, (prev) => {
            const cur = prev || []
            return cur.some(matches) ? cur : [...cur, removedItem]
          })
        }
        throw err
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
