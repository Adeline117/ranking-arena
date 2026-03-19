'use client'

/**
 * useDeferredSWR — delays SWR key activation until after LCP.
 *
 * Problem: multiple sidebar components (HotDiscussions, WatchlistMarket, NewsFlash)
 * fire SWR fetches on mount simultaneously, contributing to the TBT spike.
 *
 * Solution: return null key until the browser is idle (requestIdleCallback) or
 * a minimum delay has passed. SWR treats null key as "do not fetch".
 *
 * Usage:
 *   const key = useDeferredKey('/api/flash-news')
 *   const { data } = useSWR(key, fetcher)
 *
 * @param key - the SWR key to activate after deferral
 * @param delayMs - minimum ms before activating key (default 800ms after LCP estimate)
 */

import { useState, useEffect } from 'react'

export function useDeferredKey<T>(key: T, delayMs = 800): T | null {
  const [active, setActive] = useState(false)

  useEffect(() => {
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
  }, [delayMs]) // eslint-disable-line react-hooks/exhaustive-deps -- key intentionally excluded; only delay matters

  return active ? key : null
}
