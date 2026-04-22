'use client'

import type { PersonalityType } from '../../components/types'

interface MasterSectionProps {
  type: PersonalityType
  tr: (key: string) => string
}

export default function MasterSection({ type, tr }: MasterSectionProps) {
  const { master } = type

  return (
    <div className="quiz-section-card">
      {/* Section header */}
      <div className="quiz-section-header">
        <div className="quiz-section-accent" style={{ background: type.gradient }} />
        <h3 className="quiz-section-title">
          {tr('quizMasterTitle')}
        </h3>
      </div>

      {/* Master name + years */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <h4
          style={{
            fontSize: 'clamp(17px, 4vw, 22px)',
            fontWeight: 800,
            color: type.color,
            margin: 0,
            letterSpacing: '-0.01em',
          }}
        >
          {tr(master.nameKey)}
        </h4>
        <span
          style={{
            fontSize: 12,
            color: 'var(--color-text-tertiary)',
          }}
        >
          {tr(master.yearsKey)}
        </span>
      </div>

      {/* Tagline */}
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
          fontStyle: 'italic',
          lineHeight: 1.5,
        }}
      >
        {tr(master.taglineKey)}
      </span>

      {/* Bio paragraphs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {master.bioKeys.map((key) => (
          <p
            key={key}
            style={{
              fontSize: 14,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.75,
              margin: 0,
            }}
          >
            {tr(key)}
          </p>
        ))}
      </div>

      {/* Famous trade — highlighted card */}
      <div
        style={{
          padding: '14px 16px',
          borderRadius: 10,
          background: `${type.color}0A`,
          border: `1px solid ${type.color}18`,
        }}
      >
        <p
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: type.color,
            margin: '0 0 6px 0',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          {tr('quizFamousTrade')}
        </p>
        <p
          style={{
            fontSize: 14,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          {tr(master.famousTradeKey)}
        </p>
      </div>

      {/* Quote */}
      <blockquote
        style={{
          margin: 0,
          padding: '12px 18px',
          borderLeft: `3px solid ${type.color}`,
          fontStyle: 'italic',
          color: 'var(--color-text-secondary)',
          fontSize: 15,
          lineHeight: 1.65,
          background: `${type.color}05`,
          borderRadius: '0 8px 8px 0',
        }}
      >
        &ldquo;{tr(master.quoteKey)}&rdquo;
      </blockquote>
    </div>
  )
}
