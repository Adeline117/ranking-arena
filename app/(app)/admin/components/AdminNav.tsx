'use client'

/**
 * AdminNav — shared cross-navigation for the sibling admin routes.
 *
 * Root cause fix: the admin routes had no links between them, so every page
 * except the one you typed was unreachable UI. Freshness now lives only in the
 * /admin scraper-status tab; /admin/data-health remains a bookmark redirect,
 * not a duplicate navigation destination.
 *
 * A11y: <nav aria-label> landmark + aria-current="page" on the active route.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const NAV_ITEMS: { href: string; labelKey: string }[] = [
  { href: '/admin', labelKey: 'adminNavDashboard' },
  { href: '/admin/monitoring', labelKey: 'adminNavMonitoring' },
  { href: '/admin/pro-metrics', labelKey: 'adminNavProMetrics' },
  { href: '/admin/reports', labelKey: 'adminNavReports' },
]

export default function AdminNav() {
  const { t } = useLanguage()
  const pathname = usePathname()

  return (
    <nav
      aria-label={t('adminNavLabel')}
      style={{
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: `0 ${tokens.spacing[6]}`,
          display: 'flex',
          gap: tokens.spacing[1],
          flexWrap: 'wrap',
        }}
      >
        {NAV_ITEMS.map((item) => {
          // '/admin' is a prefix of every sibling route, so it must match exactly;
          // sub-routes match on prefix to stay highlighted on nested paths.
          const isActive =
            item.href === '/admin'
              ? pathname === '/admin'
              : pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              style={{
                padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: isActive
                  ? tokens.typography.fontWeight.bold
                  : tokens.typography.fontWeight.medium,
                color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                borderBottom: `2px solid ${
                  isActive ? tokens.colors.accent.primary : 'transparent'
                }`,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {t(item.labelKey)}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
