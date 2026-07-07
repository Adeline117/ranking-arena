'use client'

import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react'

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
  const startRef = useRef({ x: 0, y: 0, time: 0 })
  const trackingRef = useRef(false)
  const directionLockedRef = useRef<'horizontal' | 'vertical' | null>(null)

  // U2-9: all panes live side-by-side in a flex row, so the container would
  // otherwise size to the TALLEST pane — leaving the short (e.g. empty) Portfolio
  // pane with thousands of px of dead scroll inherited from the Overview/Stats
  // pane. Constrain the container to the ACTIVE pane's height instead, and track
  // it with a ResizeObserver so async content loads (skeleton → data) resize it.
  const paneRefs = useRef<(HTMLDivElement | null)[]>([])
  const [activeHeight, setActiveHeight] = useState<number | undefined>(undefined)

  useEffect(() => {
    const el = paneRefs.current[activeIndex]
    if (!el) return
    const measure = () => setActiveHeight(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [activeIndex, children.length])

  // Velocity threshold: px/ms — if swipe speed exceeds this, trigger even for short distances
  const VELOCITY_THRESHOLD = 0.5

  const count = children.length

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled) return
      startRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() }
      trackingRef.current = true
      directionLockedRef.current = null
      setIsDragging(true)
    },
    [disabled]
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
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
    },
    [disabled, activeIndex, count]
  )

  const handleTouchEnd = useCallback(() => {
    if (!trackingRef.current) return
    trackingRef.current = false
    setIsDragging(false)

    if (directionLockedRef.current === 'horizontal') {
      const elapsed = Date.now() - startRef.current.time
      const velocity = elapsed > 0 ? Math.abs(offsetX) / elapsed : 0
      const triggeredByVelocity = velocity > VELOCITY_THRESHOLD && Math.abs(offsetX) > 15
      const triggeredByDistance = Math.abs(offsetX) > threshold

      if (triggeredByDistance || triggeredByVelocity) {
        if (offsetX > 0 && activeIndex > 0) {
          onIndexChange(activeIndex - 1)
        } else if (offsetX < 0 && activeIndex < count - 1) {
          onIndexChange(activeIndex + 1)
        }
      }
    }

    setOffsetX(0)
    directionLockedRef.current = null
  }, [offsetX, threshold, activeIndex, count, onIndexChange, VELOCITY_THRESHOLD])

  return (
    <div
      ref={containerRef}
      style={{
        overflow: 'hidden',
        position: 'relative',
        touchAction: 'pan-y',
        // Clamp to the active pane so short panes don't inherit a tall sibling's
        // height. Undefined on first paint (SSR/pre-measure) → natural height.
        height: activeHeight,
        transition: isDragging ? 'none' : 'height 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          display: 'flex',
          // flex-start so inactive (taller) panes don't stretch the row; the
          // active pane's own height drives the clamped container height above.
          alignItems: 'flex-start',
          transform: `translateX(calc(-${activeIndex * 100}% + ${offsetX}px))`,
          transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
          willChange: isDragging ? 'transform' : 'auto',
        }}
      >
        {children.map((child, i) => (
          <div
            key={i}
            ref={(el) => {
              paneRefs.current[i] = el
            }}
            style={{
              flex: '0 0 100%',
              width: '100%',
              minWidth: 0,
              // Top-align so this pane keeps its natural height regardless of taller siblings.
              alignSelf: 'flex-start',
            }}
          >
            {child}
          </div>
        ))}
      </div>
    </div>
  )
}
