'use client'

import { useState, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TraderPerformance } from '@/lib/data/trader'
import { Sparkline } from '@/app/components/ui/Sparkline'
import { ScoreRadar } from '@/app/components/ranking/ScoreRadar'
import { CompactErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { getScoreColor as getArenaScoreColor } from '@/lib/utils/score-colors'

const arenaScoreColor = (score: number) => getArenaScoreColor(score)

// 扩展 TraderPerformance 类型
export interface ExtendedPerformance extends TraderPerformance {
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
  lastUpdated?: string
  // Data source for period mapping notes
  source?: string
}

type Period = '7D' | '30D' | '90D'

/**
 * Performance卡片 - 交易员主页核心指标
 * 优化版：信息层级分明，主指标突出，次指标用徽章展示
 */
// Data source period mapping notes
const DATA_SOURCE_NOTES: Record<string, { titleKey: string; periods: Record<string, string> }> = {
  weex: {
    titleKey: 'weexDataNote',
    periods: {
      '7D': '--',
      '30D': 'weexPeriod30d',
      '90D': 'weexPeriod90d',
    },
  },
}

export default function OverviewPerformanceCard({
  performance,
  profitableWeeksPct,
  equityCurve,
  lastUpdated,
  source,
}: OverviewPerformanceCardProps) {
  void profitableWeeksPct
  const { t, language } = useLanguage()
  const [period, setPeriod] = useState<Period>('90D')
  const [isAnimating, setIsAnimating] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMounted(true)
    // Small delay to trigger bar animation after mount
    const t = setTimeout(() => setIsVisible(true), 150)
    return () => clearTimeout(t)
  }, [])

  const handlePeriodChange = (newPeriod: Period) => {
    if (newPeriod !== period) {
      setIsAnimating(true)
      setTimeout(() => {
        setPeriod(newPeriod)
        setIsAnimating(false)
      }, 150)
    }
  }

  const getData = () => {
    switch (period) {
      case '7D':
        return {
          roi: performance.roi_7d,
          pnl: performance.pnl_7d,
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
          copiersPnl: performance.copiers_pnl_7d,
          avgHoldingTimeHours: performance.avg_holding_time_hours_7d,
        }
      case '30D':
        return {
          roi: performance.roi_30d,
          pnl: performance.pnl_30d,
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
          copiersPnl: performance.copiers_pnl_30d,
          avgHoldingTimeHours: performance.avg_holding_time_hours_30d,
        }
      case '90D':
      default:
        return {
          roi: performance.roi_90d,
          pnl: performance.pnl,
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
          copiersPnl: performance.copiers_pnl,
          avgHoldingTimeHours: performance.avg_holding_time_hours,
        }
    }
  }

  const data = getData()
  const { roi, pnl, winRate, maxDrawdown, sharpeRatio, winningPositions, totalPositions, returnScore: periodReturnScore, pnlScore: periodPnlScore, drawdownScore: periodDrawdownScore, stabilityScore: periodStabilityScore, sortinoRatio, calmarRatio, alpha, arenaScoreV3, tradesCount, copiersPnl, avgHoldingTimeHours } = data
  const periodArenaScore = data.arenaScore

  const formatPnl = (value: number | undefined) => {
    if (value === undefined) return '—'
    const absValue = Math.abs(value)
    const sign = value >= 0 ? '+' : '-'
    if (absValue >= 1000000) {
      return `${sign}$${(absValue / 1000000).toFixed(2)}M`
    } else if (absValue >= 1000) {
      return `${sign}$${absValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    }
    return `${sign}$${absValue.toFixed(2)}`
  }

  // 生成 sparkline 数据 — 若 ROI 数据全为 0 则不显示 sparkline（避免平线误导）
  const sparklineRawData = equityCurve?.map(d => d.roi) || []
  const hasNonZeroSparkline = sparklineRawData.some(v => v !== 0 && v != null)
  const sparklineData = hasNonZeroSparkline ? sparklineRawData : []

  return (
    <div ref={cardRef}>
    <Box
      className="performance-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.primary}90 100%)`,
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
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[5],
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
              {t('performance')}
            </Text>
            {lastUpdated && (
              <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
                {t('updatedAt')} {new Date(lastUpdated).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            )}
          </Box>

          {/* Period Selector */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            {/* 数据来源提示 */}
            {source && DATA_SOURCE_NOTES[source.toLowerCase()] && (
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: `4px 8px`,
                  background: tokens.colors.accent.warning + '15',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.accent.warning}30`,
                }}
                title={(() => {
                  const note = DATA_SOURCE_NOTES[source.toLowerCase()]
                  const p30 = note.periods['30D'] === '--' ? '--' : t(note.periods['30D'])
                  const p90 = note.periods['90D'] === '--' ? '--' : t(note.periods['90D'])
                  return `${t(note.titleKey)}: 30D=${p30}, 90D=${p90}`
                })()}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.warning} strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <Text size="xs" style={{ color: tokens.colors.accent.warning, fontWeight: 500 }}>
                  {(() => {
                    const pKey = DATA_SOURCE_NOTES[source.toLowerCase()].periods[period]
                    return pKey ? (pKey === '--' ? '--' : t(pKey)) : period
                  })()}
                </Text>
              </Box>
            )}

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
              {(['7D', '30D', '90D'] as Period[]).map((p) => {
                const sourceNote = source && DATA_SOURCE_NOTES[source.toLowerCase()]
                const isDisabled = !!(sourceNote && sourceNote.periods[p] === '--')
                const label = p === '7D' ? '7D' : p === '30D' ? '30D' : '90D'
                return (
                  <button
                    key={p}
                    onClick={() => !isDisabled && handlePeriodChange(p)}
                    disabled={isDisabled}
                    style={{
                      padding: `6px 14px`,
                      minHeight: 36,
                      borderRadius: tokens.radius.md,
                      border: 'none',
                      background: period === p ? tokens.colors.bg.primary : 'transparent',
                      color: isDisabled
                        ? tokens.colors.text.tertiary
                        : period === p
                          ? tokens.colors.text.primary
                          : tokens.colors.text.secondary,
                      fontSize: 13,
                      fontWeight: period === p ? 600 : 400,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                      transition: 'all 0.2s ease',
                      fontFamily: tokens.typography.fontFamily.sans.join(', '),
                      boxShadow: period === p ? '0 2px 8px var(--color-overlay-subtle)' : 'none',
                      opacity: isDisabled ? 0.5 : 1,
                    }}
                    title={isDisabled ? t('noDataForPeriod') : undefined}
                  >
                    {label}
                  </button>
                )
              })}
            </Box>
          </Box>
        </Box>

        {/* Content */}
        <Box
          style={{
            opacity: isAnimating ? 0.3 : 1,
            transform: isAnimating ? 'scale(0.98)' : 'scale(1)',
            transition: 'all 0.2s ease',
          }}
        >
          {/* ROI & PnL - 主指标区 Hero Metrics */}
          <Box
            className="performance-main-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: tokens.spacing[4],
              marginBottom: tokens.spacing[5],
            }}
          >
            {/* ROI 卡片 */}
            <Box
              style={{
                padding: tokens.spacing[4],
                background: roi !== undefined && roi >= 0
                  ? `linear-gradient(135deg, ${tokens.colors.accent.success}08 0%, ${tokens.colors.accent.success}03 100%)`
                  : roi !== undefined
                    ? `linear-gradient(135deg, ${tokens.colors.accent.error}08 0%, ${tokens.colors.accent.error}03 100%)`
                    : tokens.colors.bg.tertiary + '40',
                borderRadius: tokens.radius.lg,
                border: `1px solid ${roi !== undefined && roi >= 0 ? tokens.colors.accent.success + '20' : roi !== undefined ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: 11, fontWeight: 500 }}>
                {t('roi')}
              </Text>
              <Box style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <Text
                  className="hero-metric-value"
                  style={{
                    fontSize: 28,
                    fontWeight: 800,
                    color: roi !== undefined ? (roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary,
                    fontFamily: tokens.typography.fontFamily.mono.join(', '),
                    letterSpacing: '-0.03em',
                    lineHeight: 1.2,
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
                    transition: 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.1s',
                  }}
                >
                  {roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : '—'}
                </Text>
                {(sparklineData.length > 2 || roi !== undefined) && (
                  <Sparkline
                    data={sparklineData.length > 2 ? sparklineData : undefined}
                    roi={roi}
                    width={80}
                    height={28}
                    color={roi !== undefined && roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}
                  />
                )}
              </Box>
            </Box>

            {/* PnL 卡片 */}
            <Box
              style={{
                padding: tokens.spacing[4],
                background: pnl !== undefined && pnl >= 0
                  ? `linear-gradient(135deg, ${tokens.colors.accent.success}08 0%, ${tokens.colors.accent.success}03 100%)`
                  : pnl !== undefined
                    ? `linear-gradient(135deg, ${tokens.colors.accent.error}08 0%, ${tokens.colors.accent.error}03 100%)`
                    : tokens.colors.bg.tertiary + '40',
                borderRadius: tokens.radius.lg,
                border: `1px solid ${pnl !== undefined && pnl >= 0 ? tokens.colors.accent.success + '20' : pnl !== undefined ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
              }}
            >
              <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: 11, fontWeight: 500 }}>
                {t('pnl')}
              </Text>
              <Text
                className="hero-metric-value"
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  color: pnl !== undefined ? (pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary,
                  fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  letterSpacing: '-0.03em',
                  lineHeight: 1.2,
                  opacity: isVisible ? 1 : 0,
                  transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
                  transition: 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.2s',
                }}
              >
                {formatPnl(pnl)}
              </Text>
            </Box>
          </Box>

          {/* 二级指标 - 紧凑徽章布局 */}
          <Box
            className="metric-badges-grid"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: `${tokens.spacing[2]} ${tokens.spacing[2]}`,
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
              transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.3s',
            }}
          >
            <MetricBadge
              label={t('sharpe')}
              value={sharpeRatio !== undefined && sharpeRatio < 9000 ? sharpeRatio.toFixed(2) : '—'}
              highlight={sharpeRatio !== undefined && sharpeRatio > 1 && sharpeRatio < 9000}
              tooltip={sharpeRatio === undefined ? t('sharpeNotAvailable') : sharpeRatio >= 9000 ? t('sharpeNotAvailable') : undefined}
            />
            <MetricBadge
              label={t('maxDrawdownShort')}
              value={maxDrawdown !== undefined && Math.abs(maxDrawdown) <= 100 ? (Math.abs(maxDrawdown) < 0.05 ? '< 0.1%' : `${Math.abs(maxDrawdown).toFixed(1)}%`) : '—'}
              negative
              tooltip={maxDrawdown === undefined ? t('drawdownNotAvailable') : maxDrawdown !== undefined && Math.abs(maxDrawdown) > 100 ? t('drawdownNotAvailable') : undefined}
            />
            <MetricBadge
              label={t('winRateShort')}
              value={winRate !== undefined ? `${winRate.toFixed(1)}%` : '—'}
              highlight={winRate !== undefined && winRate > 60}
              tooltip={winRate === undefined ? t('winRateNotAvailable') : undefined}
            />
            <MetricBadge
              label={t('winningPositions')}
              value={winningPositions !== undefined && totalPositions !== undefined ? `${winningPositions}/${totalPositions}` : '—'}
              tooltip={winningPositions === undefined ? t('positionStatsNotAvailable') : undefined}
            />
            {/* V3 Advanced Metrics */}
            {sortinoRatio !== undefined && (
              <MetricBadge
                label="Sortino"
                value={sortinoRatio.toFixed(2)}
                highlight={sortinoRatio >= 2}
                tooltip={t('sortinoTooltip') || 'Risk-adjusted return using downside volatility'}
              />
            )}
            {calmarRatio !== undefined && (
              <MetricBadge
                label="Calmar"
                value={calmarRatio.toFixed(2)}
                highlight={calmarRatio >= 3}
                tooltip={t('calmarTooltip') || 'Annualized return / max drawdown'}
              />
            )}
            {alpha !== undefined && (
              <MetricBadge
                label="Alpha"
                value={`${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`}
                highlight={alpha > 0}
                negative={alpha < 0}
                tooltip={t('alphaTooltip') || 'Excess return vs market benchmark'}
              />
            )}
            {tradesCount !== undefined && (
              <MetricBadge
                label={t('tradesLabel') || 'Trades'}
                value={String(tradesCount)}
              />
            )}
            {avgHoldingTimeHours !== undefined && (
              <MetricBadge
                label={t('avgHoldingTime') || 'Avg Hold'}
                value={avgHoldingTimeHours < 1 ? `${Math.round(avgHoldingTimeHours * 60)}m` : `${Math.round(avgHoldingTimeHours)}h`}
              />
            )}
            {copiersPnl !== undefined && (
              <MetricBadge
                label={t('copiersPnl') || 'Copiers PnL'}
                value={`${copiersPnl >= 0 ? '+' : ''}$${Math.abs(copiersPnl).toLocaleString('en-US', { maximumFractionDigits: 0 })}`}
                highlight={copiersPnl > 0}
                negative={copiersPnl < 0}
              />
            )}
          </Box>

          {/* 评分详情 - 免费展示 (period-specific) */}
          {(periodArenaScore !== undefined || periodReturnScore !== undefined || periodDrawdownScore !== undefined || periodStabilityScore !== undefined || arenaScoreV3 !== undefined || performance.profitability_score !== undefined) && (
            <Box
              style={{
                marginTop: tokens.spacing[5],
                paddingTop: tokens.spacing[5],
                borderTop: `1px solid ${tokens.colors.border.primary}40`,
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
                transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.4s',
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.warning} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
                  {t('scoreBreakdown')}
                </Text>
                {/* Score explanation tooltip */}
                <Box
                  style={{
                    position: 'relative',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: tokens.colors.bg.tertiary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'help',
                    flexShrink: 0,
                  }}
                  className="score-tooltip-trigger"
                >
                  <Text size="xs" style={{ color: tokens.colors.text.tertiary, fontSize: 11, fontWeight: 700, lineHeight: 1 }}>?</Text>
                  <Box
                    className="score-tooltip-content"
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      marginTop: 8,
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      background: tokens.colors.bg.primary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      borderRadius: tokens.radius.lg,
                      boxShadow: '0 8px 24px var(--color-overlay-medium)',
                      width: 280,
                      zIndex: 50,
                      display: 'none',
                      pointerEvents: 'none',
                    }}
                  >
                    <Text size="xs" weight="bold" style={{ color: tokens.colors.text.secondary, marginBottom: 4, display: 'block' }}>
                      {t('scoreGuide')}
                    </Text>
                    <Text size="xs" color="tertiary" style={{ lineHeight: 1.6 }}>
                      {t('scoreGuideDetail')}
                    </Text>
                  </Box>
                  <style>{`
                    .score-tooltip-trigger:hover .score-tooltip-content {
                      display: block !important;
                    }
                  `}</style>
                </Box>
                {/* Arena Score 总分 */}
                <Box style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  {arenaScoreV3 != null && (
                    <Box
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                        background: `${tokens.colors.accent.success}15`,
                        borderRadius: tokens.radius.full,
                        border: `1px solid ${tokens.colors.accent.success}30`,
                      }}
                    >
                      <Text
                        size="sm"
                        weight="black"
                        style={{
                          color: tokens.colors.accent.success,
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        }}
                      >
                        {arenaScoreV3.toFixed(0)}
                      </Text>
                    </Box>
                  )}
                  {periodArenaScore != null && (
                    <Box
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                        background: `${arenaScoreColor(periodArenaScore)}15`,
                        borderRadius: tokens.radius.full,
                        border: `1px solid ${arenaScoreColor(periodArenaScore)}30`,
                      }}
                    >
                      <Text size="xs" color="secondary" weight="bold">Arena Score</Text>
                      <Text
                        size="sm"
                        weight="black"
                        style={{
                          color: arenaScoreColor(periodArenaScore),
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        }}
                      >
                        {periodArenaScore.toFixed(0)}
                      </Text>
                    </Box>
                  )}
                </Box>
              </Box>

              {/* 分数条 + 雷达图 */}
              <Box
                className="score-breakdown-layout"
                style={{ display: 'flex', gap: tokens.spacing[5], alignItems: 'flex-start', flexWrap: 'wrap' }}
              >
                <Box style={{ flex: '1 1 200px', display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <ScoreBar
                    label={t('returnScore')}
                    score={periodReturnScore ?? null}
                    maxScore={70}
                    isVisible={isVisible}
                    delay={500}
                  />
                  <ScoreBar
                    label={t('pnlScore')}
                    score={periodPnlScore ?? null}
                    maxScore={15}
                    isVisible={isVisible}
                    delay={550}
                  />
                  <ScoreBar
                    label={t('drawdownScore')}
                    score={periodDrawdownScore ?? null}
                    maxScore={8}
                    isVisible={isVisible}
                    delay={600}
                  />
                  <ScoreBar
                    label={t('stabilityScore')}
                    score={periodStabilityScore ?? null}
                    maxScore={7}
                    isVisible={isVisible}
                    delay={700}
                  />
                </Box>
                {/* 雷达图：优先使用V3三维度分数，回退到4维映射 */}
                <Box style={{ flex: '0 0 auto', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                  <CompactErrorBoundary>
                    <ScoreRadar
                      profitability={performance.profitability_score ?? ((periodReturnScore ?? 0) / 70) * 35}
                      riskControl={performance.risk_control_score ?? (((periodDrawdownScore ?? 0) / 8 + (periodStabilityScore ?? 0) / 7) / 2) * 40}
                      execution={performance.execution_score ?? ((periodPnlScore ?? 0) / 15) * 25}
                      arenaScore={performance.arena_score_v3 ?? periodArenaScore ?? 0}
                      size={130}
                    />
                  </CompactErrorBoundary>
                </Box>
              </Box>

              {/* 数据置信度提示 */}
              {performance.score_confidence && performance.score_confidence !== 'full' && (
                <Box
                  style={{
                    marginTop: tokens.spacing[3],
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    background: performance.score_confidence === 'minimal'
                      ? `${tokens.colors.accent.error}10`
                      : `${tokens.colors.accent.warning}10`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${performance.score_confidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning}25`,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke={performance.score_confidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning}
                    strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <Text size="xs" style={{
                    color: performance.score_confidence === 'minimal' ? tokens.colors.accent.error : tokens.colors.accent.warning,
                    fontWeight: 500,
                  }}>
                    {performance.score_confidence === 'minimal'
                      ? t('confidenceMinimal')
                      : t('confidencePartial')
                    }
                  </Text>
                </Box>
              )}

              {/* Score explanation removed - now in tooltip on header */}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
    </div>
  )
}

/**
 * 分数配色
 */
function getScoreColor(score: number | null, max: number): string {
  if (score == null) return 'var(--color-text-tertiary)'
  const ratio = score / max
  if (ratio >= 0.7) return 'var(--color-accent-success)'
  if (ratio >= 0.4) return 'var(--color-accent-warning)'
  return 'var(--color-accent-error)'
}

/**
 * 分数进度条
 */
function ScoreBar({
  label,
  score,
  maxScore,
  delay = 0,
}: {
  label: string
  score: number | null
  maxScore: number
  isVisible?: boolean
  delay?: number
}) {
  const color = getScoreColor(score, maxScore)
  const width = score != null ? (score / maxScore) * 100 : 0
  const barId = `score-bar-${label.replace(/\s+/g, '-').toLowerCase()}`

  return (
    <Box>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <Text size="sm" color="secondary" weight="bold">{label}</Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="black" style={{ color, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            {score != null ? score.toFixed(1) : '—'}
          </Text>
          <Text size="xs" color="tertiary">/ {maxScore}</Text>
        </Box>
      </Box>
      <Box
        style={{
          height: 6,
          background: 'var(--color-bg-hover, #E8E8EC)',
          borderRadius: tokens.radius.full,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <style>{`
          @keyframes ${barId} {
            from { width: 0%; }
            to { width: ${width}%; }
          }
          .${barId} {
            animation: ${barId} 1s cubic-bezier(0.4, 0, 0.2, 1) ${delay}ms both;
          }
        `}</style>
        <Box
          className={barId}
          style={{
            height: '100%',
            background: `linear-gradient(90deg, ${color}99 0%, ${color} 100%)`,
            borderRadius: tokens.radius.full,
            boxShadow: `0 0 8px ${color}40`,
          }}
        />
      </Box>
    </Box>
  )
}

/**
 * 二级指标徽章组件
 */
function MetricBadge({
  label,
  value,
  highlight = false,
  negative = false,
  tooltip,
}: {
  label: string
  value: string
  highlight?: boolean
  negative?: boolean
  tooltip?: string
}) {
  const isNA = value === '—'
  const color = isNA
    ? tokens.colors.text.tertiary
    : highlight
      ? tokens.colors.accent.success
      : negative
        ? tokens.colors.accent.error
        : tokens.colors.text.primary

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: `5px 12px`,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.full,
        border: `1px solid ${highlight ? tokens.colors.accent.success + '30' : negative ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
        cursor: tooltip ? 'help' : undefined,
        transition: 'border-color 0.2s ease',
      }}
      title={tooltip}
    >
      <Text style={{ fontSize: 11, color: tokens.colors.text.tertiary, fontWeight: 500, whiteSpace: 'nowrap' }}>
        {label}
      </Text>
      <Text style={{
        fontSize: 13,
        color,
        fontWeight: 700,
        fontFamily: tokens.typography.fontFamily.mono.join(', '),
        letterSpacing: '-0.02em',
        whiteSpace: 'nowrap',
      }}>
        {isNA ? '--' : value}
      </Text>
    </Box>
  )
}
