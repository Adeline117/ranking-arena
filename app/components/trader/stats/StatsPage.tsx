'use client'

import { useState, useEffect } from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box } from '../../base'
import ProGate from '../../ui/ProGate'
import type { TraderStats } from '@/lib/data/trader'
import { useLanguage } from '../../Providers/LanguageProvider'
import { TradingSection } from './components/TradingSection'
import { EquityCurveSection } from './components/EquityCurveSection'
import { BreakdownSection } from './components/BreakdownSection'
// U2-6: "对比分析 / Compare vs BTC" card removed. Its benchmark series was
// FABRICATED (seeded-random, not a real BTC/SPX500 price series) and the legend
// value was hardcoded to N/A, so the card only ever compared the trader against
// noise while claiming to be a BTC benchmark. Until a real market-data series is
// wired in, we do not ship a fake comparison. The equity curve now spans full
// width. ComparePortfolioSection is kept in the tree (unrendered) for the future
// real-data wiring.
import { SectionErrorBoundary } from '../../utils/ErrorBoundary'
import { PnlCalendarHeatmap } from '../charts/PnlCalendarHeatmap'

// 扩展类型以支持新数据
interface AssetBreakdownData {
  '90D': Array<{ symbol: string; weightPct: number }>
  '30D': Array<{ symbol: string; weightPct: number }>
  '7D': Array<{ symbol: string; weightPct: number }>
}

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface PositionHistoryItem {
  symbol: string
  direction: string
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

interface ExtendedStatsPageProps {
  stats: TraderStats | null | undefined
  traderHandle: string
  assetBreakdown?: AssetBreakdownData
  equityCurve?: EquityCurveData
  positionHistory?: PositionHistoryItem[]
  isPro?: boolean
  onUnlock?: () => void
}

export default function StatsPage({
  stats,
  traderHandle,
  assetBreakdown,
  equityCurve,
  positionHistory = [],
  isPro = true,
  onUnlock: _onUnlock, // ProGate handles the upgrade CTA itself
}: ExtendedStatsPageProps) {
  const { t, language: _language } = useLanguage()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // UF10: Skeleton placeholder while chart is loading
  if (!mounted) {
    return (
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[6] }}>
        {/* Breakdown skeleton */}
        <Box
          style={{
            height: 200,
            borderRadius: tokens.radius.xl,
            background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'statsSkeletonPulse 1.5s ease-in-out infinite',
          }}
        />
        {/* Chart skeletons */}
        <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacing[6] }}>
          {[1, 2].map((i) => (
            <Box
              key={i}
              style={{
                height: 280,
                borderRadius: tokens.radius.xl,
                background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
                backgroundSize: '200% 100%',
                animation: 'statsSkeletonPulse 1.5s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </Box>
        {/* Trading section skeleton */}
        <Box
          style={{
            height: 300,
            borderRadius: tokens.radius.xl,
            background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'statsSkeletonPulse 1.5s ease-in-out infinite',
            animationDelay: '0.4s',
          }}
        />
        {/* statsSkeletonPulse keyframes moved to globals.css (#26) */}
      </Box>
    )
  }

  const frequentlyTraded = stats?.frequentlyTraded || []
  const trading = stats?.trading
  const additionalStats = stats?.additionalStats

  const statsContent = (
    <Box>
      {/* Asset Breakdown - 没数据时自动隐藏 */}
      <BreakdownSection assetBreakdown={assetBreakdown} fallbackData={frequentlyTraded} delay={0} />

      {/* PnL Calendar Heatmap — daily profit/loss visualization */}
      {equityCurve?.['90D'] && equityCurve['90D'].length > 3 && (
        <Box
          className="glass-card"
          style={{
            padding: tokens.spacing[5],
            background: `linear-gradient(145deg, ${alpha(tokens.colors.bg.secondary, 97)} 0%, ${alpha(tokens.colors.bg.primary, 94)} 100%)`,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${alpha(tokens.colors.border.primary, 38)}`,
            marginTop: tokens.spacing[6],
          }}
        >
          <PnlCalendarHeatmap data={equityCurve['90D']} days={90} />
        </Box>
      )}

      {/* Equity curve (full width). U2-6: fabricated "Compare vs BTC" card removed. */}
      <Box style={{ marginTop: tokens.spacing[6] }}>
        <SectionErrorBoundary fallbackMessage="">
          <EquityCurveSection equityCurve={equityCurve} traderHandle={traderHandle} delay={0.1} />
        </SectionErrorBoundary>
      </Box>

      {/* Trading Section - 没数据时自动隐藏 */}
      <Box style={{ marginTop: tokens.spacing[6] }}>
        <TradingSection
          trading={trading}
          additionalStats={additionalStats}
          positionHistory={positionHistory}
          t={t}
          delay={0.2}
        />
      </Box>
    </Box>
  )

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[6],
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      {/* Pro gate — blurred preview + unified upsell card (Wave-3 ProGate) */}
      {isPro ? (
        statsContent
      ) : (
        <ProGate variant="blur" featureKey="upgradeProStatsDesc">
          {statsContent}
        </ProGate>
      )}

      {/* stats-two-col / trading-grid responsive rules moved to globals.css (#26) */}
    </Box>
  )
}
