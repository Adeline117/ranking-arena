'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
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
  winning_positions?: number
  winning_positions_7d?: number
  winning_positions_30d?: number
  total_positions?: number
  total_positions_7d?: number
  total_positions_30d?: number
}

export interface OverviewPerformanceCardProps {
  performance: ExtendedPerformance
  profitableWeeksPct?: number
}

type Period = '7D' | '30D' | '90D'

/**
 * Performance卡片 - 交易员主页核心指标
 * 简洁清晰的布局设计
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
          winningPositions: performance.winning_positions_7d ?? performance.winning_positions,
          totalPositions: performance.total_positions_7d ?? performance.total_positions,
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
        }
    }
  }

  const data = getData()
  const { roi, pnl, winRate, maxDrawdown, sharpeRatio, winningPositions, totalPositions } = data

  const formatPnl = (value: number | undefined) => {
    if (value === undefined) return '—'
    const absValue = Math.abs(value)
    const sign = value >= 0 ? '+' : '-'
    if (absValue >= 1000000) {
      return `${sign}${(absValue / 1000000).toFixed(2)}M`
    } else if (absValue >= 1000) {
      return `${sign}${absValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    }
    return `${sign}${absValue.toFixed(2)}`
  }

  const periodLabel = period === '7D' ? '7 天' : period === '30D' ? '30 天' : '90 天'

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
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            {t('performance')}
          </Text>
          
          {/* Period Selector */}
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
              const label = p === '7D' ? '7 天' : p === '30D' ? '30 天' : '90 天'
              return (
                <button
                  key={p}
                  onClick={() => handlePeriodChange(p)}
                  style={{
                    padding: `6px 12px`,
                    borderRadius: tokens.radius.md,
                    border: 'none',
                    background: period === p ? tokens.colors.bg.primary : 'transparent',
                    color: period === p ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    fontSize: 13,
                    fontWeight: period === p ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  }}
                >
                  {label}
                </button>
              )
            })}
          </Box>
        </Box>

        {/* Content */}
        <Box
          style={{
            opacity: isAnimating ? 0.5 : 1,
            transform: isAnimating ? 'scale(0.99)' : 'scale(1)',
            transition: 'all 0.15s ease',
          }}
        >
          {/* ROI & PnL - 主指标 */}
          <Box
            className="performance-main-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: tokens.spacing[4],
              marginBottom: tokens.spacing[4],
            }}
          >
            <StatRow
              label={t('roi')}
              value={roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : '—'}
              valueColor={roi !== undefined ? (roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary}
              large
            />
            <StatRow
              label={t('pnl')}
              value={formatPnl(pnl)}
              valueColor={pnl !== undefined ? (pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.secondary}
              large
              align="right"
            />
          </Box>

          {/* 分隔线 */}
          <Box style={{ height: 1, background: tokens.colors.border.primary, marginBottom: tokens.spacing[4] }} />

          {/* Secondary Metrics */}
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <StatRow
              label={t('sharpeRatio')}
              value={sharpeRatio !== undefined ? sharpeRatio.toFixed(2) : '—'}
              valueColor={sharpeRatio !== undefined && sharpeRatio > 1 ? tokens.colors.accent.success : tokens.colors.text.primary}
            />
            <StatRow
              label={t('maxDrawdown')}
              value={maxDrawdown !== undefined ? `${Math.abs(maxDrawdown).toFixed(2)}%` : '—'}
              valueColor={tokens.colors.text.primary}
            />
            <StatRow
              label={t('winRate')}
              value={winRate !== undefined ? `${winRate.toFixed(2)}%` : '—'}
              valueColor={tokens.colors.text.primary}
            />
            <StatRow
              label={t('winningPositions')}
              value={winningPositions !== undefined ? String(winningPositions) : '—'}
              valueColor={tokens.colors.text.primary}
            />
            <StatRow
              label={t('totalPositions')}
              value={totalPositions !== undefined ? String(totalPositions) : '—'}
              valueColor={tokens.colors.text.primary}
            />
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// 统计行组件
function StatRow({
  label,
  value,
  valueColor,
  large = false,
  align = 'left',
}: {
  label: string
  value: string
  valueColor: string
  large?: boolean
  align?: 'left' | 'right'
}) {
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: large ? 6 : 0,
        ...(align === 'right' ? { alignItems: 'flex-end' } : {}),
      }}
    >
      {large ? (
        <>
          <Text
            size="xs"
            style={{
              color: tokens.colors.text.tertiary,
              borderBottom: `1px dashed ${tokens.colors.text.tertiary}40`,
              paddingBottom: 2,
            }}
          >
            {label}
          </Text>
          <Text
            style={{
              fontSize: 24,
              fontWeight: 700,
              color: valueColor,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              letterSpacing: '-0.02em',
            }}
          >
            {value}
          </Text>
        </>
      ) : (
        <Box
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
          }}
        >
          <Text
            size="sm"
            style={{
              color: tokens.colors.text.tertiary,
              borderBottom: `1px dashed ${tokens.colors.text.tertiary}30`,
              paddingBottom: 1,
            }}
          >
            {label}
          </Text>
          <Text
            size="base"
            weight="bold"
            style={{
              color: valueColor,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {value}
          </Text>
        </Box>
      )}
    </Box>
  )
}
