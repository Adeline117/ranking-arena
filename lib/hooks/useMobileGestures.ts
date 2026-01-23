/**
 * 移动端手势 Hooks
 * 
 * 包含:
 * - usePullToRefresh: 下拉刷新
 * - useSwipeActions: 滑动操作
 * - useLongPress: 长按
 */

'use client'

import { useState, useCallback, useRef, useEffect } from 'react'

// ============================================
// usePullToRefresh - 下拉刷新
// ============================================

export type PullToRefreshState = 'idle' | 'pulling' | 'ready' | 'refreshing'

export type UsePullToRefreshOptions = {
  onRefresh: () => Promise<void>
  threshold?: number // 触发刷新的阈值 (px)
  maxPull?: number // 最大下拉距离 (px)
  disabled?: boolean
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  maxPull = 120,
  disabled = false,
}: UsePullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>('idle')
  const [pullDistance, setPullDistance] = useState(0)
  
  const containerRef = useRef<HTMLDivElement>(null)
  const startY = useRef(0)
  const currentY = useRef(0)
  const isTracking = useRef(false)

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (disabled || state === 'refreshing') return
    
    const container = containerRef.current
    if (!container || container.scrollTop > 0) return
    
    startY.current = e.touches[0].clientY
    isTracking.current = true
  }, [disabled, state])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isTracking.current || disabled || state === 'refreshing') return
    
    currentY.current = e.touches[0].clientY
    const deltaY = currentY.current - startY.current
    
    if (deltaY > 0) {
      // 使用阻尼效果
      const dampedDistance = Math.min(deltaY * 0.5, maxPull)
      setPullDistance(dampedDistance)
      
      if (dampedDistance >= threshold) {
        setState('ready')
      } else {
        setState('pulling')
      }
      
      // 阻止默认滚动
      e.preventDefault()
    }
  }, [disabled, state, threshold, maxPull])

  const handleTouchEnd = useCallback(async () => {
    if (!isTracking.current) return
    isTracking.current = false
    
    if (state === 'ready') {
      setState('refreshing')
      try {
        await onRefresh()
      } finally {
        setState('idle')
        setPullDistance(0)
      }
    } else {
      setState('idle')
      setPullDistance(0)
    }
  }, [state, onRefresh])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', handleTouchEnd)

    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd])

  return {
    containerRef,
    state,
    pullDistance,
    isRefreshing: state === 'refreshing',
    isPulling: state === 'pulling' || state === 'ready',
    isReady: state === 'ready',
  }
}

// ============================================
// useSwipeActions - 滑动操作
// ============================================

export type SwipeDirection = 'left' | 'right' | 'up' | 'down'

export type UseSwipeActionsOptions = {
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  onSwipeUp?: () => void
  onSwipeDown?: () => void
  threshold?: number // 触发滑动的最小距离 (px)
  velocityThreshold?: number // 触发滑动的最小速度 (px/ms)
  disabled?: boolean
}

export function useSwipeActions({
  onSwipeLeft,
  onSwipeRight,
  onSwipeUp,
  onSwipeDown,
  threshold = 50,
  velocityThreshold = 0.3,
  disabled = false,
}: UseSwipeActionsOptions) {
  const [swiping, setSwiping] = useState(false)
  const [swipeOffset, setSwipeOffset] = useState({ x: 0, y: 0 })
  
  const elementRef = useRef<HTMLDivElement>(null)
  const startPos = useRef({ x: 0, y: 0 })
  const startTime = useRef(0)
  const isTracking = useRef(false)

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return
    
    startPos.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
    }
    startTime.current = Date.now()
    isTracking.current = true
    setSwiping(true)
  }, [disabled])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isTracking.current || disabled) return
    
    const currentX = e.touches[0].clientX
    const currentY = e.touches[0].clientY
    
    setSwipeOffset({
      x: currentX - startPos.current.x,
      y: currentY - startPos.current.y,
    })
  }, [disabled])

  const handleTouchEnd = useCallback(() => {
    if (!isTracking.current) return
    isTracking.current = false
    setSwiping(false)
    
    const deltaX = swipeOffset.x
    const deltaY = swipeOffset.y
    const duration = Date.now() - startTime.current
    const velocityX = Math.abs(deltaX) / duration
    const velocityY = Math.abs(deltaY) / duration
    
    const absX = Math.abs(deltaX)
    const absY = Math.abs(deltaY)
    
    // 判断是水平滑动还是垂直滑动
    if (absX > absY) {
      // 水平滑动
      if (absX >= threshold || velocityX >= velocityThreshold) {
        if (deltaX > 0) {
          onSwipeRight?.()
        } else {
          onSwipeLeft?.()
        }
      }
    } else {
      // 垂直滑动
      if (absY >= threshold || velocityY >= velocityThreshold) {
        if (deltaY > 0) {
          onSwipeDown?.()
        } else {
          onSwipeUp?.()
        }
      }
    }
    
    setSwipeOffset({ x: 0, y: 0 })
  }, [swipeOffset, threshold, velocityThreshold, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown])

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    element.addEventListener('touchstart', handleTouchStart, { passive: true })
    element.addEventListener('touchmove', handleTouchMove, { passive: true })
    element.addEventListener('touchend', handleTouchEnd)

    return () => {
      element.removeEventListener('touchstart', handleTouchStart)
      element.removeEventListener('touchmove', handleTouchMove)
      element.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd])

  return {
    elementRef,
    swiping,
    swipeOffset,
  }
}

