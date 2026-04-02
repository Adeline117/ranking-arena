'use client'

import { useEffect, useCallback, type ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'

interface ChartFullscreenProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
}

/**
 * ChartFullscreen — landscape-optimized fullscreen chart overlay for mobile
 * Forces landscape orientation hint, hides all chrome
 */
export default function ChartFullscreen({ open, onClose, children, title }: ChartFullscreenProps) {
  // Lock body scroll
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleFullscreen = useCallback(() => {
    const el = document.documentElement
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => { /* ignore */ }) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    }
  }, [])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Chart fullscreen'}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: tokens.zIndex.modal + 10,
        background: 'var(--color-bg-primary)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid var(--color-border-primary)`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: tokens.typography.fontSize.sm, fontWeight: 600, color: 'var(--color-text-primary)' }}>
          {title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* Rotate hint */}
          <button
            onClick={handleFullscreen}
            aria-label="Fullscreen"
            style={{
              background: 'none',
              border: `1px solid var(--color-border-primary)`,
              borderRadius: tokens.radius.sm,
              padding: tokens.spacing[1],
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* Close */}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: `1px solid var(--color-border-primary)`,
              borderRadius: tokens.radius.sm,
              padding: tokens.spacing[1],
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Chart area — fills remaining space */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: tokens.spacing[2],
          display: 'flex',
          alignItems: 'stretch',
        }}
      >
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  )
}
