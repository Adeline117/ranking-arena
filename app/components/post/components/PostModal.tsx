'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'

interface PostModalProps {
  children: React.ReactNode
  onClose: () => void
}

/**
 * Modal overlay for post interactions
 * Manages body scroll lock and portal rendering
 */
export function PostModal({ children, onClose }: PostModalProps) {
  const [mounted, setMounted] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<Element | null>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'Tab' && modalRef.current) {
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
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
  }, [onClose])

  useEffect(() => {
    triggerRef.current = document.activeElement
    setMounted(true)
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', handleKeyDown)
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus()
      }
    }
  }, [handleKeyDown])

  useEffect(() => {
    if (mounted && modalRef.current) {
      const firstFocusable = modalRef.current.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      firstFocusable?.focus()
    }
  }, [mounted])

  const modalContent = (
    <div
      role="dialog"
      aria-modal="true"
      ref={modalRef}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-backdrop-medium)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: tokens.zIndex.modal,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
          background: tokens.colors.bg.secondary,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button aria-label="Close"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: 20,
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  )

  if (!mounted) return null
  return createPortal(modalContent, document.body)
}
