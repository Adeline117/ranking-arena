'use client'

/**
 * MobileFilterDrawer
 *
 * A bottom sheet drawer for filters on mobile devices.
 * Uses touch gestures for open/close with smooth animations.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface MobileFilterDrawerProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  onApply?: () => void
  onReset?: () => void
  showApplyButton?: boolean
}

const DRAG_THRESHOLD = 100 // px to close
const VELOCITY_THRESHOLD = 0.5 // px/ms to close

export function MobileFilterDrawer({
  isOpen,
  onClose,
  title,
  children,
  onApply,
  onReset,
  showApplyButton = true,
}: MobileFilterDrawerProps) {
  const { t } = useLanguage()
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [translateY, setTranslateY] = useState(0)

  const drawerRef = useRef<HTMLDivElement>(null)
  const startYRef = useRef(0)
  const startTimeRef = useRef(0)
  const currentYRef = useRef(0)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (isOpen) {
      setVisible(true)
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      // Delay hiding for exit animation
      const timeout = setTimeout(() => setVisible(false), 300)
      return () => clearTimeout(timeout)
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    startYRef.current = touch.clientY
    currentYRef.current = touch.clientY
    startTimeRef.current = Date.now()
    setDragging(true)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging) return
    const touch = e.touches[0]
    currentYRef.current = touch.clientY
    const deltaY = touch.clientY - startYRef.current
    // Only allow dragging down
    if (deltaY > 0) {
      setTranslateY(deltaY)
    }
  }, [dragging])

  const handleTouchEnd = useCallback(() => {
    setDragging(false)
    const deltaY = currentYRef.current - startYRef.current
    const deltaTime = Date.now() - startTimeRef.current
    const velocity = deltaY / deltaTime

    // Close if dragged far enough or with enough velocity
    if (deltaY > DRAG_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
      onClose()
    }
    setTranslateY(0)
  }, [onClose])

  const handleApply = () => {
    onApply?.()
    onClose()
  }

  if (!mounted || !visible) return null

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.6)',
          opacity: isOpen ? 1 : 0,
          transition: 'opacity 0.3s ease',
        }}
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-drawer-title"
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: '85vh',
          background: tokens.colors.bg.primary,
          borderRadius: '20px 20px 0 0',
          transform: isOpen
            ? `translateY(${translateY}px)`
            : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 -4px 24px rgba(0, 0, 0, 0.2)',
        }}
      >
        {/* Handle bar */}
        <div
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: '12px 0 8px',
            cursor: 'grab',
          }}
        >
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: tokens.colors.border.secondary,
            }}
          />
        </div>

        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `0 ${tokens.spacing[4]} ${tokens.spacing[3]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <h2
            id="filter-drawer-title"
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: tokens.colors.text.primary,
              margin: 0,
            }}
          >
            {title || t('filters')}
          </h2>

          {onReset && (
            <button
              onClick={onReset}
              style={{
                padding: '6px 12px',
                background: 'transparent',
                border: 'none',
                color: tokens.colors.accent.primary,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t('reset')}
            </button>
          )}
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: tokens.spacing[4],
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {children}
        </div>

        {/* Footer with Apply button */}
        {showApplyButton && (
          <div
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              paddingBottom: `calc(${tokens.spacing[3]} + env(safe-area-inset-bottom, 0px))`,
              borderTop: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
            }}
          >
            <button
              onClick={handleApply}
              style={{
                width: '100%',
                padding: '14px',
                background: tokens.colors.accent.primary,
                border: 'none',
                borderRadius: 12,
                color: '#fff',
                fontSize: 16,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {t('applyFilters')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

/**
 * Mobile filter trigger button
 */
interface FilterTriggerProps {
  onClick: () => void
  hasActiveFilters?: boolean
  label?: string
}

export function MobileFilterTrigger({ onClick, hasActiveFilters, label }: FilterTriggerProps) {
  const { t } = useLanguage()

  return (
    <button
      onClick={onClick}
      aria-label={label || t('openFilters')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        background: hasActiveFilters
          ? `${tokens.colors.accent.primary}15`
          : tokens.colors.bg.tertiary,
        border: `1px solid ${hasActiveFilters ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
        borderRadius: 8,
        color: hasActiveFilters ? tokens.colors.accent.primary : tokens.colors.text.secondary,
        fontSize: 14,
        fontWeight: 500,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
      </svg>
      <span>{label || t('filters')}</span>
      {hasActiveFilters && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: tokens.colors.accent.primary,
          }}
        />
      )}
    </button>
  )
}