// ============================================
// useLongPress - 长按
// ============================================

export type UseLongPressOptions = {
  onLongPress: () => void
  onPress?: () => void
  delay?: number // 长按延迟 (ms)
  disabled?: boolean
}

export function useLongPress({
  onLongPress,
  onPress,
  delay = 500,
  disabled = false,
}: UseLongPressOptions) {
  const [pressing, setPressing] = useState(false)
  const [longPressed, setLongPressed] = useState(false)
  
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const isLongPressRef = useRef(false)

  const start = useCallback(() => {
    if (disabled) return
    
    setPressing(true)
    isLongPressRef.current = false
    
    timerRef.current = setTimeout(() => {
      isLongPressRef.current = true
      setLongPressed(true)
      onLongPress()
    }, delay)
  }, [disabled, delay, onLongPress])

  const stop = useCallback(() => {
    setPressing(false)
    setLongPressed(false)
    
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    
    // 如果不是长按，触发普通点击
    if (!isLongPressRef.current && onPress) {
      onPress()
    }
  }, [onPress])

  const cancel = useCallback(() => {
    setPressing(false)
    setLongPressed(false)
    
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [])

  return {
    handlers: {
      onMouseDown: start,
      onMouseUp: stop,
      onMouseLeave: cancel,
      onTouchStart: start,
      onTouchEnd: stop,
      onTouchCancel: cancel,
    },
    pressing,
    longPressed,
  }
}

// ============================================
// useSwipeToDelete - 滑动删除 (常用)
// ============================================

export type UseSwipeToDeleteOptions = {
  onDelete: () => void
  deleteThreshold?: number // 删除阈值 (px)
  maxSwipe?: number // 最大滑动距离 (px)
  disabled?: boolean
}

export function useSwipeToDelete({
  onDelete,
  deleteThreshold = 80,
  maxSwipe = 120,
  disabled = false,
}: UseSwipeToDeleteOptions) {
  const [swipeX, setSwipeX] = useState(0)
  const [showDelete, setShowDelete] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const elementRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const isTracking = useRef(false)

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (disabled) return
    startX.current = e.touches[0].clientX
    isTracking.current = true
    setIsAnimating(false)
  }, [disabled])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isTracking.current || disabled) return

    const deltaX = e.touches[0].clientX - startX.current

    // 只允许向左滑动
    if (deltaX < 0) {
      const dampedX = Math.max(deltaX * 0.8, -maxSwipe)
      setSwipeX(dampedX)
      setShowDelete(Math.abs(dampedX) >= deleteThreshold)
    }
  }, [disabled, deleteThreshold, maxSwipe])

  const handleTouchEnd = useCallback(() => {
    if (!isTracking.current) return
    isTracking.current = false
    setIsAnimating(true)

    if (showDelete) {
      onDelete()
    }

    setSwipeX(0)
    setShowDelete(false)
  }, [showDelete, onDelete])

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    element.addEventListener('touchstart', handleTouchStart, { passive: true })
    element.addEventListener('touchmove', handleTouchMove, { passive: true })
    element.addEventListener('touchend', handleTouchEnd)

    return () => {
      element.removeEventListener('touchstart', handleTouchStart)
      element.removeEventListener('touchmove', handleTouchMove)
      element.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd])

  return {
    elementRef,
    swipeX,
    showDelete,
    style: {
      transform: `translateX(${swipeX}px)`,
      transition: isAnimating ? 'transform 0.2s ease' : 'none',
    },
  }
}

export default {
  usePullToRefresh,
  useSwipeActions,
  useLongPress,
  useSwipeToDelete,
}
