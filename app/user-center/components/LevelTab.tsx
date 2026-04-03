'use client'

import { tokens } from '@/lib/design-tokens'
import LevelBadge from '@/app/components/user/LevelBadge'
import { LEVELS, type LevelInfo } from '@/lib/utils/user-level'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getExpActionLabel } from '@/lib/utils/user-level'

interface ExpActionDisplay {
  key: string
  exp: number
  dailyLimit: number | null
}

interface LevelTabProps {
  info: LevelInfo & { currentExp: number }
  dailyEarned: number
  expActions: ExpActionDisplay[]
}

export default function LevelTab({ info, dailyEarned, expActions }: LevelTabProps) {
  const { t } = useLanguage()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[8] }}>
      {/* Current Level Card */}
      <div>
        <h3 style={{
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[4],
        }}>
          {t('userCenterCurrentLevel')}
        </h3>
        <div style={{
          background: tokens.glass.bg.light,
          backdropFilter: tokens.glass.blur.xs,
          WebkitBackdropFilter: tokens.glass.blur.xs,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          border: tokens.glass.border.light,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[5] }}>
            <div style={{
              flexShrink: 0, width: 64, height: 64, borderRadius: tokens.radius.xl,
              background: `linear-gradient(135deg, ${info.colorHex}22, ${info.colorHex}44)`,
              border: `2px solid ${info.colorHex}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <LevelBadge exp={info.currentExp} size="lg" showName={false} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.spacing[2], marginBottom: tokens.spacing[1], flexWrap: 'wrap' }}>
                <span style={{ fontSize: tokens.typography.fontSize.xl, fontWeight: tokens.typography.fontWeight.bold, color: info.colorHex }}>
                  Lv{info.level} {info.name}
                </span>
                <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
                  {info.nameEn}
                </span>
              </div>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary,
                marginBottom: tokens.spacing[2],
              }}>
                <span>EXP {info.currentExp.toLocaleString('en-US')}{info.nextExp ? ` / ${info.nextExp.toLocaleString('en-US')}` : ''}</span>
                <span style={{ color: tokens.colors.accent.success, fontWeight: tokens.typography.fontWeight.semibold }}>
                  +{dailyEarned} {t('userCenterToday')}
                </span>
              </div>
              <div style={{ height: 8, borderRadius: tokens.radius.full, background: tokens.colors.bg.hover, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: tokens.radius.full, width: `${info.progress}%`,
                  background: 'linear-gradient(90deg, var(--color-chart-violet), var(--color-brand), var(--color-accent-primary))',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Ways to Earn EXP */}
      <div>
        <h3 style={{
          fontSize: tokens.typography.fontSize.lg, fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.primary, marginBottom: tokens.spacing[4],
        }}>
          {t('userCenterWaysToEarnExp')}
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: tokens.spacing[3] }}>
          {expActions.map((action) => (
            <div key={action.key} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              background: tokens.glass.bg.light, backdropFilter: tokens.glass.blur.xs,
              WebkitBackdropFilter: tokens.glass.blur.xs, borderRadius: tokens.radius.lg,
              border: tokens.glass.border.light,
            }}>
              <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary }}>
                {getExpActionLabel(action.key, t)}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
                <span style={{
                  display: 'inline-block', padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full,
                  fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold,
                  background: 'var(--color-accent-success)', color: tokens.colors.white,
                }}>
                  +{action.exp}
                </span>
                {action.dailyLimit !== null && (
                  <span style={{
                    display: 'inline-block', padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full,
                    fontSize: tokens.typography.fontSize.xs, background: tokens.colors.bg.hover, color: tokens.colors.text.tertiary,
                  }}>
                    {action.dailyLimit}/{t('userCenterPerDay')}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Level Overview */}
      <div>
        <h3 style={{
          fontSize: tokens.typography.fontSize.lg, fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.primary, marginBottom: tokens.spacing[4],
        }}>
          {t('userCenterLevelOverview')}
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {LEVELS.map((lvl) => {
            const isCurrent = info.level === lvl.level
            return (
              <div key={lvl.level} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`, borderRadius: tokens.radius.lg,
                background: isCurrent ? `linear-gradient(135deg, ${lvl.colorHex}18, ${lvl.colorHex}08)` : tokens.glass.bg.light,
                backdropFilter: tokens.glass.blur.xs, WebkitBackdropFilter: tokens.glass.blur.xs,
                border: isCurrent ? `1.5px solid ${lvl.colorHex}` : tokens.glass.border.light,
                transition: `all ${tokens.transition.base}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], minWidth: 0 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 36, height: 36, borderRadius: tokens.radius.md,
                    background: `${lvl.colorHex}20`, color: lvl.colorHex,
                    fontWeight: tokens.typography.fontWeight.bold, fontSize: tokens.typography.fontSize.sm, flexShrink: 0,
                  }}>
                    {lvl.level}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: tokens.typography.fontWeight.semibold, color: isCurrent ? lvl.colorHex : tokens.colors.text.primary }}>
                        {lvl.name}
                      </span>
                      <span style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                        {lvl.nameEn}
                      </span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
                  {isCurrent && (
                    <span style={{
                      padding: `2px ${tokens.spacing[2]}`, borderRadius: tokens.radius.full,
                      fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold,
                      background: lvl.colorHex, color: tokens.colors.white,
                    }}>
                      {t('userCenterCurrent')}
                    </span>
                  )}
                  <span style={{
                    fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary, fontVariantNumeric: 'tabular-nums',
                  }}>
                    {lvl.minExp.toLocaleString('en-US')} EXP
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
