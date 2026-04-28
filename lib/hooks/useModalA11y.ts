'use client'
import { useEffect, type RefObject } from 'react'
import { useScrollLock } from './useScrollLock'

/**
 * Unified modal accessibility hook.
 *
 * Replaces 500+ lines of duplicated boilerplate across 28 modal components.
 * Handles: scroll lock, Escape key, focus trap, auto-focus, focus restore.
 *
 * Usage:
 *   // Simple: scroll lock + Escape + focus restore
 *   useModalA11y({ open, onClose })
 *
 *   // Full: + focus trap + auto-focus (pass a ref to the modal container)
 *   useModalA11y({ open, onClose, modalRef })
 */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalA11y({
  open,
  onClose,
  modalRef,
}: {
  open: boolean
  onClose: () => void
  modalRef?: RefObject<HTMLElement | null>
}) {
  useScrollLock(open)

  useEffect(() => {
    if (!open) return

    const previousFocus = document.activeElement as HTMLElement | null

    // Auto-focus first focusable element inside the modal
    if (modalRef?.current) {
      // Use rAF to let the DOM settle (e.g. after animation start)
      requestAnimationFrame(() => {
        const first = modalRef.current?.querySelector<HTMLElement>(FOCUSABLE)
        first?.focus()
      })
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      // Focus trap: cycle Tab within the modal container
      if (e.key === 'Tab' && modalRef?.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [open, onClose, modalRef])
}
