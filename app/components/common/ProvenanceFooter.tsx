'use client'

/**
 * Provenance footer (spec §6, REQUIRED on every board and profile):
 * "{Exchange} · as of {relative time}". Timestamps are stored UTC and
 * converted to the viewer's locale ONLY here at render (spec §5.9).
 * Derived boards additionally carry the coverage-bias badge.
 */

import { tokens, alpha } from '@/lib/design-tokens'
import { Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { describeDataTime } from '@/lib/utils/data-time'
import type { Provenance } from '@/lib/data/serving/types'
import DerivedBoardBadge from './DerivedBoardBadge'

export interface ProvenanceFooterProps {
  provenance: Provenance
  /** Display name; falls back to the source slug. */
  exchangeName?: string
  /**
   * Myfxbook-style data-authenticity tier. Renders a chip ONLY when provided
   * (boards omit it; profiles pass it):
   *  - 'tracked'  → metrics scraped from the exchange's public leaderboard.
   *  - 'verified' → trades confirmed via read-only API access.
   */
  verificationTier?: 'verified' | 'tracked'
  style?: React.CSSProperties
}

export default function ProvenanceFooter({
  provenance,
  exchangeName,
  verificationTier,
  style,
}: ProvenanceFooterProps) {
  const { t, language } = useLanguage()
  const name = exchangeName || provenance.source
  const isVerified = verificationTier === 'verified'
  // The serving RPCs emit the Unix epoch for an unknown capture time; never
  // render that (or an invalid value) as a real "as of" age.
  const dataTime = describeDataTime(provenance.asOf)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        marginTop: tokens.spacing[2],
        flexWrap: 'wrap',
        ...style,
      }}
    >
      <Text size="xs" color="tertiary">
        {t('provenanceSource')}: {name} · {t('provenanceAsOf')}{' '}
        {dataTime.iso ? (
          <time
            dateTime={dataTime.iso}
            title={new Date(dataTime.iso).toLocaleString()}
            suppressHydrationWarning
          >
            {formatTimeAgo(dataTime.iso, language)}
          </time>
        ) : (
          t('unknown')
        )}
        {dataTime.isStale && (
          <span
            data-testid="provenance-stale"
            suppressHydrationWarning
            style={{ color: tokens.colors.accent.warning }}
          >
            {' · '}
            {t('dataStaleWarning')}
          </span>
        )}
      </Text>
      {verificationTier && (
        <span
          title={isVerified ? t('provenanceVerifiedTip') : t('provenanceTrackedTip')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: '1px 7px',
            borderRadius: tokens.radius.sm,
            background: isVerified
              ? alpha(tokens.colors.accent.success, 8)
              : alpha(tokens.colors.text.tertiary, 10),
            border: `1px solid ${
              isVerified
                ? alpha(tokens.colors.accent.success, 21)
                : alpha(tokens.colors.text.tertiary, 21)
            }`,
            color: isVerified ? tokens.colors.accent.success : tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: Number(tokens.typography.fontWeight.semibold),
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
          }}
        >
          {isVerified && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke={tokens.colors.accent.success}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          {isVerified ? t('provenanceVerified') : t('provenanceTracked')}
        </span>
      )}
      {provenance.derived && <DerivedBoardBadge />}
    </div>
  )
}
