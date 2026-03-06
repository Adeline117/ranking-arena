'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const TAB_KEYS = [
  { href: '/', key: 'homeSubNavTraders' as const },
  { href: '/rankings/resources', key: 'homeSubNavResources' as const },
  { href: '/rankings/institutions', key: 'homeSubNavInstitutions' as const },
  { href: '/rankings/tools', key: 'homeSubNavTools' as const },
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
      }}
    >
      {TAB_KEYS.map((tab) => {
        const isActive = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="btn-press"
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              borderBottom: isActive ? '2px solid var(--color-brand)' : '2px solid transparent',
              whiteSpace: 'nowrap',
              transition: `all ${tokens.transition.fast}`,
              borderRadius: `${tokens.radius.md} ${tokens.radius.md} 0 0`,
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--color-text-primary)'
                e.currentTarget.style.backgroundColor = 'var(--color-bg-hover)'
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.color = 'var(--color-text-secondary)'
                e.currentTarget.style.backgroundColor = 'transparent'
              }
            }}
          >
            {t(tab.key)}
          </Link>
        )
      })}
    </nav>
  )
}
