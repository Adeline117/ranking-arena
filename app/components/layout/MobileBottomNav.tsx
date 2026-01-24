'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'

// ============================================
// SVG 图标组件
// ============================================

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function TrophyIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  )
}

function GroupsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function UserIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 1 0-16 0" />
    </svg>
  )
}

// ============================================
// 通知徽章组件
// ============================================

function NotificationBadge({ count }: { count: number }) {
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
        borderRadius: 8,
        background: tokens.colors.accent?.error || '#ff4d4d',
        color: '#fff',
        fontSize: 10,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
      }}
      aria-label={`${count} 条未读通知`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

interface NavItem {
  href: string | (() => string)
  labelKey: string
  icon: (props: { active: boolean }) => React.ReactNode
  badge?: number
  highlight?: boolean
}

// ============================================
// 主组件
// ============================================

export default function MobileBottomNav() {
  const pathname = usePathname()
  const { t } = useLanguage()
  const [userHandle, setUserHandle] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(true)
  const [lastScrollY, setLastScrollY] = useState(0)

  // 获取当前用户的 handle
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

  // 滚动隐藏/显示导航栏
  const handleScroll = useCallback(() => {
    const currentScrollY = window.scrollY
    const scrollDelta = currentScrollY - lastScrollY

    // 向下滚动超过 50px 时隐藏
    if (scrollDelta > 50 && currentScrollY > 100) {
      setIsVisible(false)
    }
    // 向上滚动时显示
    else if (scrollDelta < -10) {
      setIsVisible(true)
    }

    setLastScrollY(currentScrollY)
  }, [lastScrollY])

  useEffect(() => {
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 4-tab navigation: Home, Rankings, Groups, Profile
  const navItems: NavItem[] = [
    {
      href: '/',
      labelKey: 'home',
      icon: HomeIcon,
    },
    {
      href: '/rankings',
      labelKey: 'rankings',
      icon: TrophyIcon,
    },
    {
      href: '/groups',
      labelKey: 'groups',
      icon: GroupsIcon,
    },
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
      <div
        className="mobile-bottom-nav-spacer has-mobile-nav"
        style={{ height: 0 }}
        aria-hidden="true"
      />

      {/* 底部导航栏 - 只在移动端显示 */}
      <nav
        role="navigation"
        aria-label="主导航"
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
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          zIndex: 50,
          paddingBottom: 'env(safe-area-inset-bottom, 0)',
          transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.3s ease',
        }}
      >
        {navItems.map((item) => {
          const href = typeof item.href === 'function' ? item.href() : item.href
          const active = isActive(href)
          const hasBadge = item.badge && item.badge > 0

          return (
            <Link
              key={href}
              href={href}
              className="touch-target"
              aria-label={t(item.labelKey)}
              aria-current={active ? 'page' : undefined}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                textDecoration: 'none',
                color: active ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                transition: `all ${tokens.transition.fast}`,
                borderRadius: tokens.radius.md,
                position: 'relative',
                minWidth: 56,
                minHeight: 48,
              }}
            >
              {/* 活动指示器 */}
              {active && (
                <span
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 24,
                    height: 3,
                    borderRadius: '0 0 3px 3px',
                    background: tokens.colors.accent.primary,
                  }}
                  aria-hidden="true"
                />
              )}

              {/* 图标容器 */}
              <span
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: `all ${tokens.transition.fast}`,
                  opacity: active ? 1 : 0.7,
                  transform: active ? 'scale(1.1)' : 'scale(1)',
                }}
              >
                <item.icon active={active} />

                {/* 通知徽章 */}
                {hasBadge && <NotificationBadge count={item.badge!} />}

                {/* 热门高亮点 */}
                {item.highlight && !active && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -2,
                      right: -2,
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: tokens.colors.accent?.error || '#ff4d4d',
                    }}
                    aria-hidden="true"
                  />
                )}
              </span>

              {/* 标签 */}
              <span
                style={{
                  fontSize: 11,
                  fontWeight: active ? 700 : 500,
                  letterSpacing: '0.3px',
                  transition: `all ${tokens.transition.fast}`,
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
