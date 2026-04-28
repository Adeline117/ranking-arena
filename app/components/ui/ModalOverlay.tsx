'use client'

import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'

/**
 * Shared modal overlay — the single structural primitive for all modals.
 *
 * Eliminates duplicated backdrop + click-outside + a11y + centering
 * across 20+ modal components. Each modal only supplies its content.
 *
 * Usage:
 *   <ModalOverlay open={isOpen} onClose={onClose} label="Edit post">
 *     <h2>Title</h2>
 *     <p>Content</p>
 *   </ModalOverlay>
 *
 * Features included:
 *   - Fixed backdrop with click-outside-to-close
 *   - role="dialog" aria-modal="true" with label
 *   - useModalA11y (scroll lock, Escape, focus trap, auto-focus, focus restore)
 *   - Centered inner panel with sensible defaults
 *   - Optional portal rendering
 *   - Configurable max-width, backdrop intensity
 */

type Backdrop = 'light' | 'medium' | 'heavy'

const BACKDROP_COLORS: Record<Backdrop, string> = {
  light: 'var(--color-backdrop-light, rgba(0,0,0,0.4))',
  medium: 'var(--color-backdrop-medium, rgba(0,0,0,0.6))',
  heavy: 'var(--color-backdrop-heavy, rgba(0,0,0,0.75))',
}

interface ModalOverlayProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  /** aria-label for the dialog */
  label?: string
  /** Inner panel max-width. Default 420. Use 'none' for fullscreen. */
  maxWidth?: number | string
  /** Backdrop intensity. Default 'medium'. */
  backdrop?: Backdrop
  /** Render via createPortal to document.body. Default false. */
  portal?: boolean
  /** Override z-index. Default tokens.zIndex.modal (400). */
  zIndex?: number
  /** Disable the default inner panel (for custom layouts like fullscreen). */
  raw?: boolean
}

export default function ModalOverlay({
  open,
  onClose,
  children,
  label,
  maxWidth = 420,
  backdrop = 'medium',
  portal = false,
  zIndex = tokens.zIndex.modal,
  raw = false,
}: ModalOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useModalA11y({ open, onClose, modalRef: panelRef })

  if (!open) return null

  const content = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        background: BACKDROP_COLORS[backdrop],
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      {raw ? (
        <div ref={panelRef}>{children}</div>
      ) : (
        <div
          ref={panelRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: maxWidth === 'none' ? undefined : maxWidth,
            maxHeight: '90vh',
            overflowY: 'auto',
            background: 'var(--color-bg-secondary)',
            border: `1px solid var(--color-border-primary, ${tokens.colors.border.primary})`,
            borderRadius: tokens.radius.xl,
            boxShadow: '0 24px 64px var(--color-overlay-dark, rgba(0,0,0,0.5))',
          }}
        >
          {children}
        </div>
      )}
    </div>
  )

  if (portal && typeof document !== 'undefined') {
    return createPortal(content, document.body)
  }

  return content
}
