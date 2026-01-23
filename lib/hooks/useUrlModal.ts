'use client'

/**
 * URL-driven Modal State Hook
 *
 * PRINCIPLES:
 * 1. Modal open/close state is driven by URL query params
 * 2. Back button closes modal (browser history integration)
 * 3. ESC key closes modal
 * 4. Deep-linking works (page load with ?post=xxx opens modal)
 * 5. Consistent across all entry points (hot, groups, feed)
 */

import { useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'

export type UseUrlModalOptions = {
  /** The query parameter name (e.g., 'post' for ?post=xxx) */
  paramName: string
  /** Called when modal opens (param value set) */
  onOpen?: (value: string) => void
  /** Called when modal closes (param removed) */
  onClose?: () => void
}

export type UseUrlModalReturn = {
  /** Current modal value (null if closed) */
  value: string | null
  /** Whether modal is open */
  isOpen: boolean
  /** Open modal with a value */
  open: (value: string) => void
  /** Close modal */
  close: () => void
}

export function useUrlModal(options: UseUrlModalOptions): UseUrlModalReturn {
  const { paramName, onOpen, onClose } = options
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const prevValueRef = useRef<string | null>(null)

  const value = searchParams.get(paramName)
  const isOpen = value !== null

  // Track changes to trigger callbacks
  useEffect(() => {
    if (value !== prevValueRef.current) {
      if (value && !prevValueRef.current) {
        onOpen?.(value)
      } else if (!value && prevValueRef.current) {
        onClose?.()
      } else if (value && prevValueRef.current && value !== prevValueRef.current) {
        // Value changed (different modal)
        onOpen?.(value)
      }
      prevValueRef.current = value
    }
  }, [value, onOpen, onClose])

  const open = useCallback((newValue: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set(paramName, newValue)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }, [paramName, searchParams, pathname, router])

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.delete(paramName)
    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname
    router.push(newUrl, { scroll: false })
  }, [paramName, searchParams, pathname, router])

  // ESC key handler
  useEffect(() => {
    if (!isOpen) return

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }

    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [isOpen, close])

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  return { value, isOpen, open, close }
}
