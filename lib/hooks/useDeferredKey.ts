'use client'

/**
 * useDeferredKey — delays data-fetching key activation until after LCP.
 *
 * Works with both SWR (string key → null) and React Query (array key → null).
 * Both libraries treat a null/undefined key as "do not fetch".
 *
 * Problem: multiple sidebar components (HotDiscussions, WatchlistMarket, NewsFlash)
 * fire fetches on mount simultaneously, contributing to the TBT spike.
 *
 * Solution: return null key until the browser is idle (requestIdleCallback) or
 * a minimum delay has passed.
 *
 * Usage (SWR):
 *   const key = useDeferredKey('/api/flash-news')
 *   const { data } = useSWR(key, fetcher)
 *
 * Usage (React Query):
 *   const key = useDeferredKey(['flash-news'])
 *   const { data } = useQuery({ queryKey: key ?? ['flash-news'], enabled: !!key })
 *
 * @param key - the key to activate after deferral
 * @param delayMs - minimum ms before activating key (default 800ms after LCP estimate)
 */

import { useState, useEffect } from 'react'

export function useDeferredKey<K>(key: K, delayMs: number = 800): K | null {
  const [active, setActive] = useState(delayMs === 0)

  useEffect(() => {
    if (delayMs === 0) return

    // Strategy: use requestIdleCallback with a minimum delay floor.
    // This ensures the key activates only when the main thread is free
    // AND at least `delayMs` has passed since mount.
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    let idleId: number | null = null

    const activate = () => {
      setActive(true)
    }

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      // Wait for idle AND minimum delay
      timeoutId = setTimeout(() => {
        idleId = requestIdleCallback(activate, { timeout: 2000 })
      }, delayMs)
    } else {
      // Fallback: just wait the minimum delay
      timeoutId = setTimeout(activate, delayMs)
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (idleId !== null && 'cancelIdleCallback' in window) {
        cancelIdleCallback(idleId)
      }
    }
  }, [delayMs])

  return active ? key : null
}
