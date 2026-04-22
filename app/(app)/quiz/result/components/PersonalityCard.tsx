'use client'

import { useEffect, useState } from 'react'
import type { PersonalityType } from '../../components/types'
import { QuizIcon } from './QuizIcon'

interface PersonalityCardProps {
  type: PersonalityType
  matchPercent: number
  secondaryTypeLabel: string
  tr: (key: string) => string
}

export default function PersonalityCard({ type, matchPercent, secondaryTypeLabel, tr }: PersonalityCardProps) {
  const [animatedWidth, setAnimatedWidth] = useState(0)

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setAnimatedWidth(matchPercent)
    })
    return () => cancelAnimationFrame(raf)
  }, [matchPercent])

  return (
    <div
      className="quiz-personality-card"
      style={{
        // Set CSS custom properties for type color used by the CSS classes
        '--quiz-type-gradient': type.gradient,
        '--quiz-type-color-08': `${type.color}14`,
        '--quiz-type-color-15': `${type.color}26`,
        '--quiz-type-color-25': `${type.color}40`,
      } as React.CSSProperties}
    >
      {/* Icon — uses spring entrance animation */}
      <div
        className="quiz-hero-icon"
        style={{
          background: `${type.color}15`,
          border: `1px solid ${type.color}30`,
        }}
      >
        <QuizIcon name={type.icon} color={type.color} size={32} />
      </div>

      {/* Type name — hero weight */}
      <h2 className="quiz-hero-type-name" style={{ color: type.color }}>
        {tr(type.nameKey)}
      </h2>

      {/* Match percentage — wider bar, bigger label */}
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
        <span className="quiz-match-label" style={{ color: type.color }}>
          {matchPercent}% {tr('quizMatch')}
        </span>
      </div>

      {/* Description — slightly larger for hero card */}
      <p className="quiz-hero-description">
        {tr(type.descriptionKey)}
      </p>

      {/* Secondary type badge — pill-shaped */}
      <span className="quiz-shadow-badge">
        {tr('quizShadowType')}: {secondaryTypeLabel}
      </span>

      {/* Confetti burst */}
      <div className="quiz-confetti" aria-hidden="true">
        {[type.color, 'var(--color-brand)', `${type.color}80`, '#FFD700', 'var(--color-brand-deep)', `${type.color}60`].map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </div>
    </div>
  )
}
