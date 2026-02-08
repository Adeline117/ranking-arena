'use client'

import { useState, useEffect, useRef } from 'react'

/**
 * useCountUp - Animates a number from 0 to target value using requestAnimationFrame.
 * Duration: 500ms, easeOut timing.
 */
export function useCountUp(target: number, duration = 500): number {
  const [value, setValue] = useState(0)
  const prevTarget = useRef<number | null>(null)
  const rafId = useRef<number>(0)

  useEffect(() => {
    // Skip if target hasn't changed
    if (prevTarget.current === target) return
    prevTarget.current = target

    const start = performance.now()
    const from = 0

    const tick = (now: number) => {
      const elapsed = now - start
      const progress = Math.min(elapsed / duration, 1)
      // easeOutCubic
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(from + (target - from) * eased)

      if (progress < 1) {
        rafId.current = requestAnimationFrame(tick)
      } else {
        setValue(target)
      }
    }

    rafId.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId.current)
  }, [target, duration])

  return value
}
