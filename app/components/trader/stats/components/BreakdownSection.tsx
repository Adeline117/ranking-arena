'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface AssetBreakdownData {
  '90D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '7D': Array<{ symbol: string; weightPct: number }>
}

interface BreakdownSectionProps {
  assetBreakdown?: AssetBreakdownData
  fallbackData: Array<{ symbol: string; weightPct: number }>
  delay: number
}

export function BreakdownSection({
  assetBreakdown,
  fallbackData,
  delay,
}: BreakdownSectionProps) {
  const { t } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>('90D')
  const [mounted, setMounted] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])

  const currentData = assetBreakdown?.[period] || fallbackData

  // 没有数据时，检查所有周期是否都为空
  const allPeriodsEmpty = !assetBreakdown || (
    (!assetBreakdown['90D'] || assetBreakdown['90D'].length === 0) &&
    (!assetBreakdown['30D'] || assetBreakdown['30D'].length === 0) &&
    (!assetBreakdown['7D'] || assetBreakdown['7D'].length === 0)
  )

  if (allPeriodsEmpty && fallbackData.length === 0) {
    return null
  }

  if (currentData.length === 0) {
    return null
  }

  const totalPct = currentData.reduce((sum, item) => sum + item.weightPct, 0) || 1

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[5] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">{t('assetBreakdown')}</Text>
        </Box>
        <PeriodSelector value={period} onChange={setPeriod} t={t} />
      </Box>

      {/* Horizontal Bar Chart */}
      <Box style={{ marginBottom: tokens.spacing[5] }}>
        <Box
          style={{
            display: 'flex',
            height: 32,
            borderRadius: tokens.radius.xl,
            overflow: 'hidden',
            background: tokens.colors.bg.tertiary,
            boxShadow: `inset 0 2px 4px var(--color-overlay-subtle)`,
          }}
        >
          {currentData.slice(0, 10).map((item, idx) => (
            <Box
              key={idx}
              className="asset-bar"
              style={{
                width: `${(item.weightPct / totalPct) * 100}%`,
                background: getColorForIndex(idx),
                minWidth: 4,
                transition: `all ${tokens.transition.slow}`,
                opacity: hoveredIndex === null || hoveredIndex === idx ? 1 : 0.4,
                transform: hoveredIndex === idx ? 'scaleY(1.15)' : 'scaleY(1)',
              }}
              title={`${item.symbol}: ${item.weightPct.toFixed(2)}%`}
              onMouseEnter={() => setHoveredIndex(idx)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          ))}
        </Box>
      </Box>

      {/* Asset List */}
      <Box className="asset-grid trading-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: tokens.spacing[3],
      }}>
        {currentData.slice(0, 12).map((item, idx) => (
          <Box
            key={idx}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
              background: hoveredIndex === idx ? `${getColorForIndex(idx)}15` : 'transparent',
              transition: `all ${tokens.transition.base}`,
              cursor: 'default',
            }}
            onMouseEnter={() => setHoveredIndex(idx)}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <Box
              style={{
                width: 10,
                height: 10,
                borderRadius: tokens.radius.sm,
                background: getColorForIndex(idx),
                flexShrink: 0,
                boxShadow: `0 2px 4px ${getColorForIndex(idx)}40`,
              }}
            />
            <CryptoIcon symbol={item.symbol} size={16} />
            <Text size="sm" weight="bold" style={{ flex: 1, color: tokens.colors.text.primary }}>{item.symbol}</Text>
            <Text
              size="sm"
              style={{
                color: tokens.colors.text.secondary,
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
              }}
            >
              {item.weightPct.toFixed(1)}%
            </Text>
          </Box>
        ))}
      </Box>

      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[4] }}>
        *数据每 1-2 小时刷新一次
      </Text>
    </Box>
  )
}

// Period Selector Component
function PeriodSelector({
  value,
  onChange,
  t: _t
}: {
  value: '7D' | '30D' | '90D'
  onChange: (v: '7D' | '30D' | '90D') => void
  t: (key: string) => string
}) {
  return (
    <Box
      style={{
        display: 'flex',
        gap: 2,
        background: tokens.colors.bg.tertiary,
        padding: 2,
        borderRadius: tokens.radius.md,
      }}
    >
      {(['7D', '30D', '90D'] as const).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.sm,
            border: 'none',
            background: value === p ? tokens.colors.bg.primary : 'transparent',
            color: value === p ? tokens.colors.text.primary : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: value === p ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {p}
        </button>
      ))}
    </Box>
  )
}

function getColorForIndex(idx: number): string {
  const colors = [
    'var(--color-score-profitability)', // Blue
    'var(--color-score-average)', // Amber
    'var(--color-score-great)', // Emerald
    'var(--color-verified-web3)', // Violet
    'var(--color-accent-error)', // Red
    'var(--color-enterprise-gradient-start)', // Cyan
    'var(--color-score-below)', // Orange
    'var(--color-accent-success)', // Lime
    'var(--color-chart-pink)', // Pink
    'var(--color-chart-indigo)', // Indigo
  ]
  return colors[idx % colors.length]
}
