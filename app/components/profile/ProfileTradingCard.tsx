'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Performance = {
  roi_90d?: number | null
  pnl_90d?: number | null
  arena_score?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
}

type EquityPoint = { date: string; roi: number }

function MiniSparkline({ data }: { data: EquityPoint[] }) {
  if (!data || data.length < 2) return null
  const values = data.map(d => d.roi)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const w = 200
  const h = 40
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x},${y}`
  }).join(' ')
  const isPositive = values[values.length - 1] >= values[0]
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function formatPct(val: number | null | undefined): string {
  if (val == null) return '--'
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`
}

function formatPnl(val: number | null | undefined): string {
  if (val == null) return '--'
  const abs = Math.abs(val)
  const str = abs >= 1000 ? `${(abs / 1000).toFixed(1)}K` : abs.toFixed(0)
  return `${val >= 0 ? '+' : '-'}$${str}`
}

export default function ProfileTradingCard({
  performance,
  equityCurve,
  traderHandle,
  source,
}: {
  performance: Performance | null
  equityCurve?: EquityPoint[]
  traderHandle: string
  source?: string
}) {
  const { language } = useLanguage()
  const isZh = language === 'zh'

  if (!performance) return null

  const roi = performance.roi_90d
  const isPositive = (roi ?? 0) >= 0

  return (
    <Box
      bg="secondary"
      p={4}
      radius="lg"
      border="primary"
      style={{
        background: `linear-gradient(135deg, ${tokens.colors.bg.secondary}F8 0%, ${isPositive ? tokens.colors.accent.success : tokens.colors.accent.error}08 100%)`,
      }}
    >
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[3] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">📊 {isZh ? '交易数据' : 'Trading'}</Text>
          {source && (
            <Box style={{
              padding: '1px 8px', borderRadius: tokens.radius.full,
              background: `${tokens.colors.accent.primary}15`,
              border: `1px solid ${tokens.colors.accent.primary}30`,
            }}>
              <Text style={{ fontSize: 10, fontWeight: 700, color: tokens.colors.accent.primary, textTransform: 'uppercase' }}>
                {source}
              </Text>
            </Box>
          )}
        </Box>
        <Link
          href={`/trader/${encodeURIComponent(traderHandle)}`}
          style={{ color: tokens.colors.accent.primary, fontSize: tokens.typography.fontSize.xs, textDecoration: 'none', fontWeight: 600 }}
        >
          {isZh ? '详情' : 'Details'} →
        </Link>
      </Box>

      {/* Stats grid */}
      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: tokens.spacing[3], marginBottom: tokens.spacing[3] }}>
        <StatItem label={isZh ? '90日收益率' : '90D ROI'} value={formatPct(performance.roi_90d)} isPositive={(performance.roi_90d ?? 0) >= 0} />
        <StatItem label={isZh ? '90日盈亏' : '90D PnL'} value={formatPnl(performance.pnl_90d)} isPositive={(performance.pnl_90d ?? 0) >= 0} />
        <StatItem label="Arena Score" value={performance.arena_score?.toFixed(0) ?? '--'} />
        <StatItem label={isZh ? '胜率' : 'Win Rate'} value={performance.win_rate != null ? `${(performance.win_rate * 100).toFixed(1)}%` : '--'} />
      </Box>

      {/* Mini equity curve */}
      {equityCurve && equityCurve.length > 1 && (
        <Box style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          background: `${tokens.colors.bg.primary}80`,
          borderRadius: tokens.radius.md,
        }}>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            {isZh ? '收益曲线 (90日)' : 'Equity Curve (90D)'}
          </Text>
          <MiniSparkline data={equityCurve} />
        </Box>
      )}
    </Box>
  )
}

function StatItem({ label, value, isPositive }: { label: string; value: string; isPositive?: boolean }) {
  return (
    <Box>
      <Text size="xs" color="tertiary">{label}</Text>
      <Text
        size="lg"
        weight="black"
        style={{
          color: isPositive === undefined
            ? tokens.colors.text.primary
            : isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
        }}
      >
        {value}
      </Text>
    </Box>
  )
}
