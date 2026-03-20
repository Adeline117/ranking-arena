'use client'

import { useEffect, useRef, useCallback } from 'react'

interface NumberTickerProps {
  value: number
  direction?: 'up' | 'down'
  delay?: number
  decimalPlaces?: number
  suffix?: string
  className?: string
  style?: React.CSSProperties
}

/**
 * Animated number counter using native IntersectionObserver + requestAnimationFrame.
 * Replaces framer-motion dependency (~50KB gzipped) with zero-dependency animation.
 * Spring-like easing via exponential decay for smooth, natural feel.
 */
export default function NumberTicker({
  value,
  direction = 'up',
  delay = 0,
  decimalPlaces = 0,
  suffix = '',
  className,
  style,
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const animatedRef = useRef(false)

  const formatNumber = useCallback((n: number) => {
    return Intl.NumberFormat('en-US', {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    }).format(Number(n.toFixed(decimalPlaces)))
  }, [decimalPlaces])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Show final value immediately to avoid blank content during idle wait
    el.textContent = formatNumber(direction === 'down' ? 0 : value) + suffix

    let delayTimer: ReturnType<typeof setTimeout> | null = null
    let rafId: number | null = null

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || animatedRef.current) return
        animatedRef.current = true
        observer.disconnect()

        const startValue = direction === 'down' ? value : 0
        const endValue = direction === 'down' ? 0 : value

        // Defer animation until browser is idle — avoids blocking TBT during LCP window
        const scheduleAnimation = typeof requestIdleCallback !== 'undefined'
          ? requestIdleCallback
          : (cb: () => void) => setTimeout(cb, 50)

        scheduleAnimation(() => {
          // Reset to start value for animation
          if (el) el.textContent = formatNumber(startValue) + suffix

          delayTimer = setTimeout(() => {
            const duration = 800 // ms
            const startTime = performance.now()

            const tick = (now: number) => {
              const elapsed = now - startTime
              const progress = Math.min(elapsed / duration, 1)
              // Exponential ease-out for spring-like feel
              const eased = 1 - Math.pow(1 - progress, 3)
              const current = startValue + (endValue - startValue) * eased

              if (ref.current) {
                ref.current.textContent = formatNumber(current) + suffix
              }

              if (progress < 1) {
                rafId = requestAnimationFrame(tick)
              }
            }

            rafId = requestAnimationFrame(tick)
          }, delay * 1000)
        })
      },
      { threshold: 0.1 }
    )

    observer.observe(el)
    return () => {
      observer.disconnect()
      if (delayTimer !== null) clearTimeout(delayTimer)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [value, direction, delay, suffix, formatNumber])

  return (
    <span
      ref={ref}
      className={className}
      style={{
        display: 'inline-block',
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {/* Show final value in SSR to avoid "0" flash — useEffect will animate from 0 */}
      {Intl.NumberFormat('en-US', {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(direction === 'down' ? 0 : value)}{suffix}
    </span>
  )
}
