'use client'

import { tokens } from '@/lib/design-tokens'
import { PERSONALITY_TYPES } from '../../components/quiz-data'

interface TypeBreakdownProps {
  allTypePercents: Record<string, number>
  primaryTypeId: string
  tr: (key: string) => string
}

export default function TypeBreakdown({ allTypePercents, primaryTypeId, tr }: TypeBreakdownProps) {
  // Sort types by percentage descending
  const sortedTypes = PERSONALITY_TYPES
    .map((type) => ({ type, percent: allTypePercents[type.id] ?? 0 }))
    .sort((a, b) => b.percent - a.percent)

  return (
    <div style={{ borderRadius: 12, background: 'var(--color-bg-secondary)', border: '1px solid var(--glass-border-light)', padding: 'clamp(16px, 3vw, 24px)', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Section header with accent bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 3, height: 20, borderRadius: 2, background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))' }} />
        <h3 style={{ fontSize: tokens.typography.fontSize.lg, fontWeight: tokens.typography.fontWeight.bold, color: 'var(--color-text-primary)', margin: 0 }}>
          {tr('quizBreakdownTitle')}
        </h3>
      </div>

      {/* Sorted bars */}
      {sortedTypes.map(({ type, percent }) => (
        <div key={type.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 80, fontSize: 13, fontWeight: type.id === primaryTypeId ? 700 : 500, color: type.id === primaryTypeId ? type.color : 'var(--color-text-secondary)', flexShrink: 0 }}>
            {tr(type.nameKey)}
          </span>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
            <div style={{ width: `${percent}%`, height: '100%', borderRadius: 4, background: type.id === primaryTypeId ? type.gradient : `${type.color}40`, transition: 'width 1s ease' }} />
          </div>
          <span style={{ width: 36, fontSize: 12, fontWeight: 600, color: type.id === primaryTypeId ? type.color : 'var(--color-text-tertiary)', textAlign: 'right', flexShrink: 0 }}>
            {percent}%
          </span>
        </div>
      ))}
    </div>
  )
}
