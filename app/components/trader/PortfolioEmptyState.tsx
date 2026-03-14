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
      <Box style={{
        width: 48,
        height: 48,
        borderRadius: tokens.radius.full,
        background: `${tokens.colors.text.tertiary}10`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: tokens.spacing[1],
      }}>
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
      </Box>
      <Text size="base" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
        {message}
      </Text>
      <Text size="sm" color="tertiary">
        {subMessage}
      </Text>
    </Box>
  )
}
