'use client'

import { useState, useEffect, useRef } from 'react'
import { tokens, alpha as colorAlpha } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { TraderPerformance } from '@/lib/data/trader'
import { PeriodSelector } from './performance/PeriodSelector'
import { HeroMetrics } from './performance/HeroMetrics'
import { MetricBadgesGrid } from './performance/MetricBadgesGrid'
import { ScoreBreakdownSection } from './performance/ScoreBreakdownSection'
import type { Period } from './performance/PeriodSelector'
import { usePeriodStore } from '@/lib/stores/periodStore'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type {
  GmxMaxCapitalRoiDisclosure,
  GmxRealizedNetDisclosure,
} from '@/lib/data/serving/pnl-contract'

export interface ExtendedPerformance extends TraderPerformance {
  /** Source-specific PnL semantics, keyed to the exact rendered period. */
  pnlDisclosures?: Partial<Record<Period, GmxRealizedNetDisclosure>>
  /** Source-specific ROI formula, independently proven per rendered period. */
  roiDisclosures?: Partial<Record<Period, GmxMaxCapitalRoiDisclosure>>
  arena_score_7d?: number
  arena_score_30d?: number
  arena_score_90d?: number
  overall_score?: number
  sharpe_ratio?: number
  sharpe_ratio_30d?: number
  sharpe_ratio_7d?: number
  winning_positions?: number
  winning_positions_7d?: number
  winning_positions_30d?: number
  total_positions?: number
  total_positions_7d?: number
  total_positions_30d?: number
  // Per-period score breakdowns
  return_score_7d?: number
  return_score_30d?: number
  pnl_score?: number
  pnl_score_7d?: number
  pnl_score_30d?: number
  drawdown_score_7d?: number
  drawdown_score_30d?: number
  stability_score_7d?: number
  stability_score_30d?: number
  score_confidence?: string
  // V3 Advanced Metrics
  sortino_ratio?: number
  sortino_ratio_7d?: number
  sortino_ratio_30d?: number
  calmar_ratio?: number
  calmar_ratio_7d?: number
  calmar_ratio_30d?: number
  alpha?: number
  alpha_7d?: number
  alpha_30d?: number
  arena_score_v3?: number
  arena_score_v3_7d?: number
  arena_score_v3_30d?: number
  trading_style?: string
  style_confidence?: number
  // Per-period additional stats
  trades_count?: number
  trades_count_7d?: number
  trades_count_30d?: number
  copiers_pnl?: number
  copiers_pnl_7d?: number
  copiers_pnl_30d?: number
  avg_holding_time_hours?: number
  avg_holding_time_hours_7d?: number
  avg_holding_time_hours_30d?: number
}

export interface OverviewPerformanceCardProps {
  performance: ExtendedPerformance
  profitableWeeksPct?: number
  equityCurve?: Array<{ date: string; roi: number; pnl: number }>
  /** Full equity curve data for all periods (7D/30D/90D) — used to switch sparkline on period change */
  allEquityCurves?: Partial<Record<Period, Array<{ date: string; roi: number; pnl: number }>>>
  lastUpdated?: string
  // Data source for period mapping notes
  source?: string
  /** Live position summary (avg leverage, long/short counts) */
  positionSummary?: {
    avgLeverage: number | null
    longPositions: number | null
    shortPositions: number | null
  } | null
}

/**
 * Performance卡片 - 交易员主页核心指标
 * 优化版：信息层级分明，主指标突出，次指标用徽章展示
 */
