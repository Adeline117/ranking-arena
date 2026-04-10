'use client'

/**
 * TraderStatusBanners — small banner components for the trader page.
 *
 * Extracted from TraderProfileClient.tsx (Phase 2 refactor). These are
 * pure stateless renders gated on boolean props — keeping them out of
 * the main file makes the conditional rendering tree easier to read.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

interface TraderStaleBannerProps {
  show: boolean
  t: (key: string) => string
}

/**
 * Stale data banner — shown when SWR errored but cached/stale data is
 * still available so we can serve the trader content.
 */
export function TraderStaleBanner({ show, t }: TraderStaleBannerProps) {
  if (!show) return null
  return (
    <Box style={{
      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
      marginBottom: tokens.spacing[3],
      background: `${tokens.colors.accent.warning}12`,
      border: `1px solid ${tokens.colors.accent.warning}30`,
      borderRadius: tokens.radius.md,
      display: 'flex',
      alignItems: 'center',
      gap: tokens.spacing[2],
    }}>
      <Text size="xs" style={{ color: tokens.colors.accent.warning }}>
        {t('dataOutdatedBanner') || 'Data may be outdated. Refresh to get the latest.'}
      </Text>
    </Box>
  )
}

interface TraderPlatformDeadBannerProps {
  show: boolean
  source: string
  t: (key: string) => string
}

/**
 * Platform-dead banner — shown when the exchange is in our isDead() list
 * (data may be stale because we no longer poll the platform).
 */
export function TraderPlatformDeadBanner({ show, source, t }: TraderPlatformDeadBannerProps) {
  if (!show) return null
  const exchangeName = EXCHANGE_NAMES[source] || source
  return (
    <Box style={{
      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
      marginBottom: tokens.spacing[3],
      background: `${tokens.colors.accent.error}10`,
      border: `1px solid ${tokens.colors.accent.error}25`,
      borderRadius: tokens.radius.md,
      display: 'flex',
      alignItems: 'center',
      gap: tokens.spacing[2],
    }}>
      <Text size="sm" style={{ color: tokens.colors.accent.error }}>
        {t('platformDataUnavailable') || `Data for ${exchangeName} is temporarily unavailable. Historical data shown below may be outdated.`}
      </Text>
    </Box>
  )
}
