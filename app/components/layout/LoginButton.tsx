'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

export default function LoginButton() {
  const { t } = useLanguage()

  return (
    <Link
      href="/login"
      aria-label={t('login')}
      tabIndex={0}
      className="btn-press touch-target top-nav-login-link"
      style={{
        padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
        borderRadius: tokens.radius.lg,
        background: tokens.gradient.primary,
        color: tokens.colors.white,
        textDecoration: 'none',
        fontWeight: tokens.typography.fontWeight.black,
        fontSize: tokens.typography.fontSize.sm,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 72,
        height: 44,
        border: 'none',
        boxShadow: `0 4px 12px var(--color-accent-primary-40)`,
      }}
    >
      {t('login')}
    </Link>
  )
}
