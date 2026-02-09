'use client'

import Link from 'next/link'
import { t } from '@/lib/i18n'
import { tokens } from '@/lib/design-tokens'

export default function GroupNotFound() {
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
        {t('groupNotFoundTitle')}
      </h1>
      <p style={{ fontSize: 14, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[6] }}>
        {t('groupNotFoundDesc')}
      </p>
      <Link
        href="/groups"
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
        {t('backToGroups2')}
      </Link>
    </div>
  )
}
