'use client'

import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

/**
 * The mobile market tab is an entry point to Arena's trader watchlist, not a
 * token-price watchlist. Keep that product boundary explicit and link to the
 * existing saved-traders hub instead of claiming the feature is coming soon.
 */
export default function MarketWatchlistEntry() {
  const { t } = useLanguage()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 200,
        padding: tokens.spacing[5],
        textAlign: 'center',
        gap: tokens.spacing[2],
      }}
    >
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        style={{ color: tokens.colors.text.tertiary, opacity: 0.7 }}
      >
        <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
      </svg>
      <span
        style={{
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.base,
          fontWeight: tokens.typography.fontWeight.bold,
        }}
      >
        {t('watchlistTitle')}
      </span>
      <span
        style={{
          maxWidth: 360,
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.sm,
          lineHeight: tokens.typography.lineHeight.relaxed,
        }}
      >
        {t('watchlistSubtitle')}
      </span>
      <Link
        href="/saved?tab=traders"
        style={{
          minHeight: 44,
          marginTop: tokens.spacing[2],
          padding: `0 ${tokens.spacing[5]}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: tokens.radius.md,
          background: tokens.colors.accent.primary,
          color: tokens.colors.bg.primary,
          textDecoration: 'none',
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.semibold,
        }}
      >
        {t('viewAll')}
      </Link>
    </div>
  )
}
