'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'
import type { TraderPerformance } from '@/lib/data/trader'

export interface OverviewPerformanceCardProps {
  performance: TraderPerformance
  profitableWeeksPct?: number // 盈利周数百分比（可选）
}

type Period = '7D' | '30D' | '90D'

/**
 * Performance卡片 - 交易员主页核心指标
 * ROI视觉权重最高，其他指标中性色
 * 只显示 7D/30D/90D（Binance提供的时间段）
 */
export default function OverviewPerformanceCard({ performance, profitableWeeksPct }: OverviewPerformanceCardProps) {
  // profitableWeeksPct 可在需要时使用
  void profitableWeeksPct
  const { t } = useLanguage()
  const [period, setPeriod] = useState<Period>('90D')

  // 根据时间段获取对应数据
  const getData = () => {
    switch (period) {
      case '7D':
        return {
          roi: performance.roi_7d,
          pnl: performance.pnl_7d,
          winRate: performance.win_rate_7d,
          maxDrawdown: performance.max_drawdown_7d,
          arenaScore: (performance as any).arena_score_7d,
        }
      case '30D':
        return {
          roi: performance.roi_30d,
          pnl: performance.pnl_30d,
          winRate: performance.win_rate_30d,
          maxDrawdown: performance.max_drawdown_30d,
          arenaScore: (performance as any).arena_score_30d,
        }
      case '90D':
      default:
        return {
          roi: performance.roi_90d,
          pnl: performance.pnl,
          winRate: performance.win_rate,
          maxDrawdown: performance.max_drawdown,
          arenaScore: (performance as any).arena_score_90d,
        }
    }
  }

  const data = getData()
  const { roi, pnl, winRate, maxDrawdown, arenaScore } = data
  const overallScore = (performance as any).overall_score

  return (
    <Box bg="secondary" p={6} radius="none" border="none">
      {/* Header - 最小化 */}
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: tokens.spacing[8],
        }}
      >
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {t('performance')}
        </Text>
        {/* 时间选择 - 只显示 7D/30D/90D */}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            cursor: 'pointer',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          <option value="7D">7D</option>
          <option value="30D">30D</option>
          <option value="90D">90D</option>
        </select>
      </Box>

      {/* Arena Score + ROI Display - 双核心指标 */}
      <Box style={{ 
        display: 'flex', 
        gap: tokens.spacing[6], 
        marginBottom: tokens.spacing[8],
        alignItems: 'flex-end',
      }}>
        {/* Arena Score - 核心排名指标 */}
        <Box style={{ flex: '0 0 auto' }}>
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 72,
              height: 72,
              borderRadius: tokens.radius.lg,
              background: arenaScore !== undefined && arenaScore >= 60 
                ? `linear-gradient(135deg, ${tokens.colors.accent.success}20, ${tokens.colors.accent.success}10)`
                : arenaScore !== undefined && arenaScore >= 40
                  ? `linear-gradient(135deg, ${tokens.colors.accent.warning}15, ${tokens.colors.accent.warning}08)`
                  : tokens.colors.bg.tertiary,
              border: `2px solid ${
                arenaScore !== undefined && arenaScore >= 60 
                  ? tokens.colors.accent.success + '50'
                  : arenaScore !== undefined && arenaScore >= 40
                    ? tokens.colors.accent.warning + '40'
                    : tokens.colors.border.primary
              }`,
              marginBottom: tokens.spacing[2],
            }}
          >
            <Text
              size="2xl"
              weight="black"
              style={{
                color: arenaScore !== undefined && arenaScore >= 60 
                  ? tokens.colors.accent.success
                  : arenaScore !== undefined && arenaScore >= 40
                    ? tokens.colors.accent.warning
                    : tokens.colors.text.secondary,
                lineHeight: 1,
              }}
            >
              {arenaScore !== undefined ? arenaScore.toFixed(1) : '—'}
            </Text>
          </Box>
          <Text size="xs" color="tertiary" style={{ 
            fontWeight: tokens.typography.fontWeight.normal,
            textAlign: 'center',
            display: 'block',
          }}>
            Score ({period})
          </Text>
        </Box>

        {/* ROI Display */}
        <Box style={{ flex: 1 }}>
          <Text
            size="3xl"
            weight="black"
            style={{
              color: roi !== undefined 
                ? (roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
                : tokens.colors.text.tertiary,
              lineHeight: 1.1,
              marginBottom: tokens.spacing[2],
              letterSpacing: '-0.02em',
            }}
          >
            {roi !== undefined ? `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%` : t('na')}
          </Text>
          <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.normal }}>
            {t('roi')} ({period})
          </Text>
        </Box>

        {/* Overall Score - 总体评分 */}
        {overallScore !== undefined && (
          <Box style={{ flex: '0 0 auto', textAlign: 'right' }}>
            <Text size="xs" color="tertiary" style={{ 
              marginBottom: tokens.spacing[1],
              display: 'block',
            }}>
              Overall
            </Text>
            <Box
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                background: overallScore >= 60 
                  ? `${tokens.colors.accent.success}15`
                  : overallScore >= 40
                    ? `${tokens.colors.accent.warning}10`
                    : tokens.colors.bg.tertiary,
                border: `1px solid ${
                  overallScore >= 60 
                    ? tokens.colors.accent.success + '30'
                    : overallScore >= 40
                      ? tokens.colors.accent.warning + '25'
                      : tokens.colors.border.primary
                }`,
              }}
            >
              <Text
                size="lg"
                weight="black"
                style={{
                  color: overallScore >= 60 
                    ? tokens.colors.accent.success
                    : overallScore >= 40
                      ? tokens.colors.accent.warning
                      : tokens.colors.text.secondary,
                  lineHeight: 1,
                }}
              >
                {overallScore.toFixed(1)}
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* 辅助指标 - 显示关键数据（只显示有真实数据的指标） */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: tokens.spacing[4],
          paddingTop: tokens.spacing[4],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {t('pnl')}
            </Text>
            <InfoIcon tooltip={t('pnl')} />
          </Box>
          <Text size="base" weight="bold" style={{ 
            color: pnl !== undefined 
              ? (pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
              : tokens.colors.text.secondary 
          }}>
            {pnl !== undefined ? `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl) >= 1000000 ? (pnl / 1000000).toFixed(2) + 'M' : Math.abs(pnl) >= 1000 ? (pnl / 1000).toFixed(2) + 'K' : pnl.toFixed(2)}` : t('na')}
          </Text>
        </Box>
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {t('winRate')}
            </Text>
            <InfoIcon tooltip={t('winRate')} />
          </Box>
          <Text size="base" weight="bold" style={{ 
            color: winRate !== undefined && winRate > 50 ? tokens.colors.accent.success : tokens.colors.text.secondary 
          }}>
            {winRate !== undefined ? `${winRate.toFixed(1)}%` : t('na')}
          </Text>
        </Box>
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              {t('maxDrawdown')}
            </Text>
            <InfoIcon tooltip={t('maxDrawdown')} />
          </Box>
          <Text size="base" weight="bold" style={{ 
            color: maxDrawdown !== undefined ? tokens.colors.accent.error : tokens.colors.text.secondary 
          }}>
            {maxDrawdown !== undefined ? `-${maxDrawdown.toFixed(2)}%` : t('na')}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

// Info Icon Component
function InfoIcon({ tooltip }: { tooltip: string }) {
  const [showTooltip, setShowTooltip] = useState(false)

  return (
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
          border: `1px solid ${tokens.colors.text.tertiary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'help',
          fontSize: '10px',
          color: tokens.colors.text.tertiary,
          flexShrink: 0,
        }}
      >
        i
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
            maxWidth: 200,
            whiteSpace: 'normal',
            textAlign: 'center',
          }}
        >
          {tooltip}
        </Box>
      )}
    </Box>
  )
}
