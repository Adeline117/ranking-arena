'use client'

import { useState, useEffect, useRef } from 'react'
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
  equityCurve?: Array<{ date: string; roi: number; pnl: number }>
  lastUpdated?: string
}

type Period = '7D' | '30D' | '90D'

/**
 * 迷你趋势图 Sparkline
 */
function MiniSparkline({ data, color, width = 80, height = 28 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (!data || data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`sparkGrad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 填充区域 */}
      <polygon
        points={`0,${height} ${points} ${width},${height}`}
        fill={`url(#sparkGrad-${color.replace('#', '')})`}
      />
    </svg>
  )
}

/**
 * Performance卡片 - 交易员主页核心指标
 * 优化版：信息层级分明，主指标突出，次指标用徽章展示
 */
export default function OverviewPerformanceCard({ performance, profitableWeeksPct, equityCurve, lastUpdated }: OverviewPerformanceCardProps) {
  void profitableWeeksPct
  const { t, language } = useLanguage()
  const [period, setPeriod] = useState<Period>('90D')
  const [isAnimating, setIsAnimating] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  // 进入视口时触发动画
  useEffect(() => {
    if (!cardRef.current) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.2 }
    )
    observer.observe(cardRef.current)
    return () => observer.disconnect()
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
      return `${sign}$${(absValue / 1000000).toFixed(2)}M`
    } else if (absValue >= 1000) {
      return `${sign}$${absValue.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
    }
    return `${sign}$${absValue.toFixed(2)}`
  }

  // 生成 sparkline 数据
  const sparklineData = equityCurve?.map(d => d.roi) || []

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
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
              {t('performance')}
            </Text>
            {lastUpdated && (
              <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
                {language === 'zh' ? '更新于 ' : 'Updated '}
                {new Date(lastUpdated).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            )}
          </Box>

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
              const label = p === '7D' ? '7D' : p === '30D' ? '30D' : '90D'
              return (
                <button
                  key={p}
                  onClick={() => handlePeriodChange(p)}
                  style={{
                    padding: `6px 14px`,
                    minHeight: 36,
                    borderRadius: tokens.radius.md,
                    border: 'none',
                    background: period === p ? tokens.colors.bg.primary : 'transparent',
                    color: period === p ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    fontSize: 13,
                    fontWeight: period === p ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    fontFamily: tokens.typography.fontFamily.sans.join(', '),
                    boxShadow: period === p ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
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
                    lineHeight: 1,
                    opacity: isVisible ? 1 : 0,
                    transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
                    transition: 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.1s',
                  }}
                >
                  {roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : '—'}
                </Text>
                {sparklineData.length > 2 && (
                  <MiniSparkline
                    data={sparklineData}
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
                  lineHeight: 1,
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
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: tokens.spacing[2],
              opacity: isVisible ? 1 : 0,
              transform: isVisible ? 'translateY(0)' : 'translateY(10px)',
              transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.3s',
            }}
          >
            <MetricBadge
              label={language === 'zh' ? '夏普' : 'Sharpe'}
              value={sharpeRatio !== undefined ? sharpeRatio.toFixed(2) : '—'}
              highlight={sharpeRatio !== undefined && sharpeRatio > 1}
            />
            <MetricBadge
              label={language === 'zh' ? '最大回撤' : 'MDD'}
              value={maxDrawdown !== undefined ? `${Math.abs(maxDrawdown).toFixed(1)}%` : '—'}
              negative
            />
            <MetricBadge
              label={language === 'zh' ? '胜率' : 'Win'}
              value={winRate !== undefined ? `${winRate.toFixed(1)}%` : '—'}
              highlight={winRate !== undefined && winRate > 60}
            />
            <MetricBadge
              label={language === 'zh' ? '盈利单' : 'W/T'}
              value={winningPositions !== undefined && totalPositions !== undefined ? `${winningPositions}/${totalPositions}` : '—'}
            />
          </Box>
        </Box>
      </Box>
    </Box>
    </div>
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
}: {
  label: string
  value: string
  highlight?: boolean
  negative?: boolean
}) {
  const color = highlight
    ? tokens.colors.accent.success
    : negative
      ? tokens.colors.accent.error
      : tokens.colors.text.primary

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `6px 12px`,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.full,
        border: `1px solid ${highlight ? tokens.colors.accent.success + '30' : tokens.colors.border.primary}`,
      }}
    >
      <Text style={{ fontSize: 11, color: tokens.colors.text.tertiary, fontWeight: 500 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, color, fontWeight: 700, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
        {value}
      </Text>
    </Box>
  )
}
