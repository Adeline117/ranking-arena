'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Scroll position restoration for back/forward AND direct refresh.
 * Saves scroll position per pathname in sessionStorage.
 * Restores on:
 *   - Browser back/forward (popstate)
 *   - Direct page refresh (beforeunload saved → mount restores)
 */
const STORAGE_KEY = 'arena_scroll_positions'
const MAX_ENTRIES = 50

function getScrollMap(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveScrollMap(map: Record<string, number>) {
  try {
    const keys = Object.keys(map)
    if (keys.length > MAX_ENTRIES) {
      const toRemove = keys.slice(0, keys.length - MAX_ENTRIES)
      toRemove.forEach(k => delete map[k])
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // sessionStorage full or unavailable — scroll position is optional
  }
}

export default function ScrollRestoration() {
  const pathname = usePathname()
  const isPopstateRef = useRef(false)

  // Save scroll and listen for popstate
  useEffect(() => {
    const saveScroll = () => {
      const map = getScrollMap()
      map[pathname] = window.scrollY
      saveScrollMap(map)
    }

    const handlePopState = () => {
      isPopstateRef.current = true
    }

    window.addEventListener('popstate', handlePopState)

    // Save on internal link click and before unload (covers refresh)
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a')
      if (anchor && anchor.href && !anchor.target && !anchor.download) {
        const url = new URL(anchor.href, window.location.origin)
        if (url.origin === window.location.origin) {
          saveScroll()
        }
      }
    }
    document.addEventListener('click', handleClick, true)
    window.addEventListener('beforeunload', saveScroll)

    return () => {
      window.removeEventListener('popstate', handlePopState)
      document.removeEventListener('click', handleClick, true)
      window.removeEventListener('beforeunload', saveScroll)
    }
  }, [pathname])

  // Restore scroll on pathname change or initial mount (refresh)
  useEffect(() => {
    const map = getScrollMap()
    const savedY = map[pathname]
    if (savedY === undefined || savedY <= 0) return

    // Use multiple attempts with increasing delays to handle lazy-loaded content.
    // requestIdleCallback alone fires too early when the page hasn't rendered yet.
    let cancelled = false
    const attempts = [50, 150, 400]
    const timers: ReturnType<typeof setTimeout>[] = []

    for (const delay of attempts) {
      timers.push(setTimeout(() => {
        if (cancelled) return
        // Only scroll if the page is tall enough to scroll to the saved position
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight
        if (maxScroll >= savedY * 0.8) {
          window.scrollTo(0, savedY)
          cancelled = true
          // Clean up saved position after successful restore
          delete map[pathname]
          saveScrollMap(map)
        }
      }, delay))
    }

    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [pathname])

  return null
}
