'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Global keyboard shortcuts component
 * Handles keyboard navigation throughout the app
 */
export default function KeyboardShortcuts() {
  const router = useRouter()

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return
      }

      // Shortcuts with no modifiers
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key) {
          case '/':
            e.preventDefault()
            // Focus search
            const searchInput = document.querySelector('input[type="search"], input[placeholder*="搜索"]') as HTMLInputElement
            if (searchInput) {
              searchInput.focus()
            }
            break
          case 'g':
            // Go to home
            if (e.shiftKey) {
              e.preventDefault()
              router.push('/')
            }
            break
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [router])

  return null
}
