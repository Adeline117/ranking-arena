'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { PRIMARY_NAV_ITEMS } from '@/lib/config/primary-nav'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

// Surface-specific tooltips keyed by canonical path (top nav only).
const TOOLTIP_KEYS: Record<string, string | undefined> = {
  '/market': 'navTooltipMarket',
  '/groups': 'navTooltipGroups',
}

export default function NavLinks() {
  const { t, language: _language } = useLanguage()
  const pathname = usePathname()

  const items = PRIMARY_NAV_ITEMS.map((item) => {
    const tooltipKey = TOOLTIP_KEYS[item.href]
    return {
      href: item.href,
      labelKey: item.labelKey,
      tooltip: tooltipKey ? t(tooltipKey) : undefined,
    }
  })

  return (
    <Box
      as="nav"
      aria-label={t('mainNavigation')}
      className="hide-mobile"
      style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}
    >
      {items.map((item) => {
        const label = t(item.labelKey)
        const isActive =
          item.href === '/'
            ? pathname === '/' || pathname.startsWith('/rankings')
            : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            className={`top-nav-link${isActive ? ' top-nav-link-active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            title={item.tooltip}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              color: isActive ? 'var(--color-brand)' : 'var(--color-text-secondary)',
              textDecoration: 'none',
              fontWeight: isActive ? 800 : 600,
              fontSize: tokens.typography.fontSize.sm,
              background: isActive ? 'var(--color-accent-primary-12)' : 'transparent',
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {label}
          </Link>
        )
      })}
    </Box>
  )
}
