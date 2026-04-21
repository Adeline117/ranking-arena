'use client'

import type { PersonalityType } from '../../components/types'
import { QuizIcon } from './QuizIcon'

interface PersonalityCardProps {
  type: PersonalityType
  matchPercent: number
  secondaryTypeLabel: string
  tr: (key: string) => string
}

export default function PersonalityCard({ type, matchPercent, secondaryTypeLabel, tr }: PersonalityCardProps) {
  return (
    <div
      style={{
        borderRadius: 12,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--glass-border-light)',
        padding: 'clamp(20px, 4vw, 28px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: type.gradient,
        }}
      />

      {/* Icon */}
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 12,
          background: `${type.color}15`,
          border: `1px solid ${type.color}30`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <QuizIcon name={type.icon} color={type.color} size={28} />
      </div>

      {/* Type name */}
      <h2
        style={{
          fontSize: 'clamp(22px, 5vw, 28px)',
          fontWeight: 700,
          color: type.color,
          margin: 0,
          textAlign: 'center',
        }}
      >
        {tr(type.nameKey)}
      </h2>

      {/* Match percentage */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%', maxWidth: 240 }}>
        <div
          style={{
            width: '100%',
            height: 6,
            borderRadius: 3,
            background: 'var(--color-bg-tertiary)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${matchPercent}%`,
              height: '100%',
              borderRadius: 3,
              background: type.gradient,
              transition: 'width 1s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          />
        </div>
        <span
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: type.color,
          }}
        >
          {matchPercent}% {tr('quizMatch')}
        </span>
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: 14,
          color: 'var(--color-text-secondary)',
          lineHeight: 1.6,
          textAlign: 'center',
          margin: 0,
        }}
      >
        {tr(type.descriptionKey)}
      </p>

      {/* Secondary type badge */}
      <span
        style={{
          padding: '4px 12px',
          borderRadius: 6,
          background: 'var(--color-bg-tertiary)',
          border: '1px solid var(--glass-border-light)',
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
        }}
      >
        {tr('quizShadowType')}: {secondaryTypeLabel}
      </span>
    </div>
  )
}
