'use client'

/**
 * TraderProfileError — pure presentational error state for the trader page.
 *
 * Extracted from TraderProfileClient.tsx (Phase 2 refactor, 2026-04-09).
 * Rendered when SWR errors AND no cached/stale data is available. The UI
 * shows a retry button + a link back to the rankings page.
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'

interface TraderProfileErrorProps {
  /** Translation function passed in to keep the component framework-agnostic */
  t: (key: string) => string
  /** Optional error message to display */
  errorMessage?: string
}

export function TraderProfileError({ t, errorMessage }: TraderProfileErrorProps) {
  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <Box style={{
        maxWidth: 1200,
        margin: '0 auto',
        padding: tokens.spacing[6],
        textAlign: 'center',
        paddingTop: tokens.spacing[8],
      }}>
        <div style={{ fontSize: 48, marginBottom: tokens.spacing[4] }}>⚠️</div>
        <Text size="xl" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('loadFailedRetryMsg')}
        </Text>
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[5] }}>
          {errorMessage || t('networkError')}
        </Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'center' }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.lg,
              border: 'none',
              background: tokens.colors.accent.brand,
              color: tokens.colors.white,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {t('retry')}
          </button>
          <Link
            href="/rankings"
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              color: tokens.colors.text.secondary,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            {t('leaderboardBreadcrumb')}
          </Link>
        </Box>
      </Box>
    </Box>
  )
}
