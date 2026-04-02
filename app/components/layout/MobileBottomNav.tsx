'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { features } from '@/lib/features'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { useCapacitorHaptics } from '@/lib/hooks/useCapacitor'
import { useInboxStore } from '@/lib/stores/inboxStore'

interface IconProps {
  active: boolean
}

const ICON_SIZE = 24
const ICON_PROPS = { width: ICON_SIZE, height: ICON_SIZE, viewBox: '0 0 24 24', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }

function NavIcon({ active, children }: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg {...ICON_PROPS} fill={active ? 'currentColor' : 'none'} stroke="currentColor">
      {children}
    </svg>
  )
}

function _HomeIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </NavIcon>
  )
}

function GroupsIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </NavIcon>
  )
}

function UserIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </NavIcon>
  )
}

function _NewsIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
      <path d="M18 14h-8" />
      <path d="M15 18h-5" />
      <path d="M10 6h8v4h-8z" />
    </NavIcon>
  )
}

function FireIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <path d="M12 12c2-2.96 0-7-1-8 0 3.038-1.773 4.741-3 6-1.226 1.26-2 3.24-2 5a6 6 0 1 0 12 0c0-1.532-1.056-3.94-2-5-1.786 3-2.791 3-4 2z" />
    </NavIcon>
  )
}

function RankingsIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </NavIcon>
  )
}

function MarketIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </NavIcon>
  )
}

function _SearchIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </NavIcon>
  )
}

function _LibraryIcon({ active }: IconProps): React.ReactElement {
  return (
    <NavIcon active={active}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </NavIcon>
  )
}

interface NotificationBadgeProps {
  count: number
  ariaLabel: string
}

function NotificationBadge({ count, ariaLabel }: NotificationBadgeProps): React.ReactElement | null {
  if (count <= 0) return null

  return (
    <span
      style={{
        position: 'absolute',
        top: -4,
        right: -4,
        minWidth: 16,
        height: 16,
        padding: '0 4px',
        borderRadius: tokens.radius.md,
        background: 'var(--color-accent-error)',
        color: tokens.colors.white,
        fontSize: 12,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 2px 4px var(--color-overlay-medium)',
      }}
      aria-label={ariaLabel}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

interface NavItem {
  href: string
  labelKey: string
  Icon: (props: IconProps) => React.ReactElement
  badge?: number
  highlight?: boolean
}

// Cache key for persisting user handle across navigations
const USER_HANDLE_CACHE_KEY = 'arena:user_handle'

function useUserHandle(): string | null {
  const [userHandle, setUserHandle] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try { return sessionStorage.getItem(USER_HANDLE_CACHE_KEY) } catch { return null }
  })

  useEffect(() => {
    let alive = true

    // Use getSession() — reads from local storage, no network request
    supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!alive || error) return

        const userId = data.session?.user?.id
        if (!userId) return
        const emailHandle = data.session?.user?.email?.split('@')[0] || null

        // If we already have a cached handle, skip the DB query
        if (userHandle) return

        supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', userId)
          .maybeSingle()
          .then(({ data: profile, error: profileError }) => {
            if (!alive) return
            const resolved = profileError ? emailHandle : (profile?.handle || emailHandle)
            setUserHandle(resolved)
            // Persist to sessionStorage to avoid re-querying on every navigation
            if (resolved) {
              try { sessionStorage.setItem(USER_HANDLE_CACHE_KEY, resolved) } catch { /* ignore */ }
            }
          })
      })

    return () => { alive = false }
  }, [userHandle])

  return userHandle
}

function useScrollVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(true)
  const lastScrollYRef = useRef(0)
  const hideTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    function handleScroll(): void {
      const currentScrollY = window.scrollY
      const scrollDelta = currentScrollY - lastScrollYRef.current

      // Clear existing timeout
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
        hideTimeoutRef.current = undefined
      }

      // Show immediately on scroll up
      if (scrollDelta < -10) {
        setIsVisible(true)
      } 
      // Hide after scrolling down with debounce
      else if (scrollDelta > 50 && currentScrollY > 100) {
        hideTimeoutRef.current = setTimeout(() => {
          setIsVisible(false)
        }, 150)
      }

      lastScrollYRef.current = currentScrollY
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', handleScroll)
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
        hideTimeoutRef.current = undefined
      }
    }
  }, [])

  return isVisible
}

function isActivePath(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/' || pathname.startsWith('/rankings')
  if (href.startsWith('/u/') || href === '/settings') {
    return pathname.startsWith('/u/') || pathname === '/settings'
  }
  return pathname.startsWith(href)
}

/** Pages where the bottom nav should be completely hidden */
const HIDDEN_PATHS = ['/login', '/onboarding', '/reset-password', '/auth/callback']

