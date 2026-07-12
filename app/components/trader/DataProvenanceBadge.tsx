'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * Data-authenticity provenance chip for the trader PROFILE (A1, Myfxbook model).
 *
 * `verified` → green ✓ Verified (numbers pulled from a connected read-only API
 * key); otherwise grey "Tracked" (scraped from the exchange leaderboard, not
 * independently verified). Unlike the ranking cards' VerifiedDataBadge — which
 * only renders the positive state — this ALSO shows the honest default so a
 * visitor evaluating a trader always knows the provenance. Prod currently has 0
 * API-verified traders, so profiles honestly read "Tracked" until a key is
 * connected (via the Claim/Verify flow the tooltip points to).
 *
 * Theme-aware (success vs tertiary tokens shift with light/dark).
 */
export default function DataProvenanceBadge({ verified }: { verified?: boolean }) {
  const { t } = useLanguage()
  const isVerified = !!verified

  return (
    <span
      role="img"
      aria-label={isVerified ? t('provenanceVerified') : t('provenanceTracked')}
      title={isVerified ? t('provenanceVerifiedTip') : t('provenanceTrackedTip')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
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
      {isVerified ? (
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
      ) : (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.text.tertiary}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4l2.5 2.5" />
        </svg>
      )}
      {isVerified ? t('provenanceVerified') : t('provenanceTracked')}
    </span>
  )
}