export default function OverviewPerformanceCard({
  performance,
  profitableWeeksPct,
  equityCurve,
  allEquityCurves,
  lastUpdated,
  source,
  positionSummary,
}: OverviewPerformanceCardProps) {
  void profitableWeeksPct
  const { t } = useLanguage()
  const period = usePeriodStore((s) => s.period) as Period
  const setStorePeriod = usePeriodStore((s) => s.setPeriod)
  const [isAnimating, setIsAnimating] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const selectedPeriodRef = useRef(period)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  selectedPeriodRef.current = period

  useEffect(() => {
    setMounted(true)
    // Small delay to trigger bar animation after mount
    const timer = setTimeout(() => setIsVisible(true), 150)
    return () => {
      clearTimeout(timer)
      if (animationTimerRef.current) clearTimeout(animationTimerRef.current)
    }
  }, [])

  const handlePeriodChange = (newPeriod: Period) => {
    if (newPeriod === selectedPeriodRef.current) return

    // The user's latest selection is authoritative immediately. Delaying the
    // store update made a fast 90D→30D→90D sequence ignore the final click and
    // land on 30D when the first timer fired.
    selectedPeriodRef.current = newPeriod
    setStorePeriod(newPeriod)
    setIsAnimating(true)
    if (animationTimerRef.current) clearTimeout(animationTimerRef.current)
    animationTimerRef.current = setTimeout(() => {
      animationTimerRef.current = null
      setIsAnimating(false)
    }, 150)
  }

  const getData = () => {
    switch (period) {
      case '7D':
        return {
          roi: performance.roi_7d,
          roiDisclosure: performance.roiDisclosures?.['7D'],
          pnl: performance.pnl_7d,
          pnlDisclosure: performance.pnlDisclosures?.['7D'],
          winRate: performance.win_rate_7d,
          maxDrawdown: performance.max_drawdown_7d,
          arenaScore: performance.arena_score_7d,
          sharpeRatio: performance.sharpe_ratio_7d,
          winningPositions: performance.winning_positions_7d ?? performance.winning_positions,
          totalPositions: performance.total_positions_7d ?? performance.total_positions,
          returnScore: performance.return_score_7d,
          pnlScore: performance.pnl_score_7d,
          drawdownScore: performance.drawdown_score_7d,
          stabilityScore: performance.stability_score_7d,
          // V3 Metrics
          sortinoRatio: performance.sortino_ratio_7d,
          calmarRatio: performance.calmar_ratio_7d,
          alpha: performance.alpha_7d,
          arenaScoreV3: performance.arena_score_v3_7d,
          // Additional stats
          tradesCount: performance.trades_count_7d,
          avgHoldingTimeHours: performance.avg_holding_time_hours_7d,
        }
      case '30D':
        return {
          roi: performance.roi_30d,
          roiDisclosure: performance.roiDisclosures?.['30D'],
          pnl: performance.pnl_30d,
          pnlDisclosure: performance.pnlDisclosures?.['30D'],
          winRate: performance.win_rate_30d,
          maxDrawdown: performance.max_drawdown_30d,
          arenaScore: performance.arena_score_30d,
          sharpeRatio: performance.sharpe_ratio_30d,
          winningPositions: performance.winning_positions_30d ?? performance.winning_positions,
          totalPositions: performance.total_positions_30d ?? performance.total_positions,
          returnScore: performance.return_score_30d,
          pnlScore: performance.pnl_score_30d,
          drawdownScore: performance.drawdown_score_30d,
          stabilityScore: performance.stability_score_30d,
          // V3 Metrics
          sortinoRatio: performance.sortino_ratio_30d,
          calmarRatio: performance.calmar_ratio_30d,
          alpha: performance.alpha_30d,
          arenaScoreV3: performance.arena_score_v3_30d,
          // Additional stats
          tradesCount: performance.trades_count_30d,
          avgHoldingTimeHours: performance.avg_holding_time_hours_30d,
        }
      case '90D':
      default:
        return {
          roi: performance.roi_90d,
          roiDisclosure: performance.roiDisclosures?.['90D'],
          pnl: performance.pnl,
          pnlDisclosure: performance.pnlDisclosures?.['90D'],
          winRate: performance.win_rate,
          maxDrawdown: performance.max_drawdown,
          arenaScore: performance.arena_score_90d,
          sharpeRatio: performance.sharpe_ratio,
          winningPositions: performance.winning_positions,
          totalPositions: performance.total_positions,
          returnScore: performance.return_score ?? undefined,
          pnlScore: performance.pnl_score ?? undefined,
          drawdownScore: performance.drawdown_score ?? undefined,
          stabilityScore: performance.stability_score ?? undefined,
          // V3 Metrics
          sortinoRatio: performance.sortino_ratio,
          calmarRatio: performance.calmar_ratio,
          alpha: performance.alpha,
          arenaScoreV3: performance.arena_score_v3,
          // Additional stats
          tradesCount: performance.trades_count,
          avgHoldingTimeHours: performance.avg_holding_time_hours,
        }
    }
  }

  const data = getData()
  const {
    roi,
    roiDisclosure,
    pnl,
    pnlDisclosure,
    winRate,
    maxDrawdown,
    sharpeRatio,
    winningPositions,
    totalPositions,
    returnScore: periodReturnScore,
    pnlScore: periodPnlScore,
    drawdownScore: periodDrawdownScore,
    stabilityScore: periodStabilityScore,
    sortinoRatio,
    calmarRatio,
    alpha,
    arenaScoreV3,
    tradesCount,
    avgHoldingTimeHours,
  } = data
  const periodArenaScore = data.arenaScore
  // The default serving layout is now the unified three-tab experience, so
  // dormant-period feedback must live in this shared performance card too.
  // The older escape-hatch ServingProfilePanel already had this notice, but it
  // is not mounted for normal users. Treat missing fields as unknown, require
  // at least one real activity metric, and never turn a non-zero PnL/ROI into a
  // dormant claim.
  const activityMetrics = [roi, pnl, winRate, totalPositions].filter(
    (value): value is number => value != null && Number.isFinite(Number(value))
  )
  const isDormantPeriod =
    activityMetrics.length > 0 && activityMetrics.every((value) => Number(value) === 0)

  // 生成 sparkline 数据 — 使用当前 period 对应的 equity curve，过滤掉 null/NaN 值
  const periodCurve = allEquityCurves?.[period] ?? equityCurve
  const sparklineRawData = (periodCurve?.map((d) => d.roi) || []).filter(
    (v) => v != null && !isNaN(v as number)
  ) as number[]
  const sparklineData = sparklineRawData.length >= 2 ? sparklineRawData : []

  return (
    <div ref={cardRef}>
      <Box
        className="performance-card glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${colorAlpha(tokens.colors.bg.primary, 56)} 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          overflow: 'hidden',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(20px)',
          transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: `0 4px 24px var(--color-overlay-subtle), inset 0 1px 0 var(--overlay-hover)`,
        }}
      >
        <Box style={{ padding: tokens.spacing[5] }}>
          {/* Header */}
          <PeriodSelector
            period={period}
            onPeriodChange={handlePeriodChange}
            source={source}
            lastUpdated={lastUpdated}
          />

          {isDormantPeriod && (
            <Box
              role="status"
              style={{
                marginBottom: tokens.spacing[4],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                background: 'var(--color-bg-tertiary)',
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Text size="sm" color="tertiary">
                {t('traderDormantForPeriod')}
              </Text>
            </Box>
          )}

          {/* Content — shimmer on period switch */}
          <Box
            className={isAnimating ? 'period-switch-shimmer' : ''}
            style={{
              opacity: isAnimating ? 0.4 : 1,
              transform: isAnimating ? 'scale(0.98)' : 'scale(1)',
              transition: `opacity 0.2s ease, transform 0.2s ease`,
            }}
          >
            {/* ROI & PnL - 主指标区 Hero Metrics */}
            <HeroMetrics
              roi={roi}
              roiDisclosure={roiDisclosure}
              pnl={pnl}
              pnlDisclosure={pnlDisclosure}
              sparklineData={sparklineData}
              isVisible={isVisible}
            />

            {/* 二级指标 - 紧凑徽章布局 */}
            <MetricBadgesGrid
              sharpeRatio={sharpeRatio}
              maxDrawdown={maxDrawdown}
              winRate={winRate}
              winningPositions={winningPositions}
              totalPositions={totalPositions}
              sortinoRatio={sortinoRatio}
              calmarRatio={calmarRatio}
              alpha={alpha}
              tradesCount={tradesCount}
              avgHoldingTimeHours={avgHoldingTimeHours}
              avgLeverage={positionSummary?.avgLeverage ?? undefined}
              longPositions={positionSummary?.longPositions ?? undefined}
              shortPositions={positionSummary?.shortPositions ?? undefined}
              isVisible={isVisible}
            />

            {/* 评分详情 - 免费展示 (period-specific) */}
            <ScoreBreakdownSection
              performance={performance}
              periodArenaScore={periodArenaScore}
              periodReturnScore={periodReturnScore}
              periodPnlScore={periodPnlScore}
              periodDrawdownScore={periodDrawdownScore}
              periodStabilityScore={periodStabilityScore}
              arenaScoreV3={arenaScoreV3}
              isVisible={isVisible}
            />
          </Box>
        </Box>
      </Box>
    </div>
  )
}
