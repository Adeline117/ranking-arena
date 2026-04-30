'use client'

import type { PersonalityType } from '../../components/types'

interface StyleAnalysisProps {
  type: PersonalityType
  tr: (key: string) => string
}

const TIME_HORIZON_SYMBOLS: Record<string, string> = {
  short: '\u26A1', // lightning bolt
  medium: '\u23F3', // hourglass with flowing sand
  long: '\u221E', // infinity
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 'clamp(10px, 2.4vw, 11px)',
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: '1.2px',
  textTransform: 'uppercase',
  lineHeight: 1,
}

export default function StyleAnalysis({ type, tr }: StyleAnalysisProps) {
  const timeLabels: Record<string, string> = {
    short: 'quizTimeShort',
    medium: 'quizTimeMedium',
    long: 'quizTimeLong',
  }

  return (
    <div className="quiz-section-card" style={{ gap: 20 }}>
      {/* Section header */}
      <div className="quiz-section-header">
        <div className="quiz-section-accent" style={{ background: type.gradient }} />
        <h3 className="quiz-section-title">{tr('quizStyleTitle')}</h3>
      </div>

      {/* Trading style -- prominent gradient pill */}
      <div
        style={{
          padding: 'clamp(8px, 2vw, 10px) clamp(18px, 4vw, 24px)',
          borderRadius: 100,
          background: type.gradient,
          alignSelf: 'flex-start',
          boxShadow: `0 4px 16px ${type.color}30, 0 0 0 1px ${type.color}18`,
        }}
      >
        <span
          style={{
            fontSize: 'clamp(14px, 3.2vw, 16px)',
            fontWeight: 700,
            color: '#fff',
            letterSpacing: '0.02em',
          }}
        >
          {tr(type.styleKey)}
        </span>
      </div>

      {/* Meta row: Risk gauge + Time horizon */}
      <div
        style={{
          display: 'flex',
          gap: 'clamp(20px, 5vw, 32px)',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
        }}
      >
        {/* Risk gauge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={LABEL_STYLE}>{tr('quizRiskLevel')}</span>
          <div
            className="quiz-risk-gauge"
            role="img"
            aria-label={`Risk level ${type.riskLevel} out of 5`}
            style={{ display: 'flex', gap: 5, alignItems: 'center' }}
          >
            {[1, 2, 3, 4, 5].map((level) => {
              const isActive = level <= type.riskLevel
              return (
                <div
                  key={level}
                  aria-hidden="true"
                  style={{
                    width: 'clamp(26px, 6vw, 32px)',
                    height: 12,
                    borderRadius: 6,
                    background: isActive ? type.color : 'var(--color-border-secondary)',
                    boxShadow: isActive
                      ? `0 0 8px ${type.color}50, 0 2px 4px ${type.color}30`
                      : 'none',
                    transition: 'background 0.4s ease, box-shadow 0.4s ease',
                  }}
                />
              )
            })}
          </div>
        </div>

        {/* Time horizon */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={LABEL_STYLE}>{tr('quizTimeHorizon')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 'clamp(16px, 3.8vw, 18px)',
                lineHeight: 1,
                color: type.color,
                fontWeight: 700,
                opacity: 0.85,
              }}
            >
              {TIME_HORIZON_SYMBOLS[type.timeHorizon] || ''}
            </span>
            <span
              style={{
                fontSize: 'clamp(14px, 3.2vw, 15px)',
                fontWeight: 600,
                color: 'var(--color-text-primary)',
              }}
            >
              {tr(timeLabels[type.timeHorizon])}
            </span>
          </div>
        </div>
      </div>

      {/* Strengths & Weaknesses -- clear visual hierarchy */}
      <div style={{ display: 'flex', gap: 'clamp(14px, 3.5vw, 20px)', flexWrap: 'wrap' }}>
        {/* Strengths -- green accent, visually prominent */}
        <div
          style={{
            flex: 1,
            minWidth: 'clamp(160px, 40vw, 200px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span
            style={{
              ...LABEL_STYLE,
              color: 'var(--color-accent-success)',
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
                gap: 10,
                alignItems: 'flex-start',
                padding: 'clamp(8px, 2vw, 10px) clamp(10px, 2.5vw, 14px)',
                borderRadius: 10,
                background: 'color-mix(in srgb, var(--color-accent-success) 6%, transparent)',
                borderLeft: '3px solid var(--color-accent-success)',
              }}
            >
              <span
                style={{
                  color: 'var(--color-accent-success)',
                  flexShrink: 0,
                  marginTop: 1,
                  fontSize: 13,
                  fontWeight: 800,
                  lineHeight: 1.4,
                }}
              >
                +
              </span>
              <span
                style={{
                  fontSize: 'clamp(12px, 2.8vw, 13px)',
                  color: 'var(--color-text-secondary)',
                  lineHeight: 1.55,
                }}
              >
                {tr(key)}
              </span>
            </div>
          ))}
        </div>

        {/* Weaknesses -- muted, visually recessive */}
        <div
          style={{
            flex: 1,
            minWidth: 'clamp(160px, 40vw, 200px)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <span
            style={{
              ...LABEL_STYLE,
              color: 'var(--color-text-tertiary)',
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
                gap: 10,
                alignItems: 'flex-start',
                padding: 'clamp(8px, 2vw, 10px) clamp(10px, 2.5vw, 14px)',
                borderRadius: 10,
                background: 'transparent',
                border: '1px solid var(--color-border-primary)',
              }}
            >
              <span
                style={{
                  color: 'var(--color-text-tertiary)',
                  flexShrink: 0,
                  marginTop: 1,
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: 1.4,
                }}
              >
                -
              </span>
              <span
                style={{
                  fontSize: 'clamp(12px, 2.8vw, 13px)',
                  color: 'var(--color-text-tertiary)',
                  lineHeight: 1.55,
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
