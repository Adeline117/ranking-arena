'use client'

import { useEffect, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'

/** Forced dark-theme palette */
const Q = {
  TEXT_PRIMARY: '#FFFFFF',
  TRACK: 'rgba(255,255,255,0.08)',
  SPINNER_BG: 'rgba(139, 92, 246, 0.2)',
  BRAND: '#8B5CF6',
  BRAND_DEEP: '#6D28D9',
} as const

interface CalculatingStepProps {
  tr: (key: string) => string
  onDone: () => void
}

export default function CalculatingStep({ tr, onDone }: CalculatingStepProps) {
  const [progress, setProgress] = useState(0)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    // Animate progress from 0 to 100 over 1.5s
    const start = Date.now()
    const duration = 1500
    const tick = () => {
      const elapsed = Date.now() - start
      const pct = Math.min(100, (elapsed / duration) * 100)
      setProgress(pct)
      if (elapsed < duration) {
        requestAnimationFrame(tick)
      } else {
        onDoneRef.current()
      }
    }
    requestAnimationFrame(tick)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        minHeight: 300,
        animation: 'fadeIn 0.3s ease-out',
      }}
    >
      {/* Spinner */}
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          border: `3px solid ${Q.SPINNER_BG}`,
          borderTopColor: Q.BRAND,
          animation: 'spin 1s linear infinite',
        }}
      />

      {/* Text */}
      <p
        style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.semibold,
          color: Q.TEXT_PRIMARY,
          margin: 0,
        }}
      >
        {tr('quizCalculating')}
      </p>

      {/* Progress bar */}
      <div
        style={{
          width: '100%',
          maxWidth: 280,
          height: 4,
          borderRadius: 2,
          background: Q.TRACK,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            borderRadius: 2,
            background: `linear-gradient(90deg, ${Q.BRAND} 0%, ${Q.BRAND_DEEP} 100%)`,
            transition: 'width 0.05s linear',
          }}
        />
      </div>
    </div>
  )
}
