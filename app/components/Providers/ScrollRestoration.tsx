'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Scroll position restoration for back/forward navigation.
 * Saves scroll position per pathname in sessionStorage.
 * Restores on popstate (browser back/forward).
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
    // Prune old entries if too many
    const keys = Object.keys(map)
    if (keys.length > MAX_ENTRIES) {
      const toRemove = keys.slice(0, keys.length - MAX_ENTRIES)
      toRemove.forEach(k => delete map[k])
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Intentionally swallowed: sessionStorage full or unavailable (private browsing), scroll position is optional
  }
}

export default function ScrollRestoration() {
  const pathname = usePathname()

  useEffect(() => {
    // Save scroll position before navigating away
    const saveScroll = () => {
      const map = getScrollMap()
      map[pathname] = window.scrollY
      saveScrollMap(map)
    }

    // On popstate (back/forward), restore scroll
    const handlePopState = () => {
      // Mark that next pathname change is from back/forward navigation
      sessionStorage.setItem('arena_is_popstate', '1')
    }

    window.addEventListener('popstate', handlePopState)

    // Save on click (internal navigation) and before unload
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

  // Restore scroll on pathname change (from popstate)
  useEffect(() => {
    // Check if this navigation was a popstate (back/forward)
    const map = getScrollMap()
    const savedY = map[pathname]
    if (savedY !== undefined && savedY > 0) {
      // Use a short delay to let the page render
      const timer = setTimeout(() => {
        window.scrollTo(0, savedY)
        // Clean up after restore
        delete map[pathname]
        saveScrollMap(map)
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [pathname])

  return null
}
