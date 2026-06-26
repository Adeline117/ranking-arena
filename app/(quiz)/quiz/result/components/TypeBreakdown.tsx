'use client'

import { PERSONALITY_TYPES } from '../../components/quiz-data'
import { alpha } from '@/lib/design-tokens'

interface TypeBreakdownProps {
  allTypePercents: Record<string, number>
  primaryTypeId: string
  tr: (key: string) => string
}

// ─── 4 MBTI-style color groups ─────────────────────────────────────
const COLOR_GROUPS = [
  {
    labelKey: 'quizGroupInsight',
    fallbackLabel: 'Insight',
    accentColor: '#8B5CF6',
    typeIds: ['sniper', 'analyst', 'strategist'],
  },
  {
    labelKey: 'quizGroupLongTerm',
    fallbackLabel: 'Long-Term',
    accentColor: '#10B981',
    typeIds: ['hodler', 'narrator', 'whale'],
  },
  {
    labelKey: 'quizGroupExecution',
    fallbackLabel: 'Execution',
    accentColor: '#3B82F6',
    typeIds: ['scalper', 'copycat', 'tourist'],
  },
  {
    labelKey: 'quizGroupContrarian',
    fallbackLabel: 'Contrarian',
    accentColor: '#EF4444',
    typeIds: ['contrarian', 'degen', 'paperhands'],
  },
] as const

// Pre-build a type-id lookup map
const TYPE_MAP = Object.fromEntries(PERSONALITY_TYPES.map((t) => [t.id, t]))

export default function TypeBreakdown({ allTypePercents, primaryTypeId, tr }: TypeBreakdownProps) {
  // Build grouped data: each group's types sorted by percentage descending
  const groups = COLOR_GROUPS.map((group) => {
    const types = group.typeIds
      .map((id) => ({
        type: TYPE_MAP[id],
        percent: allTypePercents[id] ?? 0,
      }))
      .sort((a, b) => b.percent - a.percent)
    return { ...group, types }
  })

  // Sort groups so the group containing the primary type comes first,
  // then by highest percentage within each group
  groups.sort((a, b) => {
    const aHasPrimary = (a.typeIds as readonly string[]).includes(primaryTypeId) ? 1 : 0
    const bHasPrimary = (b.typeIds as readonly string[]).includes(primaryTypeId) ? 1 : 0
    if (aHasPrimary !== bHasPrimary) return bHasPrimary - aHasPrimary
    const aMax = Math.max(...a.types.map((t) => t.percent))
    const bMax = Math.max(...b.types.map((t) => t.percent))
    return bMax - aMax
  })

  return (
    <div className="quiz-section-card">
      {/* Section header */}
      <div className="quiz-section-header">
        <div
          className="quiz-section-accent"
          style={{
            background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))',
          }}
        />
        <h3 className="quiz-section-title">{tr('quizBreakdownTitle')}</h3>
      </div>

      {/* Grouped breakdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {groups.map((group, groupIdx) => {
          const groupLabel = tr(group.labelKey) || group.fallbackLabel
          return (
            <div key={group.labelKey}>
              {/* Group label + accent line */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    width: 3,
                    height: 14,
                    borderRadius: 2,
                    background: group.accentColor,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    fontSize: 'clamp(11px, 2.8vw, 12px)',
                    fontWeight: 600,
                    color: group.accentColor,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    opacity: 0.85,
                  }}
                >
                  {groupLabel}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 1,
                    background: `${alpha(group.accentColor, 15)}`,
                  }}
                />
              </div>

              {/* Type rows within this group */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {group.types.map(({ type, percent }) => {
                  const isPrimary = type.id === primaryTypeId
                  return (
                    <div
                      key={type.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'clamp(8px, 2vw, 12px)',
                        padding: isPrimary ? '8px 10px' : '4px 6px',
                        borderRadius: isPrimary ? 10 : 6,
                        background: isPrimary ? `${alpha(type.color, 10)}` : 'transparent',
                        border: isPrimary
                          ? `1px solid ${alpha(type.color, 15)}`
                          : '1px solid transparent',
                        transition: 'background 0.3s, border-color 0.3s',
                      }}
                    >
                      {/* Type name — wider column, responsive */}
                      <span
                        style={{
                          width: 'clamp(90px, 28vw, 130px)',
                          fontSize: isPrimary
                            ? 'clamp(12px, 3vw, 13px)'
                            : 'clamp(11px, 2.8vw, 12px)',
                          fontWeight: isPrimary ? 700 : 400,
                          color: isPrimary ? type.color : 'var(--color-text-secondary)',
                          flexShrink: 0,
                          lineHeight: 1.3,
                        }}
                      >
                        {tr(type.nameKey)}
                      </span>

                      {/* Bar track */}
                      <div
                        style={{
                          flex: 1,
                          height: isPrimary ? 12 : 6,
                          borderRadius: isPrimary ? 6 : 3,
                          background: isPrimary
                            ? `${alpha(type.color, 6)}`
                            : 'var(--color-bg-tertiary)',
                          overflow: 'hidden',
                          transition: 'height 0.3s',
                        }}
                      >
                        {/* Bar fill */}
                        <div
                          style={{
                            width: `${percent}%`,
                            height: '100%',
                            borderRadius: 'inherit',
                            background: isPrimary ? type.gradient : `${alpha(type.color, 30)}`,
                            transition: 'width 1s cubic-bezier(0.16, 1, 0.3, 1)',
                            boxShadow: isPrimary ? `0 0 8px ${alpha(type.color, 25)}` : 'none',
                          }}
                        />
                      </div>

                      {/* Percentage */}
                      <span
                        style={{
                          width: 'clamp(32px, 10vw, 42px)',
                          fontSize: isPrimary
                            ? 'clamp(13px, 3.2vw, 14px)'
                            : 'clamp(11px, 2.8vw, 12px)',
                          fontWeight: isPrimary ? 700 : 500,
                          color: isPrimary ? type.color : 'var(--color-text-tertiary)',
                          textAlign: 'right',
                          flexShrink: 0,
                          fontVariantNumeric: 'tabular-nums',
                          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                        }}
                      >
                        {percent}%
                      </span>
                    </div>
                  )
                })}
              </div>

              {/* Subtle divider between groups (not after last) */}
              {groupIdx < groups.length - 1 && (
                <div
                  style={{
                    height: 1,
                    marginTop: 16,
                    background:
                      'linear-gradient(90deg, transparent 0%, var(--color-border-primary) 30%, var(--color-border-primary) 70%, transparent 100%)',
                    opacity: 0.3,
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
