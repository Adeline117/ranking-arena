'use client'

import { tokens } from '@/lib/design-tokens'
import type { PersonalityType } from '../../components/types'

interface MasterSectionProps {
  type: PersonalityType
  tr: (key: string) => string
}

export default function MasterSection({ type, tr }: MasterSectionProps) {
  const { master } = type

  return (
    <div
      style={{
        borderRadius: 14,
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--glass-border-light)',
        padding: 'clamp(18px, 3.5vw, 28px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 0, /* Controlled spacing for rhythm */
      }}
    >
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
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
          {tr('quizMasterTitle')}
        </h3>
      </div>

      {/* Master name + years — tight grouping */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6 }}>
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
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: 400,
            color: 'var(--color-text-tertiary)',
          }}
        >
          {tr(master.yearsKey)}
        </span>
      </div>

      {/* Tagline — italic, moderate weight */}
      <span
        style={{
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 500,
          color: 'var(--color-text-secondary)',
          fontStyle: 'italic',
          marginBottom: 16,
          lineHeight: 1.5,
        }}
      >
        {tr(master.taglineKey)}
      </span>

      {/* Bio paragraphs — generous line height for readability */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
        {master.bioKeys.map((key) => (
          <p
            key={key}
            style={{
              fontSize: tokens.typography.fontSize.base,
              fontWeight: 400,
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
          marginBottom: 14,
        }}
      >
        <p
          style={{
            fontSize: tokens.typography.fontSize.xs,
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
            fontSize: tokens.typography.fontSize.base,
            fontWeight: 400,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.65,
            margin: 0,
          }}
        >
          {tr(master.famousTradeKey)}
        </p>
      </div>

      {/* Quote — larger border accent */}
      <blockquote
        style={{
          margin: 0,
          padding: '12px 18px',
          borderLeft: `3px solid ${type.color}`,
          fontStyle: 'italic',
          fontWeight: 400,
          color: 'var(--color-text-secondary)',
          fontSize: '15px',
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
