'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../Base'
import type { TraderStats } from '@/lib/data/trader'

interface AdditionalStatsProps {
  data: TraderStats['additionalStats']
}

export default function AdditionalStats({ data }: AdditionalStatsProps) {
  if (!data) return null

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary" style={{ marginBottom: tokens.spacing[6] }}>
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        Additional Stats
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
            Trades Per Week
          </Text>
          <Text size="lg" weight="bold">
            {data.tradesPerWeek !== undefined ? data.tradesPerWeek.toFixed(2) : 'N/A'}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Avg. Holdings time
          </Text>
          <Text size="lg" weight="bold">
            {data.avgHoldingTime}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Tracked since (first seen in Arena)
          </Text>
          <Text size="lg" weight="bold">
            {data.activeSince}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            Profitable weeks
          </Text>
          <Text size="lg" weight="bold" style={{ color: '#7CFFB2' }}>
            {data.profitableWeeksPct !== undefined ? data.profitableWeeksPct.toFixed(2) : 'N/A'}%
          </Text>
        </Box>
      </Box>
    </Box>
  )
}







