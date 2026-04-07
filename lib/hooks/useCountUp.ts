'use client'

import { useState, useEffect, useRef } from 'react'

/**
 * useCountUp - Animates a number between values using requestAnimationFrame.
 *
 * Key improvement over naive 0→target animation:
 * - Animates from PREVIOUS value to NEW value (e.g., 42.3% → 43.1%)
 * - This creates smooth real-time update feel like TradingView/Bloomberg terminals
 * - First render still animates from 0 to target (mount animation)
 * - Duration 0 skips animation entirely (used for non-hero rows)
 *
 * Inspired by: Tremor dashboard, TradingView, Framer Motion's useMotionValue
 */
export function useCountUp(target: number, duration = 500): number {
  const [value, setValue] = useState(duration === 0 ? target : 0)
  const prevTarget = useRef<number | null>(null)
  const rafId = useRef<number>(0)
  const currentValue = useRef(duration === 0 ? target : 0)

  useEffect(() => {
    // Skip if target hasn't changed
    if (prevTarget.current === target) return

    const from = prevTarget.current ?? 0
    prevTarget.current = target

    // No animation — set value immediately (used for non-hero rows)
    if (duration === 0) {
      setValue(target)
      currentValue.current = target
      return
    }

    // Cancel any in-progress animation
    if (rafId.current) cancelAnimationFrame(rafId.current)

    // Animate from current displayed value to new target
    // This is the key difference: smooth old→new transitions
    const animateFrom = currentValue.current

    // Skip animation for tiny changes (avoid jitter on rounding differences)
    if (Math.abs(animateFrom - target) < 0.001) {
      setValue(target)
      currentValue.current = target
      return
    }

    const start = performance.now()

    const tick = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      // easeOutCubic — fast start, gentle landing
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = animateFrom + (target - animateFrom) * eased
      setValue(current)
      currentValue.current = current

      if (progress < 1) {
        rafId.current = requestAnimationFrame(tick)
      } else {
        setValue(target)
        currentValue.current = target
      }
    }

    rafId.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId.current)
  }, [target, duration])

  return value
}
