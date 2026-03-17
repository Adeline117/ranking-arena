'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function NotFound() {
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
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <line x1="7" y1="8" x2="7" y2="12" />
          <line x1="11" y1="6" x2="11" y2="12" />
          <line x1="15" y1="9" x2="15" y2="12" />
        </svg>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: tokens.spacing[2], color: tokens.colors.text.primary }}>
        {t('exchangeNotFound')}
      </h1>
      <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6], maxWidth: 360, lineHeight: 1.6 }}>
        {t('exchangeNotFoundDesc')}
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
