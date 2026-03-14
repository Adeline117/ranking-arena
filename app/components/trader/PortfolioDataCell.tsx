import { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface DataCellProps {
  label: string
  value: string
  highlight?: boolean
  isProfit?: boolean
  secondary?: boolean
}

const PortfolioDataCell = memo(function PortfolioDataCell({
  label,
  value,
  highlight,
  isProfit,
  secondary,
}: DataCellProps) {
  return (
    <Box>
      <Text size="xs" style={{ color: tokens.colors.text.tertiary, marginBottom: 4, display: 'block' }}>
        {label}
      </Text>
      <Text
        size="sm"
        weight={highlight ? 'black' : 'bold'}
        style={{
          color: highlight
            ? (isProfit ? tokens.colors.accent.success : tokens.colors.accent.error)
            : (secondary ? tokens.colors.text.secondary : tokens.colors.text.primary),
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        }}
      >
        {value}
      </Text>
    </Box>
  )
})

export default PortfolioDataCell
