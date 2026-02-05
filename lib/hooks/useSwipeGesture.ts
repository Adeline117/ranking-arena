/**
 * useSwipeGesture
 *
 * Hook for detecting horizontal and vertical swipe gestures on mobile.
 */

import { useRef, useCallback, useEffect, useState } from 'react'

export type SwipeDirection = 'left' | 'right' | 'up' | 'down' | null

interface SwipeState {
  direction: SwipeDirection
  distance: number
  velocity: number
}

interface SwipeOptions {
  threshold?: number // Minimum distance for swipe (px)
  velocityThreshold?: number // Minimum velocity (px/ms)
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  onSwipeUp?: () => void
  onSwipeDown?: () => void
  onSwipe?: (direction: SwipeDirection, state: SwipeState) => void
  disabled?: boolean
}

const DEFAULT_THRESHOLD = 50
const DEFAULT_VELOCITY_THRESHOLD = 0.3

export function useSwipeGesture(
  ref: React.RefObject<HTMLElement | null>,
  options: SwipeOptions = {}
) {
  const {
    threshold = DEFAULT_THRESHOLD,
    velocityThreshold = DEFAULT_VELOCITY_THRESHOLD,
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    onSwipe,
    disabled = false,
  } = options

  const startX = useRef(0)
  const startY = useRef(0)
  const startTime = useRef(0)
  const [swiping, setSwiping] = useState(false)
  const [swipeOffset, setSwipeOffset] = useState({ x: 0, y: 0 })

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return
    startX.current = e.touches[0].clientX
    startY.current = e.touches[0].clientY
    startTime.current = Date.now()
    setSwiping(true)
  }, [disabled])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!swiping || disabled) return
    const currentX = e.touches[0].clientX
    const currentY = e.touches[0].clientY
    setSwipeOffset({
      x: currentX - startX.current,
      y: currentY - startY.current,
    })
  }, [swiping, disabled])

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!swiping || disabled) return

    const endX = e.changedTouches[0].clientX
    const endY = e.changedTouches[0].clientY
    const deltaX = endX - startX.current
    const deltaY = endY - startY.current
    const deltaTime = Date.now() - startTime.current

    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)
    const velocity = Math.max(absX, absY) / deltaTime

    setSwiping(false)
    setSwipeOffset({ x: 0, y: 0 })

    // Determine if it's a valid swipe
    const isHorizontal = absX > absY
    const distance = isHorizontal ? absX : absY
    const meetsThreshold = distance >= threshold || velocity >= velocityThreshold

    if (!meetsThreshold) return

    let direction: SwipeDirection = null

    if (isHorizontal) {
      direction = deltaX > 0 ? 'right' : 'left'
    } else {
      direction = deltaY > 0 ? 'down' : 'up'
    }

    const state: SwipeState = { direction, distance, velocity }

    onSwipe?.(direction, state)

    switch (direction) {
      case 'left':
        onSwipeLeft?.()
        break
      case 'right':
        onSwipeRight?.()
        break
      case 'up':
        onSwipeUp?.()
        break
      case 'down':
        onSwipeDown?.()
        break
    }
  }, [swiping, disabled, threshold, velocityThreshold, onSwipe, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown])

  useEffect(() => {
    const element = ref.current
    if (!element) return

    element.addEventListener('touchstart', handleTouchStart, { passive: true })
    element.addEventListener('touchmove', handleTouchMove, { passive: true })
    element.addEventListener('touchend', handleTouchEnd, { passive: true })

    return () => {
      element.removeEventListener('touchstart', handleTouchStart)
      element.removeEventListener('touchmove', handleTouchMove)
      element.removeEventListener('touchend', handleTouchEnd)
    }
  }, [ref, handleTouchStart, handleTouchMove, handleTouchEnd])

  return {
    swiping,
    swipeOffset,
  }
}

/**
 * Hook for horizontal swipe navigation between tabs/pages.
 */
export function useSwipeNavigation(
  currentIndex: number,
  totalItems: number,
  onNavigate: (index: number) => void,
  ref: React.RefObject<HTMLElement | null>,
  options: { disabled?: boolean; threshold?: number } = {}
) {
  const { disabled = false, threshold = 80 } = options

  const handleSwipeLeft = useCallback(() => {
    if (currentIndex < totalItems - 1) {
      onNavigate(currentIndex + 1)
    }
  }, [currentIndex, totalItems, onNavigate])

  const handleSwipeRight = useCallback(() => {
    if (currentIndex > 0) {
      onNavigate(currentIndex - 1)
    }
  }, [currentIndex, onNavigate])

  return useSwipeGesture(ref, {
    onSwipeLeft: handleSwipeLeft,
    onSwipeRight: handleSwipeRight,
    threshold,
    disabled,
  })
}
