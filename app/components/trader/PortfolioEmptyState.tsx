'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface EmptyStateProps {
  message: string
  subMessage: string
}

export default function PortfolioEmptyState({ message, subMessage }: EmptyStateProps) {
  return (
    <Box style={{
      padding: tokens.spacing[10],
      textAlign: 'center',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: tokens.spacing[3],
    }}>
      <Text size="base" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
        {message}
      </Text>
      <Text size="sm" color="tertiary">
        {subMessage}
      </Text>
    </Box>
  )
}
