'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import type { TraderStats } from '@/lib/data/trader'

interface TrustStatsProps {
  stats: TraderStats
}

export default function TrustStats({ stats }: TrustStatsProps) {
  const winRate = stats.trading?.profitableTradesPct || 0
  const avgHoldingTime = stats.additionalStats?.avgHoldingTime || 'N/A'
  const maxDrawdown = stats.additionalStats?.maxDrawdown ?? 0
  const profitFactor = calculateProfitFactor(stats.trading)

  return (
    <Box bg="secondary" p={6} radius="none" border="none">
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[8], color: tokens.colors.text.primary }}>
        关键指标
      </Text>
      
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: tokens.spacing[8],
        }}
      >
        {/* 胜率 */}
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3], fontWeight: tokens.typography.fontWeight.normal }}>
            胜率
          </Text>
          <Text
            size="2xl"
            weight="black"
            style={{ color: getWinRateColor(winRate) }}
          >
            {winRate > 0 ? `${winRate.toFixed(1)}%` : 'N/A'}
          </Text>
        </Box>

        {/* 平均持仓时间 */}
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3], fontWeight: tokens.typography.fontWeight.normal }}>
            平均持仓时间
          </Text>
          <Text size="2xl" weight="black" style={{ color: tokens.colors.text.primary }}>
            {avgHoldingTime}
          </Text>
        </Box>

        {/* 最大回撤 */}
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3], fontWeight: tokens.typography.fontWeight.normal }}>
            最大回撤
          </Text>
          <Text 
            size="2xl" 
            weight="black" 
            style={{ 
              color: maxDrawdown > 0 ? tokens.colors.accent.error : tokens.colors.text.tertiary 
            }}
          >
            {maxDrawdown > 0 ? `-${maxDrawdown.toFixed(2)}%` : 'N/A'}
          </Text>
        </Box>

        {/* Profit Factor */}
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3], fontWeight: tokens.typography.fontWeight.normal }}>
            Profit Factor
          </Text>
          <Text
            size="2xl"
            weight="black"
            style={{ color: getProfitFactorColor(profitFactor) }}
          >
            {formatValue(profitFactor)}
          </Text>
          {profitFactor > 0 && (
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {getProfitFactorLabel(profitFactor)}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}

function calculateProfitFactor(trading: TraderStats['trading']): number {
  if (!trading) return 0
  const { avgProfit, avgLoss, profitableTradesPct } = trading
  if (avgProfit <= 0 || avgLoss <= 0 || profitableTradesPct <= 0 || profitableTradesPct >= 1) return 0
  const lossPct = 1 - profitableTradesPct
  if (lossPct <= 0) return 0
  return (profitableTradesPct * avgProfit) / (lossPct * avgLoss)
}

function formatValue(value: number, suffix = '', fallback = 'N/A'): string {
  if (value === 0 || !Number.isFinite(value)) return fallback
  return value.toFixed(2) + suffix
}

function getWinRateColor(winRate: number): string {
  if (winRate > 0.5) return tokens.colors.accent.success
  if (winRate > 0) return tokens.colors.text.primary
  return tokens.colors.text.tertiary
}

function getProfitFactorColor(profitFactor: number): string {
  if (profitFactor > 1.5) return tokens.colors.accent.success
  if (profitFactor > 1) return tokens.colors.accent.warning
  if (profitFactor > 0) return tokens.colors.accent.error
  return tokens.colors.text.tertiary
}

function getProfitFactorLabel(profitFactor: number): string {
  if (profitFactor >= 2) return '优秀'
  if (profitFactor >= 1.5) return '良好'
  if (profitFactor >= 1) return '及格'
  return '需改进'
}
