'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'
import type { TraderPerformance } from '@/lib/data/trader'

// 扩展 TraderPerformance 类型
interface ExtendedPerformance extends TraderPerformance {
  arena_score_7d?: number
  arena_score_30d?: number
  arena_score_90d?: number
  overall_score?: number
  sharpe_ratio?: number
  sharpe_ratio_30d?: number
  sharpe_ratio_7d?: number
  copiers_count?: number
  winning_positions?: number
  total_positions?: number
}

export interface OverviewPerformanceCardProps {
  performance: ExtendedPerformance
  profitableWeeksPct?: number
}

type Period = '7D' | '30D' | '90D'

/**
 * Performance卡片 - 交易员主页核心指标
 * 现代化设计，流畅动画
 */
export default function OverviewPerformanceCard({ performance, profitableWeeksPct }: OverviewPerformanceCardProps) {
  void profitableWeeksPct
  const { t } = useLanguage()
  const [period, setPeriod] = useState<Period>('90D')
  const [isAnimating, setIsAnimating] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // 切换周期时触发动画
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
        }
      case '30D':
        return {
          roi: performance.roi_30d,
          pnl: performance.pnl_30d,
          winRate: performance.win_rate_30d,
          maxDrawdown: performance.max_drawdown_30d,
          arenaScore: performance.arena_score_30d,
          sharpeRatio: performance.sharpe_ratio_30d,
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
        }
    }
  }

  const data = getData()
  const { roi, pnl, winRate, maxDrawdown, arenaScore, sharpeRatio } = data
  const overallScore = performance.overall_score
  const copiersCount = performance.copiers_count
  const winningPositions = performance.winning_positions
  const totalPositions = performance.total_positions

  const formatCurrency = (value: number | undefined) => {
    if (value === undefined) return t('na')
    const absValue = Math.abs(value)
    const sign = value >= 0 ? '+' : ''
    if (absValue >= 1000000) {
      return `${sign}$${(value / 1000000).toFixed(2)}M`
    } else if (absValue >= 1000) {
      return `${sign}$${(value / 1000).toFixed(2)}K`
    }
    return `${sign}$${value.toFixed(2)}`
  }

  // 获取 Arena Score 颜色
  const getScoreColor = (score: number | undefined) => {
    if (score === undefined) return { bg: tokens.colors.bg.tertiary, border: tokens.colors.border.primary, text: tokens.colors.text.secondary }
    if (score >= 60) return { bg: `${tokens.colors.accent.success}18`, border: `${tokens.colors.accent.success}50`, text: tokens.colors.accent.success }
    if (score >= 40) return { bg: `${tokens.colors.accent.warning}12`, border: `${tokens.colors.accent.warning}40`, text: tokens.colors.accent.warning }
    return { bg: tokens.colors.bg.tertiary, border: tokens.colors.border.primary, text: tokens.colors.text.secondary }
  }

  const scoreColors = getScoreColor(arenaScore)
  const overallScoreColors = getScoreColor(overallScore)

  return (
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
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.05)`,
      }}
    >
      {/* 顶部渐变装饰 */}
      <Box
        style={{
          height: 3,
          background: roi !== undefined && roi >= 0
            ? `linear-gradient(90deg, ${tokens.colors.accent.success}, ${tokens.colors.accent.success}60)`
            : `linear-gradient(90deg, ${tokens.colors.accent.error}, ${tokens.colors.accent.error}60)`,
          transition: 'background 0.3s ease',
        }}
      />
      
      <Box style={{ padding: tokens.spacing[6] }}>
        {/* Header */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: tokens.spacing[6],
          }}
        >
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            {t('performance')}
          </Text>
          
          {/* Period Selector - Pills Style */}
          <Box
            style={{
              display: 'flex',
              gap: tokens.spacing[1],
              background: tokens.colors.bg.tertiary,
              padding: 3,
              borderRadius: tokens.radius.lg,
            }}
          >
            {(['7D', '30D', '90D'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => handlePeriodChange(p)}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: 'none',
                  background: period === p 
                    ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                    : 'transparent',
                  color: period === p ? '#ffffff' : tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.bold,
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                }}
              >
                {p}
              </button>
            ))}
          </Box>
        </Box>

        {/* Main Metrics - Arena Score + ROI */}
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[6],
            marginBottom: tokens.spacing[6],
            alignItems: 'flex-end',
            opacity: isAnimating ? 0.5 : 1,
            transform: isAnimating ? 'scale(0.98)' : 'scale(1)',
            transition: 'all 0.15s ease',
          }}
        >
          {/* Arena Score Badge */}
          <Box style={{ flex: '0 0 auto' }}>
            <Box
              className="arena-score-badge"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 80,
                height: 80,
                borderRadius: tokens.radius.xl,
                background: scoreColors.bg,
                border: `2px solid ${scoreColors.border}`,
                marginBottom: tokens.spacing[2],
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {/* 光泽效果 */}
              <Box
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: '50%',
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.1) 0%, transparent 100%)',
                  borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
                }}
              />
              <Text
                size="2xl"
                weight="black"
                style={{
                  color: scoreColors.text,
                  lineHeight: 1,
                  fontSize: '28px',
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                {arenaScore !== undefined ? arenaScore.toFixed(1) : '—'}
              </Text>
            </Box>
            <Text
              size="xs"
              color="tertiary"
              style={{ textAlign: 'center', display: 'block' }}
            >
              Score ({period})
            </Text>
          </Box>

          {/* ROI Display */}
          <Box className="roi-display" style={{ flex: 1 }}>
            <Text
              style={{
                fontSize: '42px',
                fontWeight: tokens.typography.fontWeight.black,
                color: roi !== undefined
                  ? (roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
                  : tokens.colors.text.tertiary,
                lineHeight: 1,
                marginBottom: tokens.spacing[2],
                letterSpacing: '-0.03em',
                fontFamily: tokens.typography.fontFamily.mono.join(', '),
              }}
            >
              {roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%` : t('na')}
            </Text>
            <Text size="xs" color="tertiary">
              {t('roi')} ({period})
            </Text>
          </Box>

          {/* Overall Score */}
          {overallScore !== undefined && (
            <Box style={{ flex: '0 0 auto', textAlign: 'right' }}>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1], display: 'block' }}>
                Overall
              </Text>
              <Box
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  borderRadius: tokens.radius.lg,
                  background: overallScoreColors.bg,
                  border: `1px solid ${overallScoreColors.border}`,
                }}
              >
                <Text
                  size="xl"
                  weight="black"
                  style={{
                    color: overallScoreColors.text,
                    lineHeight: 1,
                  }}
                >
                  {overallScore.toFixed(1)}
                </Text>
              </Box>
            </Box>
          )}
        </Box>

        {/* Metrics Grid - 统一布局 */}
        <Box
          className="metrics-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[4],
            paddingTop: tokens.spacing[5],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
            opacity: isAnimating ? 0.5 : 1,
            transition: 'opacity 0.15s ease',
          }}
        >
          <MetricItem
            label={t('pnl')}
            value={formatCurrency(pnl)}
            valueColor={pnl !== undefined ? (pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary}
            tooltip={t('pnl')}
          />
          <MetricItem
            label={t('sharpeRatio')}
            value={sharpeRatio !== undefined ? sharpeRatio.toFixed(2) : t('na')}
            valueColor={sharpeRatio !== undefined && sharpeRatio > 1 ? tokens.colors.accent.success : tokens.colors.text.secondary}
            tooltip={t('sharpeRatioDesc')}
          />
          <MetricItem
            label={t('maxDrawdown')}
            value={maxDrawdown !== undefined ? `-${Math.abs(maxDrawdown).toFixed(2)}%` : t('na')}
            valueColor={maxDrawdown !== undefined ? tokens.colors.accent.error : tokens.colors.text.secondary}
            tooltip={t('maxDrawdown')}
          />
          <MetricItem
            label={t('winRate')}
            value={winRate !== undefined ? `${winRate.toFixed(1)}%` : t('na')}
            valueColor={winRate !== undefined && winRate > 50 ? tokens.colors.accent.success : tokens.colors.text.secondary}
            tooltip={t('winRate')}
            showProgress
            progressValue={winRate}
          />
          <MetricItem
            label={t('winningPositions')}
            value={winningPositions !== undefined && totalPositions !== undefined
              ? `${winningPositions} / ${totalPositions}`
              : (copiersCount !== undefined ? `${copiersCount} copiers` : t('na'))}
            valueColor={tokens.colors.text.primary}
            tooltip={t('winningPositionsDesc')}
          />
        </Box>
      </Box>
    </Box>
  )
}

