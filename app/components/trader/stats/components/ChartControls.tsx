'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'

interface PeriodSelectorProps {
  value: '7D' | '30D' | '90D'
  onChange: (v: '7D' | '30D' | '90D') => void
  t: (key: string) => string
}

export function PeriodSelector({
  value,
  onChange,
  t: _t
}: PeriodSelectorProps) {
  return (
    <Box
      style={{
        display: 'flex',
        gap: 4,
        background: tokens.colors.bg.tertiary,
        padding: 3,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {(['7D', '30D', '90D'] as const).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          style={{
            padding: `6px 14px`,
            minHeight: 36,
            borderRadius: tokens.radius.md,
            border: 'none',
            background: value === p ? tokens.colors.bg.primary : 'transparent',
            color: value === p ? tokens.colors.text.primary : tokens.colors.text.secondary,
            fontSize: 13,
            fontWeight: value === p ? 600 : 400,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            boxShadow: value === p ? '0 2px 8px var(--color-overlay-subtle)' : 'none',
          }}
        >
          {p}
        </button>
      ))}
    </Box>
  )
}

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

// Check if ROI data has any meaningful non-zero values
export function hasNonZeroRoi(data: Array<{ date: string; roi: number; pnl: number }>): boolean {
  return data.some(d => d.roi !== 0 && d.roi != null)
}

// Determine the best initial chart type based on available data
export function getBestChartType(equityCurve: EquityCurveData | undefined): 'roi' | 'pnl' {
  const data = equityCurve?.['90D'] || equityCurve?.['30D'] || equityCurve?.['7D'] || []
  if (!hasNonZeroRoi(data) && data.length > 0) {
    return 'pnl'
  }
  return 'roi'
}

// Auto-select the best period that has data (prefers 90D -> 30D -> 7D)
export function getBestInitialPeriod(equityCurve: EquityCurveData | undefined): '7D' | '30D' | '90D' {
  if (equityCurve?.['90D']?.length) return '90D'
  if (equityCurve?.['30D']?.length) return '30D'
  if (equityCurve?.['7D']?.length) return '7D'
  return '90D'
}
