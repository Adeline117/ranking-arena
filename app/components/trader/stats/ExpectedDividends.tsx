'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'

interface ExpectedDividendsProps {
  data: TraderStats['expectedDividends']
}

export default function ExpectedDividends({ data }: ExpectedDividendsProps) {
  if (!data) return null

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
          Expected Dividends
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
          See Breakdown
        </button>
      </Box>

      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: tokens.spacing[4],
          mb: 4,
        }}
      >
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Dividend Yield
          </Text>
          <Text size="2xl" weight="black" style={{ color: tokens.colors.accent.success }}>
            {data.dividendYield.toFixed(2)}%
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Assets
          </Text>
          <Text size="2xl" weight="black">
            {data.assets}
          </Text>
        </Box>
      </Box>

      {/* Trending Stocks - 静态轮播占位 */}
      {data.trendingStocks && data.trendingStocks.length > 0 && (
        <Box>
          <Text size="sm" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
            Trending High Dividend Stocks
          </Text>
          <Box style={{ display: 'flex', gap: tokens.spacing[3], overflowX: 'auto' }}>
            {data.trendingStocks.map((stock, idx) => (
              <Box
                key={idx}
                bg="primary"
                p={4}
                radius="lg"
                border="secondary"
                style={{
                  minWidth: 150,
                }}
              >
                <Box
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: tokens.radius.md,
                    background: tokens.colors.bg.secondary,
                    marginBottom: tokens.spacing[2],
                  }}
                />
                <Text size="sm" weight="bold">
                  {stock.symbol}
                </Text>
                <Text size="xs" color="tertiary">
                  {stock.yield}% Yield
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

