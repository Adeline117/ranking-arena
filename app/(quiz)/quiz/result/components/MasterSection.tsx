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
        <h3 className="quiz-section-title">{tr('quizMasterTitle')}</h3>
      </div>

      {/* LEGENDARY MATCH label + Master name + years pill */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--color-text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            lineHeight: 1,
          }}
        >
          {tr('quizLegendaryMatch')}
        </span>
        <h4
          style={{
            fontSize: 'clamp(20px, 5vw, 28px)',
            fontWeight: 800,
            color: type.color,
            margin: 0,
            letterSpacing: '-0.02em',
            lineHeight: 1.15,
            /* no textShadow — glow looks bad on light backgrounds */
          }}
        >
          {tr(master.nameKey)}
        </h4>
        <span
          style={{
            display: 'inline-flex',
            alignSelf: 'flex-start',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-tertiary)',
            background: 'var(--color-bg-tertiary, rgba(128,128,128,0.08))',
            padding: '3px 10px',
            borderRadius: 100,
            letterSpacing: '0.02em',
            lineHeight: 1.4,
          }}
        >
          {tr(master.yearsKey)}
        </span>
      </div>

      {/* Tagline with type-colored left accent border */}
      <div
        style={{
          borderLeft: `3px solid ${type.color}`,
          paddingLeft: 14,
        }}
      >
        <span
          style={{
            fontSize: 'clamp(14px, 3.5vw, 15px)',
            fontWeight: 500,
            color: 'var(--color-text-secondary)',
            fontStyle: 'italic',
            lineHeight: 1.6,
            display: 'block',
          }}
        >
          {tr(master.taglineKey)}
        </span>
      </div>

      {/* Bio paragraphs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

      {/* Famous trade — standout card */}
      <div
        style={{
          padding: '16px 18px',
          borderRadius: 12,
          background: `${type.color}0F`,
          borderLeft: `4px solid ${type.color}`,
          boxShadow: `0 2px 8px ${type.color}0A, 0 1px 3px rgba(0,0,0,0.12)`,
        }}
      >
        <p
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: type.color,
            margin: '0 0 8px 0',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          {tr('quizFamousTrade')}
        </p>
        <p
          style={{
            fontSize: 14,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.7,
            margin: 0,
          }}
        >
          {tr(master.famousTradeKey)}
        </p>
      </div>

      {/* Quote — premium blockquote with large opening quote mark */}
      <blockquote
        style={{
          margin: 0,
          padding: '20px 20px 16px 20px',
          borderLeft: `3px solid ${type.color}`,
          fontStyle: 'italic',
          color: 'var(--color-text-secondary)',
          fontSize: 'clamp(14px, 3.5vw, 15px)',
          lineHeight: 1.7,
          background: `${type.color}08`,
          borderRadius: '0 10px 10px 0',
          position: 'relative',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 8,
            left: 14,
            fontSize: 48,
            fontFamily: 'Georgia, serif',
            color: type.color,
            opacity: 0.35,
            lineHeight: 1,
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {'\u201C'}
        </span>
        <span style={{ position: 'relative', display: 'block', paddingTop: 20 }}>
          {tr(master.quoteKey)}
        </span>
      </blockquote>
    </div>
  )
}
