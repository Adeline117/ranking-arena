'use client'

import { useEffect, useRef, useState } from 'react'
import type { PersonalityType } from '../../components/types'
import { QuizIcon } from './QuizIcon'

interface PersonalityCardProps {
  type: PersonalityType
  matchPercent: number
  secondaryTypeLabel: string
  tr: (key: string) => string
}

/** Animated counter from 0 to target value with ease-out deceleration */
function useAnimatedCounter(target: number, duration: number = 1200): number {
  const [value, setValue] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    // Delay so card entrance animation plays first
    const delay = setTimeout(() => {
      startRef.current = null
      const tick = (timestamp: number) => {
        if (startRef.current === null) startRef.current = timestamp
        const elapsed = timestamp - startRef.current
        const progress = Math.min(elapsed / duration, 1)
        // Cubic ease-out for satisfying deceleration
        const eased = 1 - Math.pow(1 - progress, 3)
        setValue(Math.round(eased * target))
        if (progress < 1) {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
    }, 400)
    return () => clearTimeout(delay)
  }, [target, duration])

  return value
}

export default function PersonalityCard({ type, matchPercent, secondaryTypeLabel, tr }: PersonalityCardProps) {
  const [animatedWidth, setAnimatedWidth] = useState(0)
  const animatedMatch = useAnimatedCounter(matchPercent, 1200)
  const [showConfetti, setShowConfetti] = useState(true)

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setAnimatedWidth(matchPercent)
    })
    // Hide confetti after animation completes to clean up DOM
    const timer = setTimeout(() => setShowConfetti(false), 2000)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [matchPercent])

  return (
    <div
      className="quiz-personality-card"
      style={{
        // CSS custom properties for type-specific theming
        '--quiz-type-color': type.color,
        '--quiz-type-color-08': `${type.color}14`,
        '--quiz-type-color-15': `${type.color}26`,
        '--quiz-type-color-25': `${type.color}40`,
        '--quiz-type-gradient': type.gradient,
      } as React.CSSProperties}
    >
      {/* Confetti burst on reveal */}
      {showConfetti && (
        <div className="quiz-confetti" aria-hidden="true">
          {[type.color, 'var(--color-brand)', `${type.color}80`, '#FFD700', 'var(--color-brand-deep)', `${type.color}60`].map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </div>
      )}

      {/* Hero icon with spring entrance */}
      <div
        className="quiz-hero-icon"
        style={{
          background: `${type.color}15`,
          border: `1px solid ${type.color}30`,
        }}
      >
        <QuizIcon name={type.icon} color={type.color} size={34} />
      </div>

      {/* Type name — large hero weight */}
      <h2 className="quiz-hero-type-name" style={{ color: type.color }}>
        {tr(type.nameKey)}
      </h2>

      {/* Animated match percentage — counts up from 0 */}
      <div className="quiz-match-section">
        <div className="quiz-match-bar-track">
          <div
            className="quiz-match-bar-fill"
            style={{
              width: `${animatedWidth}%`,
              background: type.gradient,
            }}
          />
        </div>
        <span
          className="quiz-match-label"
          style={{ color: type.color }}
        >
          {animatedMatch}% {tr('quizMatch')}
        </span>
      </div>

      {/* Description */}
      <p className="quiz-hero-description">
        {tr(type.descriptionKey)}
      </p>

      {/* Secondary type badge — pill-shaped */}
      <span className="quiz-shadow-badge">
        {tr('quizShadowType')}: {secondaryTypeLabel}
      </span>
    </div>
  )
}
