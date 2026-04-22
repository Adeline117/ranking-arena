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

      {/* Sorted bars — primary type gets visual emphasis */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sortedTypes.map(({ type, percent }, idx) => {
          const isPrimary = type.id === primaryTypeId
          return (
            <div
              key={type.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: isPrimary ? '8px 10px' : '4px 0',
                borderRadius: isPrimary ? 8 : 0,
                background: isPrimary ? `${type.color}08` : 'transparent',
                transition: 'background 0.3s',
              }}
            >
              <span style={{
                width: 80,
                fontSize: isPrimary ? 13 : 12,
                fontWeight: isPrimary ? 700 : 400,
                color: isPrimary ? type.color : 'var(--color-text-tertiary)',
                flexShrink: 0,
              }}>
                {tr(type.nameKey)}
              </span>
              <div style={{
                flex: 1,
                height: isPrimary ? 10 : 6,
                borderRadius: isPrimary ? 5 : 3,
                background: 'var(--color-bg-tertiary)',
                overflow: 'hidden',
                transition: 'height 0.3s',
              }}>
                <div style={{
                  width: `${percent}%`,
                  height: '100%',
                  borderRadius: 'inherit',
                  background: isPrimary ? type.gradient : `${type.color}30`,
                  transition: 'width 1s cubic-bezier(0.16, 1, 0.3, 1)',
                  boxShadow: isPrimary ? `0 0 6px ${type.color}30` : 'none',
                }} />
              </div>
              <span style={{
                width: 36,
                fontSize: isPrimary ? 13 : 11,
                fontWeight: isPrimary ? 700 : 500,
                color: isPrimary ? type.color : 'var(--color-text-tertiary)',
                textAlign: 'right',
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {percent}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
