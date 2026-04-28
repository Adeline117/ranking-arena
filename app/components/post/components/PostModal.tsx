'use client'

import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'

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

  useModalA11y({ open: true, onClose, modalRef })

  useEffect(() => {
    setMounted(true)
  }, [])

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
        animation: 'postModalOverlayIn 0.2s ease forwards',
      }}
    >
      <style>{`
        @keyframes postModalOverlayIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes postModalContentIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.xl,
          background: tokens.colors.bg.secondary,
          padding: 16,
          animation: 'postModalContentIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            aria-label="Close"
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