// Metric Item Component
function MetricItem({
  label,
  value,
  valueColor,
  tooltip,
  showProgress,
  progressValue,
}: {
  label: string
  value: string
  valueColor: string
  tooltip: string
  showProgress?: boolean
  progressValue?: number
}) {
  const [showTooltip, setShowTooltip] = useState(false)

  return (
    <Box
      className="metric-item"
      style={{
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.lg,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[1],
          marginBottom: tokens.spacing[2],
        }}
      >
        <Text size="xs" color="tertiary">
          {label}
        </Text>
        <Box
          style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
        >
          <Box
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: `1px solid ${tokens.colors.text.tertiary}40`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'help',
              fontSize: '9px',
              color: tokens.colors.text.tertiary,
              transition: 'all 0.2s ease',
            }}
          >
            ?
          </Box>
          {showTooltip && (
            <Box
              style={{
                position: 'absolute',
                bottom: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginBottom: tokens.spacing[1],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                background: tokens.colors.bg.tertiary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.md,
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.primary,
                zIndex: 1000,
                pointerEvents: 'none',
                maxWidth: 180,
                whiteSpace: 'normal',
                textAlign: 'center',
                boxShadow: tokens.shadow.lg,
              }}
            >
              {tooltip}
            </Box>
          )}
        </Box>
      </Box>
      <Text size="base" weight="bold" style={{ color: valueColor }}>
        {value}
      </Text>
      {showProgress && progressValue !== undefined && (
        <Box
          style={{
            marginTop: tokens.spacing[2],
            height: 4,
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.full,
            overflow: 'hidden',
          }}
        >
          <Box
            className="asset-bar"
            style={{
              height: '100%',
              width: `${Math.min(progressValue, 100)}%`,
              background: progressValue > 50 
                ? `linear-gradient(90deg, ${tokens.colors.accent.success}, ${tokens.colors.accent.success}80)`
                : `linear-gradient(90deg, ${tokens.colors.accent.warning}, ${tokens.colors.accent.warning}80)`,
              borderRadius: tokens.radius.full,
              transition: 'width 1s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          />
        </Box>
      )}
    </Box>
  )
}
