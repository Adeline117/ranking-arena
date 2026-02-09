'use client'

import { useState, useEffect } from 'react'
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

  useEffect(() => {
    setMounted(true)
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const modalContent = (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
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
