'use client'
import { useEffect, useRef } from 'react'

/**
 * iOS-safe scroll lock.
 * `overflow: hidden` on body does NOT prevent scroll-through on iOS Safari.
 * This hook uses `position: fixed` + scroll position save/restore.
 */
export function useScrollLock(locked: boolean) {
  const scrollYRef = useRef(0)

  useEffect(() => {
    if (!locked) return

    const scrollY = window.scrollY
    scrollYRef.current = scrollY

    const body = document.body
    const html = document.documentElement

    // Save current styles
    const originalBodyPosition = body.style.position
    const originalBodyTop = body.style.top
    const originalBodyWidth = body.style.width
    const originalBodyOverflow = body.style.overflow
    const originalHtmlOverflow = html.style.overflow

    // Apply iOS-safe scroll lock
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    html.style.overflow = 'hidden'

    return () => {
      // Restore styles
      body.style.position = originalBodyPosition
      body.style.top = originalBodyTop
      body.style.width = originalBodyWidth
      body.style.overflow = originalBodyOverflow
      html.style.overflow = originalHtmlOverflow

      // Restore scroll position
      window.scrollTo(0, scrollYRef.current)
    }
  }, [locked])
}
