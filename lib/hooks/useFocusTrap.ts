'use client'

import { useEffect, useRef, useCallback } from 'react'

/**
 * Focus trap hook for modals and dialogs
 *
 * Traps keyboard focus within a container when active.
 * Returns focus to the trigger element when deactivated.
 *
 * Usage:
 *   const { containerRef, activate, deactivate } = useFocusTrap();
 *
 *   useEffect(() => {
 *     if (isOpen) activate();
 *     else deactivate();
 *   }, [isOpen, activate, deactivate]);
 *
 *   return <div ref={containerRef}>...</div>
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>() {
  const containerRef = useRef<T>(null)
  const previousActiveElement = useRef<HTMLElement | null>(null)
  const isActive = useRef(false)

  // Get all focusable elements within the container
  const getFocusableElements = useCallback(() => {
    if (!containerRef.current) return []

    const focusableSelectors = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ')

    return Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(focusableSelectors)
    ).filter((el) => el.offsetParent !== null) // Filter out hidden elements
  }, [])

  // Handle Tab key to trap focus
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isActive.current || e.key !== 'Tab') return

      const focusableElements = getFocusableElements()
      if (focusableElements.length === 0) return

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]

      // Shift + Tab from first element -> go to last
      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault()
        lastElement.focus()
        return
      }

      // Tab from last element -> go to first
      if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault()
        firstElement.focus()
        return
      }

      // If focus is outside the container, bring it back
      if (
        containerRef.current &&
        !containerRef.current.contains(document.activeElement)
      ) {
        e.preventDefault()
        firstElement.focus()
      }
    },
    [getFocusableElements]
  )

  // Activate the focus trap
  const activate = useCallback(() => {
    if (isActive.current) return

    // Store current active element
    previousActiveElement.current = document.activeElement as HTMLElement

    isActive.current = true
    document.addEventListener('keydown', handleKeyDown)

    // Focus the first focusable element or the container itself
    requestAnimationFrame(() => {
      const focusableElements = getFocusableElements()
      if (focusableElements.length > 0) {
        focusableElements[0].focus()
      } else if (containerRef.current) {
        containerRef.current.setAttribute('tabindex', '-1')
        containerRef.current.focus()
      }
    })
  }, [getFocusableElements, handleKeyDown])

  // Deactivate the focus trap
  const deactivate = useCallback(() => {
    if (!isActive.current) return

    isActive.current = false
    document.removeEventListener('keydown', handleKeyDown)

    // Return focus to the previous active element
    requestAnimationFrame(() => {
      if (previousActiveElement.current && previousActiveElement.current.focus) {
        previousActiveElement.current.focus()
      }
      previousActiveElement.current = null
    })
  }, [handleKeyDown])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isActive.current) {
        document.removeEventListener('keydown', handleKeyDown)
      }
    }
  }, [handleKeyDown])

  return {
    containerRef,
    activate,
    deactivate,
    // Note: isActive is not exposed to avoid accessing ref during render
    // If you need to check if active, use a state variable instead
  }
}

/**
 * Hook for automatic focus trap based on isOpen state
 *
 * Usage:
 *   const containerRef = useAutoFocusTrap(isOpen);
 *   return <div ref={containerRef}>...</div>
 */
export function useAutoFocusTrap<T extends HTMLElement = HTMLElement>(isOpen: boolean) {
  const { containerRef, activate, deactivate } = useFocusTrap<T>()

  useEffect(() => {
    if (isOpen) {
      activate()
    } else {
      deactivate()
    }
  }, [isOpen, activate, deactivate])

  return containerRef
}
