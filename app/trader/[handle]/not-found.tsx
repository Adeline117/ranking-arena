'use client'

import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { tokens } from '@/lib/design-tokens'

export default function TraderNotFound() {
  const { t } = useLanguage()

  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: tokens.spacing[8],
      textAlign: 'center',
    }}>
      {/* Icon */}
      <div style={{
        width: 72,
        height: 72,
        borderRadius: '50%',
        background: tokens.gradient.primarySubtle,
        border: `1px solid ${tokens.colors.accent.primary}20`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: tokens.spacing[4],
      }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
          <line x1="18" y1="8" x2="23" y2="13" />
          <line x1="23" y1="8" x2="18" y2="13" />
        </svg>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: tokens.spacing[2], color: tokens.colors.text.primary }}>
        {t('traderNotFoundTitle')}
      </h1>
      <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6], maxWidth: 360, lineHeight: 1.6 }}>
        {t('traderNotFoundDesc')}
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/rankings"
          style={{
            padding: '10px 28px',
            borderRadius: tokens.radius.md,
            background: tokens.colors.accent.brand,
            color: tokens.colors.white,
            textDecoration: 'none',
            fontWeight: 600,
            fontSize: 14,
          }}
        >
          {t('goToRankings')}
        </Link>
        <Link
          href="/search"
          style={{
            padding: '10px 28px',
            borderRadius: tokens.radius.md,
            background: 'transparent',
            border: `1px solid ${tokens.colors.border.primary}`,
            color: tokens.colors.text.primary,
            textDecoration: 'none',
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          {t('search')}
        </Link>
        <Link
          href="/"
          style={{
            padding: '10px 28px',
            borderRadius: tokens.radius.md,
            background: 'transparent',
            border: `1px solid ${tokens.colors.border.primary}`,
            color: tokens.colors.text.primary,
            textDecoration: 'none',
            fontWeight: 500,
            fontSize: 14,
          }}
        >
          {t('backToHome')}
        </Link>
      </div>
    </div>
  )
}
