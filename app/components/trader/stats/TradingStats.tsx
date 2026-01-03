'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'

interface TradingStatsProps {
  data: TraderStats['trading']
}

export default function TradingStats({ data }: TradingStatsProps) {
  if (!data) return null

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary" style={{ marginBottom: tokens.spacing[6] }}>
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        Trading
      </Text>
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: tokens.spacing[4],
        }}
      >
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Total Trades (12M)
          </Text>
          <Text size="lg" weight="bold">
            {data.totalTrades12M}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Avg. Profit
          </Text>
          <Text size="lg" weight="bold" style={{ color: tokens.colors.accent.success }}>
            {data.avgProfit >= 0 ? '+' : ''}
            {data.avgProfit.toFixed(2)}%
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Avg. Loss
          </Text>
          <Text size="lg" weight="bold" style={{ color: tokens.colors.accent.error }}>
            {data.avgLoss.toFixed(2)}%
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Profitable Trades
          </Text>
          <Text size="lg" weight="bold" style={{ color: tokens.colors.accent.success }}>
            {data.profitableTradesPct.toFixed(2)}%
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

