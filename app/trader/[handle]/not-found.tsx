'use client'

import Link from 'next/link'
import { t } from '@/lib/i18n'
import { tokens } from '@/lib/design-tokens'

export default function TraderNotFound() {
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
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: tokens.spacing[3], color: tokens.colors.text.primary }}>
        {t('traderNotFoundTitle')}
      </h1>
      <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6] }}>
        {t('traderNotFoundDesc')}
      </p>
      <Link
        href="/"
        style={{
          padding: '10px 28px',
          borderRadius: 8,
          background: tokens.colors.accent.brand,
          color: '#fff',
          textDecoration: 'none',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        {t('backToHome')}
      </Link>
    </div>
  )
}
