'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Utils/LanguageProvider'
import { supabase } from '@/lib/supabase/client'

// SVG 图标组件
function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function GroupsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function HotIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  )
}

function UserIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  )
}

interface NavItem {
  href: string | (() => string)
  labelKey: string
  icon: (props: { active: boolean }) => React.ReactNode
}

// 静态导航项
const STATIC_NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    labelKey: 'home',
    icon: HomeIcon,
  },
  {
    href: '/groups',
    labelKey: 'groups',
    icon: GroupsIcon,
  },
  {
    href: '/hot',
    labelKey: 'hot',
    icon: HotIcon,
  },
]

export default function MobileBottomNav() {
  const pathname = usePathname()
  const { t } = useLanguage()
  const [userHandle, setUserHandle] = useState<string | null>(null)

  // 获取当前用户的handle
  useEffect(() => {
    let alive = true
    supabase.auth.getUser().then(({ data }) => {
      if (!alive) return
      const userId = data.user?.id
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
            } else if (data.user?.email) {
              setUserHandle(data.user.email.split('@')[0])
            }
          })
      }
    })
    return () => { alive = false }
  }, [])

  // 动态生成导航项（包含个人主页）
  const navItems: NavItem[] = [
    ...STATIC_NAV_ITEMS,
    {
      href: userHandle ? `/u/${encodeURIComponent(userHandle)}` : '/settings',
      labelKey: 'me',
      icon: UserIcon,
    },
  ]

  const isActive = (href: string) => {
    if (href === '/') {
      return pathname === '/'
    }
    // 个人主页特殊处理
    if (href.startsWith('/u/') || href === '/settings') {
      return pathname.startsWith('/u/') || pathname === '/settings'
    }
    return pathname.startsWith(href)
  }

  return (
    <>
      {/* 占位元素，防止内容被底部导航遮挡 - 只在移动端显示 */}
      <div className="mobile-bottom-nav-spacer has-mobile-nav" style={{ height: 0 }} />
      
      {/* 底部导航栏 - 只在移动端显示 */}
      <nav
        className="mobile-bottom-nav safe-area-inset-bottom"
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
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: 50,
          paddingBottom: 'env(safe-area-inset-bottom, 0)',
        }}
      >
        {navItems.map((item) => {
          const href = typeof item.href === 'function' ? item.href() : item.href
          const active = isActive(href)
          return (
            <Link
              key={href}
              href={href}
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
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: `opacity ${tokens.transition.fast}`,
                  opacity: active ? 1 : 0.7,
                }}
              >
                <item.icon active={active} />
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
