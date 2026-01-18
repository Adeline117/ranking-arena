'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Utils/LanguageProvider'

interface NavItem {
  href: string
  labelKey: string
  icon: string
  activeIcon: string
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    labelKey: 'home',
    icon: '🏠',
    activeIcon: '🏠',
  },
  {
    href: '/hot',
    labelKey: 'hot',
    icon: '🔥',
    activeIcon: '🔥',
  },
  {
    href: '/groups',
    labelKey: 'groups',
    icon: '💬',
    activeIcon: '💬',
  },
  {
    href: '/favorites',
    labelKey: 'favorites',
    icon: '⭐',
    activeIcon: '⭐',
  },
  {
    href: '/settings',
    labelKey: 'settings',
    icon: '⚙️',
    activeIcon: '⚙️',
  },
]

export default function MobileBottomNav() {
  const pathname = usePathname()
  const { t } = useLanguage()

  const isActive = (href: string) => {
    if (href === '/') {
      return pathname === '/'
    }
    return pathname.startsWith(href)
  }

  return (
    <>
      {/* 占位元素，防止内容被底部导航遮挡 */}
      <div className="show-mobile has-mobile-nav" style={{ height: 0 }} />
      
      {/* 底部导航栏 */}
      <nav
        className="show-mobile safe-area-inset-bottom"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 56,
          background: tokens.glass.bg.primary,
          backdropFilter: tokens.glass.blur.lg,
          WebkitBackdropFilter: tokens.glass.blur.lg,
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: 50,
          paddingBottom: 'env(safe-area-inset-bottom, 0)',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className="touch-target"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                textDecoration: 'none',
                color: active ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                transition: `color ${tokens.transition.fast}`,
                borderRadius: tokens.radius.md,
              }}
            >
              <span
                style={{
                  fontSize: 20,
                  lineHeight: 1,
                  filter: active ? 'none' : 'grayscale(0.5)',
                  transition: `filter ${tokens.transition.fast}`,
                }}
              >
                {active ? item.activeIcon : item.icon}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: active ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                  letterSpacing: '0.3px',
                }}
              >
                {t(item.labelKey)}
              </span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}
