'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getExpActionLabel, type ExpAction } from '@/lib/utils/user-level'
import type { LevelInfo } from '@/lib/utils/user-level'

interface ExpActionDisplay extends ExpAction {}

interface LevelTabProps {
  info: LevelInfo
  dailyEarned: number
  expActions: ExpActionDisplay[]
}

export default function LevelTab({ info, dailyEarned, expActions }: LevelTabProps) {
  const { t } = useLanguage()
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacing[3] }}>
        {expActions.map((action) => (
          <div key={action.key} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}>
            <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary }}>
              {getExpActionLabel(action.key, t)}
            </span>
            <span style={{
              padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold,
              background: `${tokens.colors.accent.primary}15`, color: tokens.colors.accent.primary,
            }}>
              +{action.exp} EXP
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
