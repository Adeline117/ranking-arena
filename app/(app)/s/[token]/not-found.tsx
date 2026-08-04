'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export default function NotFound() {
  const { t } = useLanguage()
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing[8],
        textAlign: 'center',
      }}
    >
      <h1
        style={{
          fontSize: tokens.typography.fontSize['2xl'],
          fontWeight: tokens.typography.fontWeight.bold,
          marginBottom: tokens.spacing[3],
          color: tokens.colors.text.primary,
        }}
      >
        {t('linkNotFoundTitle')}
      </h1>
      <p
        style={{
          fontSize: tokens.typography.fontSize.base,
          color: tokens.colors.text.secondary,
          marginBottom: tokens.spacing[6],
        }}
      >
        {t('linkNotFoundDesc')}
      </p>
      <Link
        href="/"
        style={{
          minHeight: 44,
          padding: `${tokens.spacing[2]} ${tokens.spacing[8]}`,
          borderRadius: tokens.radius.md,
          background: tokens.colors.accent.brand,
          color: tokens.colors.white,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          textDecoration: 'none',
          fontWeight: tokens.typography.fontWeight.semibold,
          fontSize: tokens.typography.fontSize.base,
        }}
      >
        {t('backToHome')}
      </Link>
    </div>
  )
}
