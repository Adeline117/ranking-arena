'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import type { TraderStats } from '@/lib/data/trader'

interface FrequentlyTradedProps {
  data: TraderStats['frequentlyTraded']
}

export default function FrequentlyTraded({ data }: FrequentlyTradedProps) {
  if (!data || data.length === 0) return null

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary" style={{ marginBottom: tokens.spacing[6] }}>
      <Box
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: tokens.spacing[4],
        }}
      >
        <Text size="lg" weight="black">
          Frequently Traded
        </Text>
        <button
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.xs,
            cursor: 'pointer',
          }}
        >
          View All
        </button>
      </Box>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {data.map((item, idx) => (
          <Box
            key={idx}
            bg="primary"
            p={4}
            radius="lg"
            border="secondary"
            style={{
              display: 'grid',
              gridTemplateColumns: '80px 1fr repeat(3, 120px)',
              alignItems: 'center',
              gap: tokens.spacing[4],
            }}
          >
            {/* Symbol */}
            <Box
              style={{
                width: 40,
                height: 40,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.secondary,
              }}
            />
            <Box>
              <Text size="sm" weight="bold">
                {item.symbol}
              </Text>
              <Text size="xs" color="tertiary">
                {item.weightPct.toFixed(2)}% ({item.count})
              </Text>
            </Box>
            <Box>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                Avg. Profit
              </Text>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.success }}>
                {item.avgProfit >= 0 ? '+' : ''}
                {item.avgProfit.toFixed(2)}%
              </Text>
            </Box>
            <Box>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                Avg. Loss
              </Text>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.error }}>
                {item.avgLoss.toFixed(2)}%
              </Text>
            </Box>
            <Box>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                Profitable
              </Text>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.success }}>
                {item.profitablePct.toFixed(2)}%
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

