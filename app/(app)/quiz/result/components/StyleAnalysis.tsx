'use client'

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
    <div className="quiz-section-card">
      {/* Section header */}
      <div className="quiz-section-header">
        <div className="quiz-section-accent" style={{ background: type.gradient }} />
        <h3 className="quiz-section-title">
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

      {/* Meta: Risk gauge + Time horizon */}
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
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
          {/* Segmented filled gauge */}
          <div className="quiz-risk-gauge" role="img" aria-label={`Risk level ${type.riskLevel} out of 5`}>
            {[1, 2, 3, 4, 5].map((level) => (
              <div
                key={level}
                aria-hidden="true"
                className="quiz-risk-segment"
                data-active={level <= type.riskLevel ? 'true' : 'false'}
                style={{
                  background: level <= type.riskLevel ? type.color : undefined,
                  '--quiz-type-color-25': `${type.color}40`,
                } as React.CSSProperties}
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

      {/* Strengths & Weaknesses — different visual weight */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* Strengths — tinted cards, more visual prominence */}
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
            <div key={key} className="quiz-strength-item">
              <span style={{ color: 'var(--color-accent-success)', flexShrink: 0, marginTop: 1, fontSize: 12, fontWeight: 700 }}>+</span>
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {tr(key)}
              </span>
            </div>
          ))}
        </div>

        {/* Weaknesses — plain bordered, recessive */}
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
            <div key={key} className="quiz-weakness-item">
              <span style={{ color: 'var(--color-accent-error)', flexShrink: 0, marginTop: 1, fontSize: 12, fontWeight: 700 }}>-</span>
              <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {tr(key)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
