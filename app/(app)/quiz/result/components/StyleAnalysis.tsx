'use client'

import { tokens } from '@/lib/design-tokens'
import type { PersonalityType } from '../../components/types'

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
        borderRadius: 12,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--glass-border-light)',
        padding: 'clamp(16px, 3vw, 24px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 3,
            height: 20,
            borderRadius: 2,
            background: type.gradient,
          }}
        />
        <h3
          style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: tokens.typography.fontWeight.bold,
            color: 'var(--color-text-primary)',
            margin: 0,
          }}
        >
          {tr('quizStyleTitle')}
        </h3>
      </div>

      {/* Trading style */}
      <div
        style={{
          padding: '6px 12px',
          borderRadius: 6,
          background: `${type.color}10`,
          border: `1px solid ${type.color}20`,
          alignSelf: 'flex-start',
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
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
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-tertiary)',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
            }}
          >
            {tr('quizRiskLevel')}
          </span>
          <div style={{ display: 'flex', gap: 3 }}>
            {[1, 2, 3, 4, 5].map((level) => (
              <div
                key={level}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: level <= type.riskLevel ? type.color : 'var(--color-bg-tertiary)',
                  transition: 'background 0.3s',
                }}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-tertiary)',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
            }}
          >
            {tr('quizTimeHorizon')}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--color-text-primary)',
            }}
          >
            {tr(timeLabels[type.timeHorizon])}
          </span>
        </div>
      </div>

      {/* Strengths & Weaknesses */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* Strengths */}
        <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--color-accent-success)',
            }}
          >
            {tr('quizStrengths')}
          </span>
          {type.strengthKeys.map((key) => (
            <div key={key} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--color-accent-success)', flexShrink: 0, marginTop: 1, fontSize: 13 }}>+</span>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.5,
                }}
              >
                {tr(key)}
              </span>
            </div>
          ))}
        </div>

        {/* Weaknesses */}
        <div style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--color-accent-error)',
            }}
          >
            {tr('quizWeaknesses')}
          </span>
          {type.weaknessKeys.map((key) => (
            <div key={key} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--color-accent-error)', flexShrink: 0, marginTop: 1, fontSize: 13 }}>-</span>
              <span
                style={{
                  fontSize: 13,
                  color: 'var(--color-text-secondary)',
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
