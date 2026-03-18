'use client'

import { useEffect, useRef } from 'react'
import { useInView, useMotionValue, useSpring } from 'framer-motion'

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
 * Animated number counter with spring physics.
 * Inspired by MagicUI NumberTicker, adapted for Arena's design tokens.
 * Triggers animation when element scrolls into view.
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
  const motionValue = useMotionValue(direction === 'down' ? value : 0)
  const springValue = useSpring(motionValue, {
    damping: 60,
    stiffness: 100,
  })
  const isInView = useInView(ref, { once: true })

  useEffect(() => {
    if (!isInView) return
    const timer = setTimeout(() => {
      motionValue.set(direction === 'down' ? 0 : value)
    }, delay * 1000)
    return () => clearTimeout(timer)
  }, [motionValue, isInView, delay, value, direction])

  useEffect(
    () =>
      springValue.on('change', (latest) => {
        if (ref.current) {
          const formatted = Intl.NumberFormat('en-US', {
            minimumFractionDigits: decimalPlaces,
            maximumFractionDigits: decimalPlaces,
          }).format(Number(latest.toFixed(decimalPlaces)))
          ref.current.textContent = formatted + suffix
        }
      }),
    [springValue, decimalPlaces, suffix]
  )

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
      0{suffix}
    </span>
  )
}
