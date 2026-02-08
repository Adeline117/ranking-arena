'use client'

import { useRef, useEffect, useCallback, useState } from 'react'

interface PullToRefreshOptions {
  onRefresh: () => Promise<void>
  threshold?: number
  disabled?: boolean
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  disabled = false,
}: PullToRefreshOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const [refreshing, setRefreshing] = useState(false)
  const startYRef = useRef(0)
  const pullingRef = useRef(false)

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (disabled || refreshing) return
    if (window.scrollY > 5) return
    startYRef.current = e.touches[0].clientY
    pullingRef.current = true
  }, [disabled, refreshing])

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!pullingRef.current || !indicatorRef.current) return
    const dy = e.touches[0].clientY - startYRef.current
    if (dy < 0) {
      pullingRef.current = false
      indicatorRef.current.classList.remove('pulling')
      indicatorRef.current.style.transform = 'translateX(-50%)'
      return
    }
    const progress = Math.min(dy / threshold, 1)
    indicatorRef.current.classList.add('pulling')
    indicatorRef.current.style.transform = `translateX(-50%) translateY(${dy * 0.4}px) rotate(${progress * 360}deg)`
  }, [threshold])

  const handleTouchEnd = useCallback(async (e: TouchEvent) => {
    if (!pullingRef.current || !indicatorRef.current) return
    pullingRef.current = false
    const dy = (e.changedTouches?.[0]?.clientY ?? 0) - startYRef.current
    if (dy >= threshold) {
      indicatorRef.current.classList.remove('pulling')
      indicatorRef.current.classList.add('refreshing')
      indicatorRef.current.style.transform = 'translateX(-50%) translateY(30px)'
      setRefreshing(true)
      try {
        await onRefresh()
      } finally {
        setRefreshing(false)
        if (indicatorRef.current) {
          indicatorRef.current.classList.remove('refreshing')
          indicatorRef.current.style.transform = 'translateX(-50%)'
        }
      }
    } else {
      indicatorRef.current.classList.remove('pulling')
      indicatorRef.current.style.transform = 'translateX(-50%)'
    }
  }, [threshold, onRefresh])

  useEffect(() => {
    const el = containerRef.current
    if (!el || disabled) return
    el.addEventListener('touchstart', handleTouchStart, { passive: true })
    el.addEventListener('touchmove', handleTouchMove, { passive: true })
    el.addEventListener('touchend', handleTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, disabled])

  return { containerRef, indicatorRef, refreshing }
}
