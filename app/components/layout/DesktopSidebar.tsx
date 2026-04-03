'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function TrophyIcon({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  )
}

function GroupIcon({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function MarketIcon({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

function UserIcon({ active }: { active: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  )
}

export default function DesktopSidebar() {
  const pathname = usePathname()
  const { t } = useLanguage()
  const [userHandle, setUserHandle] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // Use getSession() — reads from local storage, no network request
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      const userId = data.session?.user?.id
      if (userId) {
        supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', userId)
          .maybeSingle()
          .then(({ data: profile }) => {
            if (!alive) return
            if (profile?.handle) {
              setUserHandle(profile.handle)
            } else if (data.session?.user?.email) {
              setUserHandle(data.session.user.email.split('@')[0])
            }
          })
      }
    })
    return () => { alive = false }
  }, [])

  const navItems = [
    { href: '/', labelKey: 'home' as const, icon: HomeIcon },
    { href: '/rankings', labelKey: 'rankings' as const, icon: TrophyIcon },
    { href: '/market', labelKey: 'market' as const, icon: MarketIcon },
    { href: '/groups', labelKey: 'groups' as const, icon: GroupIcon },
    { href: userHandle ? `/u/${encodeURIComponent(userHandle)}` : '/settings', labelKey: 'me' as const, icon: UserIcon },
  ]

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    if (href.startsWith('/u/') || href === '/settings') {
      return pathname.startsWith('/u/') || pathname === '/settings'
    }
    return pathname.startsWith(href)
  }

  return (
    <aside
      className="desktop-sidebar"
      role="navigation"
      aria-label="Main navigation"
      style={{
        position: 'fixed',
        top: 56,
        left: 0,
        width: 240,
        height: 'calc(100vh - 56px)',
        borderRight: `1px solid var(--color-border-primary)`,
        background: 'var(--color-bg-primary)',
        padding: `${tokens.spacing[4]} ${tokens.spacing[3]}`,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacing[2],
        zIndex: 30,
        overflowY: 'auto',
        scrollbarWidth: 'thin',
        transition: `all ${tokens.transition.base}`,
      }}
    >
      <nav style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
        {navItems.map((item) => {
          const href = item.href
          const active = isActive(href)
          return (
            <Link
              key={item.labelKey}
              href={href}
              prefetch={false}
              aria-current={active ? 'page' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                textDecoration: 'none',
                color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                background: active ? 'var(--color-bg-secondary)' : 'transparent',
                fontWeight: active ? 800 : 600,
                fontSize: tokens.typography.fontSize.base,
                transition: `all ${tokens.transition.base}`,
                position: 'relative',
                minHeight: 44,
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'var(--color-bg-secondary)'
                  e.currentTarget.style.color = 'var(--color-text-primary)'
                  e.currentTarget.style.transform = 'translateX(4px)'
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--color-text-secondary)'
                  e.currentTarget.style.transform = 'translateX(0px)'
                }
              }}
              onFocus={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'var(--color-bg-secondary)'
                  e.currentTarget.style.color = 'var(--color-text-primary)'
                  e.currentTarget.style.transform = 'translateX(4px)'
                }
                e.currentTarget.style.outline = '2px solid var(--color-accent-primary)'
                e.currentTarget.style.outlineOffset = '2px'
                e.currentTarget.style.borderRadius = '4px'
              }}
              onBlur={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'var(--color-text-secondary)'
                  e.currentTarget.style.transform = 'translateX(0px)'
                }
                e.currentTarget.style.outline = 'none'
              }}
            >
              {active && (
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 3,
                    height: 24,
                    background: 'var(--color-accent-primary)',
                    borderRadius: '0 2px 2px 0',
                  }}
                  aria-hidden="true"
                />
              )}
              <item.icon active={active} />
              <span>{t(item.labelKey)}</span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
