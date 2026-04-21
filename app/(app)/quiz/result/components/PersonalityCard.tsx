'use client'

import { tokens } from '@/lib/design-tokens'
import type { PersonalityType } from '../../components/types'
import { QuizIcon } from './QuizIcon'

/** Forced dark-theme palette */
const Q = {
  BG_CARD: '#161625',
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: 'rgba(255,255,255,0.7)',
  TRACK: 'rgba(255,255,255,0.08)',
  BADGE_BG: 'rgba(139, 92, 246, 0.12)',
  BADGE_BORDER: 'rgba(139, 92, 246, 0.25)',
} as const

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
        borderRadius: 20,
        background: Q.BG_CARD,
        border: `2px solid ${type.color}40`,
        padding: 'clamp(24px, 5vw, 32px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 20,
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
          width: 72,
          height: 72,
          borderRadius: 18,
          background: `${type.color}20`,
          border: `2px solid ${type.color}40`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <QuizIcon name={type.icon} color={type.color} size={36} />
      </div>

      {/* Type name */}
      <h2
        style={{
          fontSize: 'clamp(24px, 5vw, 32px)',
          fontWeight: tokens.typography.fontWeight.bold,
          color: type.color,
          margin: 0,
          textAlign: 'center',
        }}
      >
        {tr(type.nameKey)}
      </h2>

      {/* Match percentage */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '100%', maxWidth: 280 }}>
        <div
          style={{
            width: '100%',
            height: 8,
            borderRadius: 4,
            background: Q.TRACK,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${matchPercent}%`,
              height: '100%',
              borderRadius: 4,
              background: type.gradient,
              transition: 'width 1s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          />
        </div>
        <span
          style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.bold,
            color: type.color,
          }}
        >
          {matchPercent}% {tr('quizMatch')}
        </span>
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: tokens.typography.fontSize.base,
          color: Q.TEXT_SECONDARY,
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
          padding: '6px 14px',
          borderRadius: 8,
          background: Q.BADGE_BG,
          border: `1px solid ${Q.BADGE_BORDER}`,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.medium,
          color: Q.TEXT_PRIMARY,
        }}
      >
        {tr('quizShadowType')}: {secondaryTypeLabel}
      </span>
    </div>
  )
}
