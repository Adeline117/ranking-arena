'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TAB_KEYS = [
  { href: '/', key: 'rankingsSubNavTraders' as const },
  { href: '/rankings/tokens', key: 'rankingsSubNavTokens' as const },
]

export default function RankingsSubNav() {
  const pathname = usePathname()
  const { t } = useLanguage()

  return (
    <nav
      aria-label={t('rankingsSubNavAriaLabel')}
      style={{
        display: 'flex',
        gap: tokens.spacing[1],
        marginTop: 4,
      }}
    >
      {TAB_KEYS.map((tab) => {
        const isActive = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              borderBottom: isActive ? '2px solid var(--color-brand)' : '2px solid transparent',
              whiteSpace: 'nowrap',
              transition: `all ${tokens.transition.fast}`,
            }}
          >
            {t(tab.key)}
          </Link>
        )
      })}
    </nav>
  )
}
