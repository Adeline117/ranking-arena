
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface RadarChartProps {
  data: Array<{ label: string; values: number[] }>
  traderNames: string[]
  colors?: string[]
  size?: number
}

export default function RadarChart({ size = 300 }: RadarChartProps) {
  return (
    <Box style={{
      width: size,
      height: size,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.xl,
      border: `1px solid ${tokens.colors.border.primary}`,
    }}>
      <Text size="sm" color="tertiary">Radar Chart</Text>
    </Box>
  )
}
