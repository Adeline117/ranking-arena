'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'

interface CalculatingStepProps {
  tr: (key: string) => string
  onDone: () => void
}

export default function CalculatingStep({ tr, onDone }: CalculatingStepProps) {
  const [progress, setProgress] = useState(0)

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
        onDone()
      }
    }
    requestAnimationFrame(tick)
  }, [onDone])

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
          border: '3px solid var(--color-overlay-subtle)',
          borderTopColor: 'var(--color-brand)',
          animation: 'spin 1s linear infinite',
        }}
      />

      {/* Text */}
      <p
        style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.semibold,
          color: 'var(--color-text-primary)',
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
          background: 'var(--color-overlay-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            borderRadius: 2,
            background: 'linear-gradient(90deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
            transition: 'width 0.05s linear',
          }}
        />
      </div>
    </div>
  )
}
