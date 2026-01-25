'use client'

/**
 * Dynamic Chart Components
 *
 * Lazy loads heavy chart components (lightweight-charts ~200KB)
 * to improve initial bundle size and page load performance.
 *
 * Usage:
 *   import { DynamicEquityCurve, DynamicPnLChart } from '@/app/components/charts/dynamic'
 */

import dynamic from 'next/dynamic'
import { Box } from '../base'
import { tokens } from '@/lib/design-tokens'

// Loading skeleton for charts
function ChartSkeleton({ height = 300 }: { height?: number }) {
  return (
    <Box
      style={{
        height,
        background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        borderRadius: tokens.radius.lg,
      }}
    />
  )
}

// Equity Curve - Dynamically loaded
export const DynamicEquityCurve = dynamic(
  () => import('./EquityCurve'),
  {
    loading: () => <ChartSkeleton height={300} />,
    ssr: false, // Charts require browser APIs
  }
)

// PnL Chart - Dynamically loaded
export const DynamicPnLChart = dynamic(
  () => import('./PnLChart'),
  {
    loading: () => <ChartSkeleton height={300} />,
    ssr: false,
  }
)

// Drawdown Chart - Dynamically loaded
export const DynamicDrawdownChart = dynamic(
  () => import('./DrawdownChart'),
  {
    loading: () => <ChartSkeleton height={200} />,
    ssr: false,
  }
)

// Re-export types for convenience
export type { EquityCurveProps, EquityDataPoint } from './EquityCurve'
export type { PnLChartProps, PnLDataPoint } from './PnLChart'
export type { DrawdownChartProps, DrawdownDataPoint } from './DrawdownChart'
