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
      setMessageIdx(messages.length - 1)
      setProgress(100)
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
    if (prefersReducedMotion) return

    let rafId: number
    let cancelled = false
    const start = Date.now()
    const duration = 1500
    const tick = () => {
      if (cancelled) return
      const elapsed = Date.now() - start
      const pct = Math.min(100, (elapsed / duration) * 100)
      setProgress(pct)
      if (elapsed < duration) {
        rafId = requestAnimationFrame(tick)
      } else {
        onDoneRef.current()
      }
    }
    rafId = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [prefersReducedMotion])

  return (
    <div className="quiz-calculating">
      {/* Spinner with glow */}
      <div role="status" aria-label="Calculating results" className="quiz-calc-spinner" />

      {/* Rotating messages */}
      <p aria-live="polite" className="quiz-calc-message" key={messageIdx}>
        {messages[messageIdx]}
      </p>

      {/* Progress bar */}
      <div className="quiz-calc-bar-track">
        <div className="quiz-calc-bar-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  )
}
