'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'

/**
 * View Transitions API hook for smooth route transitions.
 * Falls back to standard navigation when the API is not supported.
 *
 * Usage:
 *   const { navigateWithTransition } = useViewTransition()
 *   <a onClick={() => navigateWithTransition('/rankings')}>Rankings</a>
 */
export function useViewTransition() {
  const router = useRouter()

  const navigateWithTransition = useCallback(
    (href: string, options?: { replace?: boolean }) => {
      const nav = () => {
        if (options?.replace) {
          router.replace(href)
        } else {
          router.push(href)
        }
      }

      // Use View Transitions API when available (Chrome 111+, Safari 18+)
      if (typeof document !== 'undefined' && 'startViewTransition' in document) {
        ;(document as Document & { startViewTransition: (cb: () => void) => void }).startViewTransition(nav)
      } else {
        nav()
      }
    },
    [router]
  )

  return { navigateWithTransition }
}
