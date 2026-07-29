'use client'

import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens, alpha } from '@/lib/design-tokens'

interface LinkedAccountStatusProps {
  isLoading: boolean
  error: unknown
}

export default function LinkedAccountStatus({
  isLoading,
  error,
}: LinkedAccountStatusProps): React.ReactElement | null {
  const { t } = useLanguage()
  if (!isLoading && !error) return null

  const unavailable = Boolean(error)
  const color = unavailable ? tokens.colors.accent.warning : tokens.colors.text.tertiary

  return (
    <Box
      role="status"
      aria-live="polite"
      data-state={unavailable ? 'unavailable' : 'checking'}
      style={{
        minHeight: 44,
        marginBottom: tokens.spacing[4],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        borderRadius: tokens.radius.md,
        border: `1px solid ${alpha(color, 19)}`,
        background: alpha(color, 4),
      }}
    >
      {unavailable ? (
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v6" />
          <path d="M12 17h.01" />
        </svg>
      ) : (
        <Box
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            borderRadius: tokens.radius.full,
            background: color,
            boxShadow: `0 0 0 4px ${alpha(color, 10)}`,
            flexShrink: 0,
          }}
        />
      )}
      <Text size="xs" style={{ color }}>
        {t(unavailable ? 'linkedAccountsUnavailable' : 'linkedAccountsChecking')}
      </Text>
    </Box>
  )
}
