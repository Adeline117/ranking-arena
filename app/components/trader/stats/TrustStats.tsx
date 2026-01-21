'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'

interface TrustStatsProps {
  stats: TraderStats
}

/**
 * Stats页面 - 信任构建功能
 * 只保留关键指标：胜率、平均持仓时间、最大回撤、Profit Factor
 */
export default function TrustStats({ stats }: TrustStatsProps) {
  // 从stats中提取关键指标
  const winRate = stats.trading?.profitableTradesPct || 0
  const avgHoldingTime = stats.additionalStats?.avgHoldingTime || 'N/A'
  
  // 从 additionalStats 获取 maxDrawdown
  const maxDrawdown = stats.additionalStats?.maxDrawdown ?? 0
  
  // 计算 Profit Factor: avgProfit * profitableTradesPct / (avgLoss * (1 - profitableTradesPct))
  // 如果没有足够数据，显示 N/A
  // 注意：profitableTradesPct 是小数形式（如 0.85 表示 85%）
  let profitFactor = 0
  if (stats.trading) {
    const { avgProfit, avgLoss, profitableTradesPct } = stats.trading
    if (avgProfit > 0 && avgLoss > 0 && profitableTradesPct > 0 && profitableTradesPct < 1) {
      // Profit Factor = (胜率 * 平均盈利) / ((1-胜率) * 平均亏损)
      const winPct = profitableTradesPct  // 已经是小数形式
      const lossPct = 1 - winPct
      if (lossPct > 0 && avgLoss > 0) {
        profitFactor = (winPct * avgProfit) / (lossPct * avgLoss)
      }
    }
  }

  // 格式化显示值
  const formatValue = (value: number, suffix: string = '', fallback: string = 'N/A') => {
    if (value === 0 || !Number.isFinite(value)) return fallback
    return value.toFixed(2) + suffix
  }

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
            style={{ 
              color: winRate > 0.5 ? tokens.colors.accent.success : 
                     winRate > 0 ? tokens.colors.text.primary : 
                     tokens.colors.text.tertiary 
            }}
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
            style={{ 
              color: profitFactor > 1.5 ? tokens.colors.accent.success : 
                     profitFactor > 1 ? tokens.colors.accent.warning :
                     profitFactor > 0 ? tokens.colors.accent.error :
                     tokens.colors.text.tertiary 
            }}
          >
            {formatValue(profitFactor)}
          </Text>
          {profitFactor > 0 && (
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              {profitFactor >= 2 ? '优秀' : profitFactor >= 1.5 ? '良好' : profitFactor >= 1 ? '及格' : '需改进'}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}