export default function MobileBottomNav(): React.ReactElement {
  const pathname = usePathname()
  const { t } = useLanguage()
  const { impact } = useCapacitorHaptics()
  const userHandle = useUserHandle()
  const isVisible = useScrollVisibility()
  const unreadCount = useInboxStore(s => s.unreadNotifications + s.unreadMessages)

  const handleNavClick = useCallback(() => {
    impact('light')
  }, [impact])

  const navItems: NavItem[] = useMemo(() => {
    const items: NavItem[] = [
      { href: '/', labelKey: 'rankings', Icon: RankingsIcon },
    ]
    if (features.social) {
      items.push({ href: '/hot', labelKey: 'hot', Icon: FireIcon, badge: unreadCount > 0 ? unreadCount : undefined })
      items.push({ href: '/groups', labelKey: 'groups', Icon: GroupsIcon })
    }
    items.push({ href: '/market', labelKey: 'market', Icon: MarketIcon })
    items.push({ href: userHandle ? `/u/${encodeURIComponent(userHandle)}` : '/settings', labelKey: 'me', Icon: UserIcon })
    return items
  }, [userHandle, unreadCount])

  // Compute active index for sliding indicator
  const activeIndex = useMemo(() => {
    return navItems.findIndex(item => isActivePath(item.href, pathname))
  }, [navItems, pathname])

  // Hide nav on auth / onboarding pages
  if (HIDDEN_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
    return <></>
  }

  const itemCount = navItems.length

  return (
    <>
      <div className="mobile-bottom-nav-spacer" style={{ height: 'var(--mobile-nav-height, 60px)' }} aria-hidden="true" />

      <nav
        aria-label={t('mainNavigation')}
        className="mobile-bottom-nav safe-area-inset-bottom"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          height: 60,
          background: tokens.glass.bg.primary,
          backdropFilter: tokens.glass.blur.lg,
          WebkitBackdropFilter: tokens.glass.blur.lg,
          borderTop: `1px solid var(--color-border-primary)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: tokens.zIndex.sticky,
          paddingBottom: 'env(safe-area-inset-bottom, 0)',
          transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.3s ease',
        }}
      >
        {/* Sliding active indicator pill */}
        {activeIndex >= 0 && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: 0,
              left: `${(activeIndex / itemCount) * 100}%`,
              width: `${100 / itemCount}%`,
              display: 'flex',
              justifyContent: 'center',
              transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              pointerEvents: 'none',
            }}
          >
            <span
              style={{
                width: 28,
                height: 3,
                borderRadius: '0 0 4px 4px',
                background: tokens.gradient.primary,
                boxShadow: `0 2px 8px var(--color-accent-primary-60)`,
              }}
            />
          </span>
        )}
        {navItems.map((item) => (
          <NavItemLink
            key={item.href}
            item={item}
            active={isActivePath(item.href, pathname)}
            onClick={handleNavClick}
            t={t}
          />
        ))}
      </nav>
    </>
  )
}

interface NavItemLinkProps {
  item: NavItem
  active: boolean
  onClick: () => void
  t: (key: string) => string
}

function NavItemLink({ item, active, onClick, t }: NavItemLinkProps): React.ReactElement {
  const hasBadge = item.badge && item.badge > 0

  return (
    <Link
      href={item.href}
      className="touch-target mobile-nav-item"
      aria-label={t(item.labelKey)}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 4,
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        textDecoration: 'none',
        color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)',
        transition: `color ${tokens.transition.base}, background-color ${tokens.transition.base}`,
        borderRadius: tokens.radius.lg,
        position: 'relative',
        minWidth: 60,
        minHeight: tokens.touchTarget.comfortable,
        background: active ? 'var(--color-accent-primary-12)' : 'transparent',
      }}
      // focus-visible handled by global CSS rule in globals.css
    >
      <span
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: `opacity ${tokens.transition.fast}, transform ${tokens.transition.fast}`,
          opacity: active ? 1 : 0.85,
          transform: active ? 'scale(1.1)' : 'scale(1)',
        }}
      >
        <item.Icon active={active} />
        {hasBadge && (
          <NotificationBadge
            count={item.badge!}
            ariaLabel={t('unreadNotificationsCount').replace('{count}', String(item.badge))}
          />
        )}
        {item.highlight && !active && <HighlightDot />}
      </span>

      <span
        style={{
          fontSize: 12,
          fontWeight: active ? 800 : 600,
          letterSpacing: '0.3px',
          transition: `color ${tokens.transition.fast}`,
        }}
      >
        {t(item.labelKey)}
      </span>
    </Link>
  )
}

function _ActiveIndicator(): React.ReactElement {
  return (
    <span
      style={{
        position: 'absolute',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 28,
        height: 3,
        borderRadius: '0 0 4px 4px',
        background: tokens.gradient.primary,
        boxShadow: `0 2px 8px var(--color-accent-primary-60)`,
      }}
      aria-hidden="true"
    />
  )
}

function HighlightDot(): React.ReactElement {
  return (
    <span
      style={{
        position: 'absolute',
        top: -2,
        right: -2,
        width: 6,
        height: 6,
        borderRadius: 3,
        background: 'var(--color-accent-error)',
      }}
      aria-hidden="true"
    />
  )
}
