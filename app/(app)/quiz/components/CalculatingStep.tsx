'use client'

import { useEffect, useRef, useState } from 'react'

interface CalculatingStepProps {
  tr: (key: string) => string
  onDone: () => void
}

const MESSAGES_EN = [
  'Analyzing your answers...',
  'Matching your trading style...',
  'Finding your legendary match...',
]

const MESSAGES_ZH = [
  '\u5206\u6790\u4F60\u7684\u7B54\u6848\u4E2D\u2026',
  '\u5339\u914D\u4F60\u7684\u4EA4\u6613\u98CE\u683C\u2026',
  '\u5BFB\u627E\u4F60\u7684\u4F20\u5947\u5339\u914D\u2026',
]

export default function CalculatingStep({ tr, onDone }: CalculatingStepProps) {
  const [progress, setProgress] = useState(0)
  const [messageIdx, setMessageIdx] = useState(0)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // Determine language from the tr function
  const isZh = tr('quizCalculating').length > 0 && /[\u4e00-\u9fff]/.test(tr('quizCalculating'))
  const messages = isZh ? MESSAGES_ZH : MESSAGES_EN

  const prefersReducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (prefersReducedMotion) {
      // Skip animation: show final message and complete immediately
      setMessageIdx(messages.length - 1)
      setProgress(100)
      // Small delay so the user sees the final state before navigating
      const t = setTimeout(() => onDoneRef.current(), 200)
      return () => clearTimeout(t)
    }

    // Rotate messages every 500ms
    const msgInterval = setInterval(() => {
      setMessageIdx((prev) => {
        const next = prev + 1
        return next < messages.length ? next : prev
      })
    }, 500)
    return () => clearInterval(msgInterval)
  }, [messages.length, prefersReducedMotion])

  useEffect(() => {
    if (prefersReducedMotion) return // handled above

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
  }, [prefersReducedMotion]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
        minHeight: 260,
        animation: prefersReducedMotion ? 'none' : 'fadeIn 0.3s ease-out',
      }}
    >
      {/* Spinner */}
      <div
        role="status"
        aria-label="Calculating results"
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          border: '3px solid var(--color-bg-tertiary)',
          borderTopColor: 'var(--color-brand)',
          animation: prefersReducedMotion ? 'none' : 'spin 1s linear infinite',
        }}
      />

      {/* Text — rotating messages */}
      <p
        aria-live="polite"
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          margin: 0,
          transition: prefersReducedMotion ? 'none' : 'opacity 0.25s ease',
          minHeight: 22,
        }}
        key={messageIdx}
      >
        {messages[messageIdx]}
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
            transition: prefersReducedMotion ? 'none' : 'width 0.05s linear',
          }}
        />
      </div>
    </div>
  )
}
