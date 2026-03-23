'use client'

import { useEffect, useRef, useCallback, useState, type ReactNode } from 'react'
import { tokens } from '@/lib/design-tokens'

type SnapPoint = 'closed' | 'half' | 'full'

interface BottomSheetProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
  /** Initial snap: 'half' (default) or 'full' */
  initialSnap?: 'half' | 'full'
  /** Whether to show handle bar */
  showHandle?: boolean
  /** Max height as vh percentage (default 90) */
  maxHeightVh?: number
}

const SNAP_POINTS: Record<SnapPoint, number> = {
  closed: 0,
  half: 50,
  full: 90,
}

/**
 * BottomSheet — mobile-first modal alternative
 * Drag handle to resize, swipe down to close
 * Three snap points: closed / half / full
 */
export default function BottomSheet({
  open,
  onClose,
  children,
  title,
  initialSnap = 'half',
  showHandle = true,
  maxHeightVh = 90,
}: BottomSheetProps) {
  const [snap, setSnap] = useState<SnapPoint>(open ? initialSnap : 'closed')
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const startYRef = useRef(0)
  const currentYRef = useRef(0)

  // Sync open state
  useEffect(() => {
    if (open) {
      // #35: Clear pending close timer if open becomes true again (rapid toggle guard)
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      setSnap(initialSnap)
      document.body.style.overflow = 'hidden'
    } else {
      setSnap('closed')
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open, initialSnap])

  const closeTimerRef = useRef<NodeJS.Timeout | null>(null)
  const handleClose = useCallback(() => {
    setSnap('closed')
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(onClose, 300)
  }, [onClose])

  // Cleanup close timer on unmount
  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  // Backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose()
  }, [handleClose])

  // Drag handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startYRef.current = e.touches[0].clientY
    currentYRef.current = e.touches[0].clientY
    setIsDragging(true)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return
    currentYRef.current = e.touches[0].clientY
    const delta = currentYRef.current - startYRef.current
    // Only allow dragging down (positive delta) or up (negative delta)
    setDragOffset(delta)
  }, [isDragging])

  const handleTouchEnd = useCallback(() => {
    if (!isDragging) return
    setIsDragging(false)
    const delta = currentYRef.current - startYRef.current
    const velocity = Math.abs(delta) / 200 // rough velocity

    if (delta > 80 || (delta > 30 && velocity > 0.5)) {
      // Swipe down
      if (snap === 'full') {
        setSnap('half')
      } else {
        handleClose()
      }
    } else if (delta < -80 || (delta < -30 && velocity > 0.5)) {
      // Swipe up
      if (snap === 'half') {
        setSnap('full')
      }
    }
    setDragOffset(0)
  }, [isDragging, snap, handleClose])

  // Escape key
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, handleClose])

  const heightVh = Math.min(SNAP_POINTS[snap], maxHeightVh)
  const translateY = snap === 'closed'
    ? '100%'
    : `calc(${100 - heightVh}vh + ${Math.max(0, dragOffset)}px)`

  if (!open && snap === 'closed') return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: tokens.zIndex.modal,
        background: snap !== 'closed' ? 'rgba(0,0,0,0.4)' : 'transparent',
        transition: isDragging ? 'none' : 'background 0.3s ease',
        touchAction: 'none',
      }}
    >
      <div
        ref={sheetRef}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: `${maxHeightVh}vh`,
          transform: `translateY(${translateY})`,
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          background: 'var(--color-bg-primary)',
          borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
          boxShadow: '0 -4px 24px rgba(0,0,0,0.15)',
          display: 'flex',
          flexDirection: 'column',
          paddingBottom: 'env(safe-area-inset-bottom, 0)',
        }}
      >
        {/* Handle */}
        {showHandle && (
          <div
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{
              padding: '12px 0 8px',
              cursor: 'grab',
              touchAction: 'none',
              display: 'flex',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                background: 'var(--color-text-tertiary)',
                opacity: 0.4,
              }}
            />
          </div>
        )}

        {/* Title */}
        {title && (
          <div
            style={{
              padding: `0 ${tokens.spacing[4]} ${tokens.spacing[3]}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              borderBottom: `1px solid var(--color-border-primary)`,
              flexShrink: 0,
            }}
          >
            <span style={{
              fontSize: tokens.typography.fontSize.md,
              fontWeight: tokens.typography.fontWeight.bold,
              color: 'var(--color-text-primary)',
            }}>
              {title}
            </span>
            <button
              onClick={handleClose}
              aria-label="Close"
              style={{
                width: 44,
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: tokens.radius.md,
                background: 'var(--color-bg-tertiary)',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-text-secondary)',
              }}
            >
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
            padding: tokens.spacing[4],
            minHeight: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
