'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../../base'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import { useLanguage } from '../../../Providers/LanguageProvider'

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

  if (currentData.length === 0) {
    return (
      <Box
        className="stats-card glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          padding: tokens.spacing[6],
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(20px)',
          transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <Text size="lg" weight="black">{t('assetBreakdown')}</Text>
          </Box>
          <PeriodSelector value={period} onChange={setPeriod} t={t} />
        </Box>
        <Box style={{
          padding: tokens.spacing[8],
          textAlign: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Text size="sm" color="tertiary">
            资产分布数据暂不可用
          </Text>
        </Box>
      </Box>
    )
  }

  const totalPct = currentData.reduce((sum, item) => sum + item.weightPct, 0)

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
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
            boxShadow: `inset 0 2px 4px rgba(0, 0, 0, 0.1)`,
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
                transition: 'all 0.3s ease',
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
      <Box className="asset-grid" style={{
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
              transition: 'all 0.2s ease',
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
            transition: 'all 0.2s ease',
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
    '#3B82F6', // Blue
    '#F59E0B', // Amber
    '#10B981', // Emerald
    '#8B5CF6', // Violet
    '#EF4444', // Red
    '#06B6D4', // Cyan
    '#F97316', // Orange
    '#84CC16', // Lime
    '#EC4899', // Pink
    '#6366F1', // Indigo
  ]
  return colors[idx % colors.length]
}
