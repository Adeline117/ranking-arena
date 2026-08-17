'use client'

/**
 * Shared default-three-tab disclosure for the three independently fetched
 * serving core windows. It deliberately permits pending and stale notices to
 * coexist: one timeframe may still be collecting while another keeps older,
 * truthful data after a failed refresh.
 */

import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'
import ModuleDegraded, { ModuleRefreshFailureNotice } from './ModuleDegraded'

export interface ServingCoreStatusNoticeProps {
  isPendingUpstream: boolean
  isStale: boolean
  isUnavailable: boolean
  isRetrying: boolean
  onRetry: () => void | Promise<unknown>
}

export default function ServingCoreStatusNotice({
  isPendingUpstream,
  isStale,
  isUnavailable,
  isRetrying,
  onRetry,
}: ServingCoreStatusNoticeProps) {
  const { t } = useLanguage()

  if (!isPendingUpstream && !isStale && !isUnavailable) return null

  return (
    <Box style={{ marginBottom: tokens.spacing[3] }}>
      {isPendingUpstream && (
        <Box
          role="status"
          aria-live="polite"
          aria-atomic="true"
          aria-label={t('moduleDataPending')}
        >
          <Text size="xs" color="tertiary" style={{ opacity: 0.7 }}>
            {t('moduleDataPending')}
          </Text>
        </Box>
      )}
      {isStale && (
        <ModuleRefreshFailureNotice isRetrying={isRetrying} onRetry={() => void onRetry()} />
      )}
      {isUnavailable && <ModuleDegraded isRetrying={isRetrying} onRetry={() => void onRetry()} />}
    </Box>
  )
}
