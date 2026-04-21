'use client'

import { useEffect, useRef, useState } from 'react'

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
        gap: 20,
        minHeight: 260,
        animation: 'fadeIn 0.3s ease-out',
      }}
    >
      {/* Spinner */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          border: '3px solid var(--color-bg-tertiary)',
          borderTopColor: 'var(--color-brand)',
          animation: 'spin 1s linear infinite',
        }}
      />

      {/* Text */}
      <p
        style={{
          fontSize: 15,
          fontWeight: 600,
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
          maxWidth: 240,
          height: 3,
          borderRadius: 2,
          background: 'var(--color-bg-tertiary)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            borderRadius: 2,
            background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-deep))',
            transition: 'width 0.05s linear',
          }}
        />
      </div>
    </div>
  )
}
