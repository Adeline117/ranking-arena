'use client'

import { tokens } from '@/lib/design-tokens'

interface UsageStatProps {
  label: string
  value: number
  max: number
}

export function UsageStat({ label, value, max }: UsageStatProps) {
  const percentage = Math.min((value / max) * 100, 100)
  const isHigh = percentage > 80

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginBottom: 8,
        fontSize: 13,
      }}>
        <span style={{ color: tokens.colors.text.secondary }}>{label}</span>
        <span style={{ fontWeight: 600, color: tokens.colors.text.primary }}>{value} / {max}</span>
      </div>
      <div style={{
        height: 8,
        background: tokens.colors.bg.hover,
        borderRadius: tokens.radius.full,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${percentage}%`,
          background: isHigh ? tokens.colors.accent.warning : tokens.colors.accent.brand,
          borderRadius: tokens.radius.full,
          transition: 'width 0.3s ease',
        }} />
      </div>
    </div>
  )
}

interface UsageStatsCardProps {
  followedTraders: number
  maxFollows: number
  cardStyle: React.CSSProperties
  t: (key: string) => string
}

export default function UsageStatsCard({ followedTraders, maxFollows, cardStyle, t }: UsageStatsCardProps) {
  return (
    <div style={cardStyle}>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: tokens.colors.text.primary }}>
        {t('usageStatsTitle')}
      </h3>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 16,
      }}>
        <UsageStat
          label={t('followedTradersUsage')}
          value={followedTraders}
          max={maxFollows}
        />
      </div>
    </div>
  )
}
