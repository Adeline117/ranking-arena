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
  // TODO: maxDrawdown 和 profitFactor 需要添加到数据层
  // 暂时使用占位数据
  const maxDrawdown = 0 // TODO: 从stats中获取
  const profitFactor = 0 // TODO: 从stats.trading中获取或计算

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
          <Text size="2xl" weight="black" style={{ color: tokens.colors.text.primary }}>
            {winRate.toFixed(1)}%
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
          <Text size="2xl" weight="black" style={{ color: tokens.colors.text.primary }}>
            {maxDrawdown > 0 ? maxDrawdown.toFixed(2) + '%' : 'N/A'}
          </Text>
        </Box>

        {/* Profit Factor */}
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3], fontWeight: tokens.typography.fontWeight.normal }}>
            Profit Factor
          </Text>
          <Text size="2xl" weight="black" style={{ color: tokens.colors.text.primary }}>
            {profitFactor > 0 ? profitFactor.toFixed(2) : 'N/A'}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
