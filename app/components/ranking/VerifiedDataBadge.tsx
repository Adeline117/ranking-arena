'use client'

import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * ✓ Verified badge (A1 data-authenticity) — shown on trader cards/rows whose
 * numbers are pulled from a connected read-only API key (vs scraped "Tracked").
 * The moat signal that lets API-verified traders stand out in the rankings.
 * Success-themed (shifts with light/dark theme). Reuses the provenance copy.
 */

interface VerifiedDataBadgeProps {
  verified?: boolean
  /** Icon-only (dense table cells) — hides the text label. */
  compact?: boolean
}

export default function VerifiedDataBadge({ verified, compact }: VerifiedDataBadgeProps) {
  const { t } = useLanguage()
  if (!verified) return null

  return (
    <span
      role="img"
      aria-label={t('provenanceVerified')}
      title={t('provenanceVerifiedTip')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: compact ? '1px 4px' : '2px 7px',
        borderRadius: tokens.radius.sm,
        background: alpha(tokens.colors.accent.success, 8),
        border: `1px solid ${alpha(tokens.colors.accent.success, 21)}`,
        color: tokens.colors.accent.success,
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: Number(tokens.typography.fontWeight.bold),
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
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
      {!compact && t('provenanceVerified')}
    </span>
  )
}
