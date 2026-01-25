'use client'

import { useCallback, useRef, useState } from 'react'

export interface SwipeGestureOptions {
  threshold?: number  // Minimum distance in px to trigger swipe
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  onSwipeUp?: () => void
  onSwipeDown?: () => void
  preventScroll?: boolean  // Prevent default scroll on swipe
}

export interface SwipeState {
  swiping: boolean
  direction: 'left' | 'right' | 'up' | 'down' | null
  distance: number
}

/**
 * Hook for detecting swipe gestures
 *
 * Usage:
 *   const { handlers, state } = useSwipeGesture({
 *     onSwipeLeft: () => navigateToNextTab(),
 *     onSwipeRight: () => navigateToPrevTab(),
 *     threshold: 50,
 *   });
 *
 *   <div {...handlers}>Content</div>
 */
export function useSwipeGesture(options: SwipeGestureOptions = {}) {
  const { threshold = 50, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, preventScroll = false } = options

  const [state, setState] = useState<SwipeState>({
    swiping: false,
    direction: null,
    distance: 0,
  })

  const touchStart = useRef<{ x: number; y: number } | null>(null)
  const touchCurrent = useRef<{ x: number; y: number } | null>(null)

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStart.current = { x: touch.clientX, y: touch.clientY }
    touchCurrent.current = { x: touch.clientX, y: touch.clientY }
    setState({ swiping: true, direction: null, distance: 0 })
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStart.current) return

    const touch = e.touches[0]
    touchCurrent.current = { x: touch.clientX, y: touch.clientY }

    const deltaX = touch.clientX - touchStart.current.x
    const deltaY = touch.clientY - touchStart.current.y

    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    let direction: SwipeState['direction'] = null
    let distance = 0

    if (absX > absY) {
      // Horizontal swipe
      direction = deltaX > 0 ? 'right' : 'left'
      distance = absX
    } else {
      // Vertical swipe
      direction = deltaY > 0 ? 'down' : 'up'
      distance = absY
    }

    // Prevent scroll if horizontal swipe is detected
    if (preventScroll && absX > absY && absX > 10) {
      e.preventDefault()
    }

    setState({ swiping: true, direction, distance })
  }, [preventScroll])

  const handleTouchEnd = useCallback(() => {
    if (!touchStart.current || !touchCurrent.current) {
      setState({ swiping: false, direction: null, distance: 0 })
      return
    }

    const deltaX = touchCurrent.current.x - touchStart.current.x
    const deltaY = touchCurrent.current.y - touchStart.current.y

    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)

    // Only trigger if movement exceeds threshold
    if (absX > threshold || absY > threshold) {
      if (absX > absY) {
        // Horizontal swipe
        if (deltaX > 0) {
          onSwipeRight?.()
        } else {
          onSwipeLeft?.()
        }
      } else {
        // Vertical swipe
        if (deltaY > 0) {
          onSwipeDown?.()
        } else {
          onSwipeUp?.()
        }
      }
    }

    touchStart.current = null
    touchCurrent.current = null
    setState({ swiping: false, direction: null, distance: 0 })
  }, [threshold, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown])

  const handleTouchCancel = useCallback(() => {
    touchStart.current = null
    touchCurrent.current = null
    setState({ swiping: false, direction: null, distance: 0 })
  }, [])

  return {
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
      onTouchCancel: handleTouchCancel,
    },
    state,
  }
}

/**
 * Hook for pull-to-refresh gesture
 */
export function usePullToRefresh(onRefresh: () => Promise<void>, threshold = 80) {
  const [pulling, setPulling] = useState(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef(0)
  const currentY = useRef(0)

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Only start pull if at top of scroll
    const element = e.currentTarget as HTMLElement
    if (element.scrollTop <= 0) {
      startY.current = e.touches[0].clientY
      setPulling(true)
    }
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling || refreshing) return

    currentY.current = e.touches[0].clientY
    const delta = currentY.current - startY.current

    if (delta > 0) {
      // Apply resistance to pull
      const distance = Math.min(delta * 0.5, threshold * 1.5)
      setPullDistance(distance)

      if (delta > 10) {
        e.preventDefault()
      }
    }
  }, [pulling, refreshing, threshold])

  const handleTouchEnd = useCallback(async () => {
    if (!pulling) return

    if (pullDistance >= threshold && !refreshing) {
      setRefreshing(true)
      try {
        await onRefresh()
      } finally {
        setRefreshing(false)
      }
    }

    setPulling(false)
    setPullDistance(0)
    startY.current = 0
  }, [pulling, pullDistance, threshold, refreshing, onRefresh])

  return {
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    pulling,
    pullDistance,
    refreshing,
    shouldTrigger: pullDistance >= threshold,
  }
}
