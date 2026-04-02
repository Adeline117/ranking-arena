'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TAB_KEYS = [
  { href: '/', key: 'homeSubNavTraders' as const },
]

export default function HomeSubNav() {
  const pathname = usePathname()
  const { t } = useLanguage()

  return (
    <nav
      aria-label={t('homeSubNavAriaLabel')}
      style={{
        display: 'flex',
        gap: tokens.spacing[1],
        marginTop: 4,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
      }}
      className="home-subnav-scroll"
    >
      {TAB_KEYS.map((tab) => {
        const isActive = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            prefetch={false}
            className="btn-press home-subnav-pill"
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--color-on-accent, #fff)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              background: isActive ? 'var(--color-accent-primary)' : 'transparent',
              borderRadius: tokens.radius.full,
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
