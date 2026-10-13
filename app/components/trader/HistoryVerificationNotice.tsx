'use client'

/**
 * Unified placeholder for trader-detail sections whose historical data is
 * quarantined (public /core projection `cacheState: 'quarantined'`, history
 * `historical_metric_publication_unavailable`). Replaces empty charts and
 * "--" grids with an explicit "under verification" state.
 *
 * `currentRanking` may only carry values from the sealed public ranked
 * leaderboard (first-screen entries with rankingVisibility === 'verified');
 * this component never fetches quarantined data.
 */

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'
import { formatROI } from '@/lib/utils/format'

export interface SealedCurrentRanking {
  period: string
  rank: number
  roi: number
}

export interface HistoryVerificationNoticeProps {
  currentRanking?: SealedCurrentRanking | null
  compact?: boolean
}

export default function HistoryVerificationNotice({
  currentRanking,
  compact = false,
}: HistoryVerificationNoticeProps) {
  const { t } = useLanguage()

  return (
    <Box
      role="status"
      data-testid="history-verification-notice"
      style={{
        padding: compact ? tokens.spacing[5] : `${tokens.spacing[8]} ${tokens.spacing[5]}`,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[2],
      }}
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
      <Text size="base" weight="bold" color="secondary">
        {t('historyVerificationTitle')}
      </Text>
      <Text size="sm" color="tertiary" style={{ maxWidth: 420, lineHeight: 1.6 }}>
        {t('historyVerificationDesc')}
      </Text>

      {currentRanking && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            display: 'flex',
            gap: tokens.spacing[6],
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary">
              {t('historyVerificationCurrentRanking').replace('{period}', currentRanking.period)}
            </Text>
            <Text size="lg" weight="bold" color="primary">
              #{currentRanking.rank}
            </Text>
          </Box>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
            <Text size="xs" color="tertiary">
              ROI ({currentRanking.period})
            </Text>
            <Text
              size="lg"
              weight="bold"
              style={{
                color:
                  currentRanking.roi >= 0
                    ? 'var(--color-accent-success)'
                    : 'var(--color-accent-error)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatROI(currentRanking.roi)}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
