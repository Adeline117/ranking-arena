/**
 * useDraftPersistence — auto-save form drafts to sessionStorage on session expiry.
 *
 * Usage:
 *   const [content, setContent] = useDraftPersistence('post-editor', '')
 *
 * On session expiry (arena:auth-lost event), the current value is saved.
 * On re-mount after re-auth, the saved value is restored and cleared.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

const DRAFT_PREFIX = 'arena:draft:'

export function useDraftPersistence<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  // Try to restore saved draft on mount
  const [value, setValueInternal] = useState<T>(() => {
    if (typeof window === 'undefined') return initialValue
    try {
      const saved = sessionStorage.getItem(`${DRAFT_PREFIX}${key}`)
      if (saved !== null) {
        sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`)
        return JSON.parse(saved) as T
      }
    } catch {
      // Ignore parse errors
    }
    return initialValue
  })

  const valueRef = useRef(value)
  valueRef.current = value

  // Save to sessionStorage on session expiry
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleAuthLost = () => {
      try {
        const current = valueRef.current
        // Only save non-empty values
        if (current !== initialValue && current !== '' && current !== null) {
          sessionStorage.setItem(`${DRAFT_PREFIX}${key}`, JSON.stringify(current))
        }
      } catch {
        // sessionStorage might be full or unavailable
      }
    }

    window.addEventListener('arena:auth-lost', handleAuthLost)
    return () => window.removeEventListener('arena:auth-lost', handleAuthLost)
  }, [key, initialValue])

  // Wrapper that updates both state and ref
  const setValue = useCallback((update: T | ((prev: T) => T)) => {
    setValueInternal(update)
  }, [])

  // Manual clear
  const clearDraft = useCallback(() => {
    try {
      sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`)
    } catch {
      // Ignore
    }
  }, [key])

  return [value, setValue, clearDraft]
}
