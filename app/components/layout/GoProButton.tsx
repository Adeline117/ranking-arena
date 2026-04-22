'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { useIsPremium } from '@/lib/premium/hooks'
import { trackEvent } from '@/lib/analytics/track'

export default function GoProButton() {
  const { t } = useLanguage()
  const { isPremium, isLoading } = useIsPremium()

  if (isLoading || isPremium) return null

  return (
    <Link
      href="/pricing"
      onClick={() => trackEvent('click_go_pro_nav')}
      className="btn-press touch-target"
      style={{
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.full,
        background:
          'linear-gradient(135deg, var(--color-accent-primary), var(--color-accent-secondary, var(--color-accent-primary)))',
        color: tokens.colors.white,
        textDecoration: 'none',
        fontWeight: tokens.typography.fontWeight.bold,
        fontSize: tokens.typography.fontSize.xs,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        whiteSpace: 'nowrap',
        border: 'none',
        boxShadow: '0 2px 8px var(--color-accent-primary-40)',
        letterSpacing: '0.3px',
      }}
    >
      {t('goPro')}
    </Link>
  )
}
