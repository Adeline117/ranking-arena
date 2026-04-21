'use client'

import { tokens } from '@/lib/design-tokens'
import type { PersonalityType } from '../../components/types'

/** Forced dark-theme palette */
const Q = {
  BG_CARD: '#161625',
  BORDER: 'rgba(255,255,255,0.08)',
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: 'rgba(255,255,255,0.7)',
  TEXT_TERTIARY: 'rgba(255,255,255,0.45)',
  INACTIVE_DOT: 'rgba(255,255,255,0.12)',
  SUCCESS: '#2FE57D',
  ERROR: '#FF5555',
} as const

interface StyleAnalysisProps {
  type: PersonalityType
  tr: (key: string) => string
}

export default function StyleAnalysis({ type, tr }: StyleAnalysisProps) {
  const timeLabels: Record<string, string> = {
    short: 'quizTimeShort',
    medium: 'quizTimeMedium',
    long: 'quizTimeLong',
  }

  return (
    <div
      style={{
        borderRadius: 16,
        background: Q.BG_CARD,
        border: `1px solid ${Q.BORDER}`,
        padding: 'clamp(20px, 4vw, 28px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 4,
            height: 24,
            borderRadius: 2,
            background: type.gradient,
          }}
        />
        <h3
          style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.bold,
            color: Q.TEXT_PRIMARY,
            margin: 0,
          }}
        >
          {tr('quizStyleTitle')}
        </h3>
      </div>

      {/* Trading style */}
      <div
        style={{
          padding: '10px 16px',
          borderRadius: 10,
          background: `${type.color}15`,
          border: `1px solid ${type.color}25`,
          alignSelf: 'flex-start',
        }}
      >
        <span
          style={{
            fontSize: tokens.typography.fontSize.base,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: type.color,
          }}
        >
          {tr(type.styleKey)}
        </span>
      </div>

      {/* Meta: Risk + Time */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: Q.TEXT_TERTIARY,
              letterSpacing: '1px',
              textTransform: 'uppercase',
            }}
          >
            {tr('quizRiskLevel')}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            {[1, 2, 3, 4, 5].map((level) => (
              <div
                key={level}
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: level <= type.riskLevel ? type.color : Q.INACTIVE_DOT,
                  transition: 'background 0.3s',
                }}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.semibold,
              color: Q.TEXT_TERTIARY,
              letterSpacing: '1px',
              textTransform: 'uppercase',
            }}
          >
            {tr('quizTimeHorizon')}
          </span>
          <span
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.medium,
              color: Q.TEXT_PRIMARY,
            }}
          >
            {tr(timeLabels[type.timeHorizon])}
          </span>
        </div>
      </div>

      {/* Strengths & Weaknesses */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* Strengths */}
        <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
              color: Q.SUCCESS,
            }}
          >
            {tr('quizStrengths')}
          </span>
          {type.strengthKeys.map((key) => (
            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: Q.SUCCESS, flexShrink: 0, marginTop: 2 }}>+</span>
              <span
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: Q.TEXT_SECONDARY,
                  lineHeight: 1.5,
                }}
              >
                {tr(key)}
              </span>
            </div>
          ))}
        </div>

        {/* Weaknesses */}
        <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span
            style={{
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.bold,
              color: Q.ERROR,
            }}
          >
            {tr('quizWeaknesses')}
          </span>
          {type.weaknessKeys.map((key) => (
            <div key={key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={{ color: Q.ERROR, flexShrink: 0, marginTop: 2 }}>-</span>
              <span
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: Q.TEXT_SECONDARY,
                  lineHeight: 1.5,
                }}
              >
                {tr(key)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
