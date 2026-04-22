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
        borderRadius: 14,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--glass-border-light)',
        padding: 'clamp(18px, 3.5vw, 28px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 0, /* Controlled spacing */
      }}
    >
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div
          style={{
            width: 3,
            height: 22,
            borderRadius: 2,
            background: type.gradient,
          }}
        />
        <h3
          style={{
            fontSize: tokens.typography.fontSize.lg,
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            margin: 0,
            letterSpacing: '-0.01em',
          }}
        >
          {tr('quizStyleTitle')}
        </h3>
      </div>

      {/* Trading style — pill badge */}
      <div
        style={{
          padding: '5px 14px',
          borderRadius: 20,
          background: `${type.color}10`,
          border: `1px solid ${type.color}20`,
          alignSelf: 'flex-start',
          marginBottom: 16,
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

      {/* Meta: Risk + Time — tighter internal spacing */}
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-tertiary)',
              letterSpacing: '0.8px',
              textTransform: 'uppercase',
            }}
          >
            {tr('quizRiskLevel')}
          </span>
          {/* Segmented risk gauge instead of uniform dots */}
          <div style={{ display: 'flex', gap: 3 }} role="img" aria-label={`Risk level ${type.riskLevel} out of 5`}>
            {[1, 2, 3, 4, 5].map((level) => (
              <div
                key={level}
                aria-hidden="true"
                style={{
                  width: 22,
                  height: 8,
                  borderRadius: 2,
                  background: level <= type.riskLevel ? type.color : 'var(--color-bg-tertiary)',
                  boxShadow: level <= type.riskLevel ? `0 0 4px ${type.color}40` : 'none',
                  transition: 'background 0.3s, box-shadow 0.3s',
                }}
              />
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-text-tertiary)',
              letterSpacing: '0.8px',
              textTransform: 'uppercase',
            }}
          >
            {tr('quizTimeHorizon')}
          </span>
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--color-text-primary)',
            }}
          >
            {tr(timeLabels[type.timeHorizon])}
          </span>
        </div>
      </div>

      {/* Strengths & Weaknesses — different visual treatment */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* Strengths — subtle green-tinted cards */}
        <div style={{ flex: 1, minWidth: 170, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--color-accent-success)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 2,
            }}
          >
            {tr('quizStrengths')}
          </span>
          {type.strengthKeys.map((key) => (
            <div
              key={key}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '6px 10px',
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--color-accent-success) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-accent-success) 10%, transparent)',
              }}
            >
              <span style={{ color: 'var(--color-accent-success)', flexShrink: 0, marginTop: 1, fontSize: 12, fontWeight: 700 }}>+</span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 400,
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.5,
                }}
              >
                {tr(key)}
              </span>
            </div>
          ))}
        </div>

        {/* Weaknesses — plain bordered, less emphasis */}
        <div style={{ flex: 1, minWidth: 170, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--color-accent-error)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 2,
            }}
          >
            {tr('quizWeaknesses')}
          </span>
          {type.weaknessKeys.map((key) => (
            <div
              key={key}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--glass-border-light)',
              }}
            >
              <span style={{ color: 'var(--color-accent-error)', flexShrink: 0, marginTop: 1, fontSize: 12, fontWeight: 700 }}>-</span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 400,
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
