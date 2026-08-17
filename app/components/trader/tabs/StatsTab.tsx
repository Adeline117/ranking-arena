'use client'

/**
 * StatsTab — extracted from TraderProfileClient.tsx to isolate
 * reconciliation scope. SWR revalidations on overview/portfolio tabs
 * no longer trigger a re-render of this subtree.
 */

import React from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import type { TraderStats } from '@/lib/data/trader'
import type { HistoryCompleteness } from '@/lib/data/serving/types'
import type { Period } from '@/app/components/trader/performance/period-availability'
import type {
  AssetBreakdownData,
  PositionHistoryEntry,
} from '@/app/(app)/u/[handle]/components/types'

const StatsPage = dynamic(() => import('@/app/components/trader/stats/StatsPage'), {
  loading: () => <RankingSkeleton />,
})

type EquityCurveData = {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

export interface StatsTabProps {
  visited: boolean
  stats: TraderStats | null | undefined
  traderHandle: string
  assetBreakdown: AssetBreakdownData | undefined
  equityCurve: EquityCurveData | undefined
  /** The serving parent resolves the active timeframe before the shared tabs
   * render. Legacy callers leave this undefined to retain their old behavior. */
  selectedPeriod?: Period
  strictPeriod?: boolean
  positionHistory: PositionHistoryEntry[]
  historyCompleteness: HistoryCompleteness | null
  isPro: boolean
  onUnlock: () => void
}

const StatsTab = React.memo(function StatsTab({
  visited,
  stats,
  traderHandle,
  assetBreakdown,
  equityCurve,
  selectedPeriod,
  strictPeriod = false,
  positionHistory,
  historyCompleteness,
  isPro,
  onUnlock,
}: StatsTabProps) {
  const { t } = useLanguage()

  if (!visited) {
    return <RankingSkeleton />
  }

  if (
    stats ||
    equityCurve ||
    assetBreakdown ||
    positionHistory.length > 0 ||
    (historyCompleteness && historyCompleteness.state !== 'complete')
  ) {
    return (
      <StatsPage
        stats={stats}
        traderHandle={traderHandle}
        assetBreakdown={assetBreakdown}
        equityCurve={equityCurve}
        selectedPeriod={selectedPeriod}
        strictPeriod={strictPeriod}
        positionHistory={positionHistory}
        historyCompleteness={historyCompleteness}
        isPro={isPro}
        onUnlock={onUnlock}
      />
    )
  }

  return (
    <Box
      style={{
        padding: tokens.spacing[6],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        textAlign: 'center',
      }}
    >
      <Text size="sm" color="tertiary">
        {t('noStatsData')}
      </Text>
    </Box>
  )
})

export default StatsTab
