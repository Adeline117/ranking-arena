'use client'

import useSWR from 'swr'
import { useCallback, useMemo } from 'react'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useAchievements } from '@/lib/hooks/useAchievements'

interface WatchlistItem {
  source: string
  source_trader_id: string
  handle: string | null
  created_at: string
}

const WATCHLIST_KEY = '/api/watchlist'

export function useWatchlist() {
  const { isLoggedIn, getAuthHeadersAsync } = useAuthSession()
  const { tryUnlock } = useAchievements()

  const fetcher = useCallback(async (): Promise<WatchlistItem[]> => {
    if (!isLoggedIn) return []
    const headers = await getAuthHeadersAsync()
    const res = await fetch(WATCHLIST_KEY, { headers })
    if (!res.ok) return []
    const data = await res.json()
    return data.watchlist || []
  }, [isLoggedIn, getAuthHeadersAsync])

  const { data, error, mutate } = useSWR(
    isLoggedIn ? WATCHLIST_KEY : null,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  )

  const watchlist = useMemo(() => data || [], [data])
  const watchlistSet = useMemo(
    () => new Set(watchlist.map((w) => `${w.source}:${w.source_trader_id}`)),
    [watchlist]
  )

  const isWatched = useCallback(
    (source: string, sourceTraderID: string) =>
      watchlistSet.has(`${source}:${sourceTraderID}`),
    [watchlistSet]
  )

  const addToWatchlist = useCallback(
    async (source: string, sourceTraderID: string, handle?: string) => {
      if (!isLoggedIn) return
      const newItem: WatchlistItem = { source, source_trader_id: sourceTraderID, handle: handle || null, created_at: new Date().toISOString() }
      mutate([...watchlist, newItem], false)
      const headers = await getAuthHeadersAsync()
      await fetch(WATCHLIST_KEY, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, source_trader_id: sourceTraderID, handle }),
      })
      mutate()
      tryUnlock('first_watchlist')
    },
    [isLoggedIn, watchlist, mutate, getAuthHeadersAsync, tryUnlock]
  )

  const removeFromWatchlist = useCallback(
    async (source: string, sourceTraderID: string) => {
      if (!isLoggedIn) return
      mutate(
        watchlist.filter((w) => !(w.source === source && w.source_trader_id === sourceTraderID)),
        false
      )
      const headers = await getAuthHeadersAsync()
      await fetch(WATCHLIST_KEY, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, source_trader_id: sourceTraderID }),
      })
      mutate()
    },
    [isLoggedIn, watchlist, mutate, getAuthHeadersAsync]
  )

  return {
    watchlist,
    isWatched,
    addToWatchlist,
    removeFromWatchlist,
    isLoading: !data && !error && isLoggedIn,
  }
}
