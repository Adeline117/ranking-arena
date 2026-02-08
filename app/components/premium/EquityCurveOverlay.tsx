'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

export const CHART_COLORS = [tokens.colors.accent.brand, '#06B6D4', '#F59E0B', '#10B981', '#EF4444']

interface EquityTrader {
  traderId: string
  traderName: string
  data: Array<{ date: string; roi: number }>
  color: string
}

interface EquityCurveOverlayProps {
  traders: EquityTrader[]
  height?: number
}

export default function EquityCurveOverlay({ height = 200 }: EquityCurveOverlayProps) {
  return (
    <Box style={{
      width: '100%',
      height,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.xl,
      border: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Text size="sm" color="tertiary">Equity Curve</Text>
    </Box>
  )
}
