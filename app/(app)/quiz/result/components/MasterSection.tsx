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
          {tr('quizMasterTitle')}
        </h3>
      </div>

      {/* Master name + years */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h4
          style={{
            fontSize: 'clamp(16px, 3.5vw, 20px)',
            fontWeight: tokens.typography.fontWeight.bold,
            color: type.color,
            margin: 0,
          }}
        >
          {tr(master.nameKey)}
        </h4>
        <span
          style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-tertiary)',
          }}
        >
          {tr(master.yearsKey)}
        </span>
        <span
          style={{
            fontSize: tokens.typography.fontSize.base,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: 'var(--color-text-secondary)',
            fontStyle: 'italic',
            marginTop: 4,
          }}
        >
          {tr(master.taglineKey)}
        </span>
      </div>

      {/* Bio paragraphs */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {master.bioKeys.map((key) => (
          <p
            key={key}
            style={{
              fontSize: tokens.typography.fontSize.base,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.7,
              margin: 0,
            }}
          >
            {tr(key)}
          </p>
        ))}
      </div>

      {/* Famous trade */}
      <div
        style={{
          padding: '12px 16px',
          borderRadius: 8,
          background: `${type.color}12`,
          border: `1px solid ${type.color}20`,
        }}
      >
        <p
          style={{
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.semibold,
            color: type.color,
            margin: '0 0 4px 0',
          }}
        >
          {tr('quizFamousTrade')}
        </p>
        <p
          style={{
            fontSize: tokens.typography.fontSize.base,
            color: 'var(--color-text-secondary)',
            lineHeight: 1.6,
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
          padding: '10px 16px',
          borderLeft: `3px solid ${type.color}`,
          fontStyle: 'italic',
          color: 'var(--color-text-secondary)',
          fontSize: tokens.typography.fontSize.base,
          lineHeight: 1.6,
        }}
      >
        &ldquo;{tr(master.quoteKey)}&rdquo;
      </blockquote>
    </div>
  )
}
