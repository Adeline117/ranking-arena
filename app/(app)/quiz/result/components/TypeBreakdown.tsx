'use client'

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
    <div className="quiz-section-card">
      {/* Section header */}
      <div className="quiz-section-header">
        <div className="quiz-section-accent" style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))' }} />
        <h3 className="quiz-section-title">
          {tr('quizBreakdownTitle')}
        </h3>
      </div>

      {/* Sorted bars */}
      {sortedTypes.map(({ type, percent }) => {
        const isPrimary = type.id === primaryTypeId
        return (
          <div key={type.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{
              width: 80,
              fontSize: 13,
              fontWeight: isPrimary ? 700 : 500,
              color: isPrimary ? type.color : 'var(--color-text-secondary)',
              flexShrink: 0,
            }}>
              {tr(type.nameKey)}
            </span>
            <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
              <div style={{
                width: `${percent}%`,
                height: '100%',
                borderRadius: 4,
                background: isPrimary ? type.gradient : `${type.color}40`,
                transition: 'width 1s cubic-bezier(0.16, 1, 0.3, 1)',
              }} />
            </div>
            <span style={{
              width: 36,
              fontSize: 12,
              fontWeight: 600,
              color: isPrimary ? type.color : 'var(--color-text-tertiary)',
              textAlign: 'right',
              flexShrink: 0,
            }}>
              {percent}%
            </span>
          </div>
        )
      })}
    </div>
  )
}
