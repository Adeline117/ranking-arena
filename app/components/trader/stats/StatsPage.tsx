'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { Box } from '../../base'
import ProGate from '../../ui/ProGate'
import type { TraderStats } from '@/lib/data/trader'
import { useLanguage } from '../../Providers/LanguageProvider'
import { TradingSection } from './components/TradingSection'
import { EquityCurveSection } from './components/EquityCurveSection'
import { BreakdownSection } from './components/BreakdownSection'
// U2-6: the fabricated "Compare vs BTC" component was deleted. Until a real
// market-data series is wired in, the equity curve remains the only comparison
// surface and spans the full width.
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
