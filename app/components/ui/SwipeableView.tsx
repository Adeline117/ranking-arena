'use client'

import { useRef, useState, useCallback, type ReactNode } from 'react'

interface SwipeableViewProps {
  /** Array of tab content */
  children: ReactNode[]
  /** Currently active index */
  activeIndex: number
  /** Called when user swipes to a new index */
  onIndexChange: (index: number) => void
  /** Minimum swipe distance to trigger (px) */
  threshold?: number
  /** Disable swiping */
  disabled?: boolean
}

/**
 * SwipeableView — horizontal swipe to switch between children
 * Used for tab content in trader detail, sub-navigation, etc.
 */
export default function SwipeableView({
  children,
  activeIndex,
  onIndexChange,
  threshold = 50,
  disabled = false,
}: SwipeableViewProps) {
  const [offsetX, setOffsetX] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const startRef = useRef({ x: 0, y: 0 })
  const trackingRef = useRef(false)
  const directionLockedRef = useRef<'horizontal' | 'vertical' | null>(null)

  const count = children.length

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (disabled) return
    startRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    trackingRef.current = true
    directionLockedRef.current = null
    setIsDragging(true)
  }, [disabled])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!trackingRef.current || disabled) return
    const dx = e.touches[0].clientX - startRef.current.x
    const dy = e.touches[0].clientY - startRef.current.y

    // Lock direction on first significant move
    if (!directionLockedRef.current) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        directionLockedRef.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      }
      return
    }

    // If vertical scroll, bail
    if (directionLockedRef.current === 'vertical') return

    // Prevent vertical scroll while horizontal swiping
    e.preventDefault()

    // Apply resistance at boundaries
    let bounded = dx
    if ((activeIndex === 0 && dx > 0) || (activeIndex === count - 1 && dx < 0)) {
      bounded = dx * 0.3
    }
    setOffsetX(bounded)
  }, [disabled, activeIndex, count])

  const handleTouchEnd = useCallback(() => {
    if (!trackingRef.current) return
    trackingRef.current = false
    setIsDragging(false)

    if (directionLockedRef.current === 'horizontal') {
      if (offsetX > threshold && activeIndex > 0) {
        onIndexChange(activeIndex - 1)
      } else if (offsetX < -threshold && activeIndex < count - 1) {
        onIndexChange(activeIndex + 1)
      }
    }

    setOffsetX(0)
    directionLockedRef.current = null
  }, [offsetX, threshold, activeIndex, count, onIndexChange])

  return (
    <div
      ref={containerRef}
      style={{
        overflow: 'hidden',
        position: 'relative',
        touchAction: 'pan-y',
      }}
    >
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          display: 'flex',
          transform: `translateX(calc(-${activeIndex * 100}% + ${offsetX}px))`,
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: isDragging ? 'transform' : 'auto',
        }}
      >
        {children.map((child, i) => (
          <div
            key={i}
            style={{
              flex: '0 0 100%',
              width: '100%',
              minWidth: 0,
            }}
          >
            {child}
          </div>
        ))}
      </div>
    </div>
  )
}
