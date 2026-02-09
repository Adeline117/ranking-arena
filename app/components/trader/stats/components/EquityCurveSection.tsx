'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../../base'
import { useLanguage } from '../../../Providers/LanguageProvider'
import { CompactErrorBoundary } from '../../../utils/ErrorBoundary'

// Lazy load heavy chart component
const TradingViewShell = dynamic(() => import('../../TradingViewShell'), {
  loading: () => (
    <Box style={{
      height: 300,
      background: tokens.colors.bg.tertiary,
      borderRadius: tokens.radius.lg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <Text size="sm" color="tertiary">Loading chart...</Text>
    </Box>
  ),
  ssr: false,
})

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface EquityCurveSectionProps {
  equityCurve?: EquityCurveData
  traderHandle: string
  delay: number
}

export function EquityCurveSection({
  equityCurve,
  traderHandle,
  delay
}: EquityCurveSectionProps) {
  const { t } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>('90D')
  const [chartType, setChartType] = useState<'roi' | 'pnl'>('roi')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])

  const currentData = equityCurve?.[period] || []
  const hasData = currentData.length > 0

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
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        {/* Chart Type Toggle */}
        <Box
          style={{
            display: 'flex',
            gap: 2,
            background: tokens.colors.bg.tertiary,
            padding: 3,
            borderRadius: tokens.radius.lg,
          }}
        >
          {(['roi', 'pnl'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: chartType === type
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                  : 'transparent',
                color: chartType === type ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.bold,
                cursor: 'pointer',
                transition: 'all 0.25s ease',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {type === 'roi' ? t('roi') : t('pnl')}
            </button>
          ))}
        </Box>

        {/* Period Selector */}
        <PeriodSelector value={period} onChange={setPeriod} t={t} />
      </Box>

      {hasData ? (
        <Box className="chart-container" style={{ height: 280 }}>
          <SimpleLineChart
            data={currentData}
            dataKey={chartType}
            period={period}
          />
        </Box>
      ) : (
        <Box
          style={{
            overflow: 'hidden',
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <CompactErrorBoundary>
            <TradingViewShell symbol={traderHandle} timeframe={period} />
          </CompactErrorBoundary>
        </Box>
      )}
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

// Simple Line Chart
function SimpleLineChart({
  data,
  dataKey,
  period,
}: {
  data: Array<{ date: string; roi: number; pnl: number }>
  dataKey: 'roi' | 'pnl'
  period: string
}) {
  const { language } = useLanguage()
  if (data.length === 0) {
    return (
      <Box style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.colors.bg.primary,
        borderRadius: tokens.radius.lg,
      }}>
        <Text size="sm" color="tertiary">{language === 'zh' ? `该时段 (${period}) 暂无链上记录` : `No on-chain activity for ${period}`}</Text>
      </Box>
    )
  }

  const values = data.map(d => d[dataKey])
  const maxValue = Math.max(...values)
  const minValue = Math.min(...values)
  const range = maxValue - minValue || 1

  const width = 100
  const height = 100
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((d[dataKey] - minValue) / range) * height
    return `${x},${y}`
  })
  const pathD = `M ${points.join(' L ')}`

  const isPositive = values[values.length - 1] >= values[0]
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  return (
    <Box style={{
      height: '100%',
      background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}40 100%)`,
      borderRadius: tokens.radius.xl,
      padding: tokens.spacing[4],
      position: 'relative',
      border: `1px solid ${tokens.colors.border.primary}40`,
    }}>
      {/* Y-axis Labels */}
      <Box style={{
        position: 'absolute',
        left: tokens.spacing[3],
        top: tokens.spacing[4],
        bottom: tokens.spacing[8],
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          {dataKey === 'roi' ? `${maxValue.toFixed(0)}%` : `$${(maxValue / 1000).toFixed(0)}K`}
        </Text>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          {dataKey === 'roi' ? `${minValue.toFixed(0)}%` : `$${(minValue / 1000).toFixed(0)}K`}
        </Text>
      </Box>

      {/* Chart Area */}
      <Box style={{
        marginLeft: 55,
        height: 'calc(100% - 32px)',
        position: 'relative',
      }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%' }}
        >
          {/* Grid */}
          {[0, 25, 50, 75, 100].map(y => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} stroke={tokens.colors.border.primary} strokeWidth="0.3" strokeDasharray="2,2" />
          ))}

          {/* Area Fill */}
          <path
            d={`${pathD} L 100,100 L 0,100 Z`}
            fill={`url(#gradient-${isPositive ? 'positive' : 'negative'})`}
            opacity="0.3"
          />

          {/* Line */}
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Gradient Definitions */}
          <defs>
            <linearGradient id="gradient-positive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.success} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.success} stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gradient-negative" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.error} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.error} stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </Box>

      {/* X-axis Labels */}
      <Box style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginLeft: 55,
        marginTop: tokens.spacing[2],
      }}>
        <Text size="xs" color="tertiary">
          {data[0]?.date ? new Date(data[0].date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
        <Text size="xs" color="tertiary">
          {data[data.length - 1]?.date ? new Date(data[data.length - 1].date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
      </Box>
    </Box>
  )
}
