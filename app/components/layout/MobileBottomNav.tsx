'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../utils/LanguageProvider'
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

function SearchIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? '2.5' : '2'} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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

function HotIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  )
}

function BellIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
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
  const [unreadCount, setUnreadCount] = useState(0)
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

        // 获取未读通知数
        supabase
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('is_read', false)
          .then(({ count }) => {
            if (!alive) return
            setUnreadCount(count || 0)
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

  // 动态生成导航项（包含搜索、通知和个人主页）
  const navItems: NavItem[] = [
    {
      href: '/',
      labelKey: 'home',
      icon: HomeIcon,
    },
    {
      href: '/search',
      labelKey: 'search',
      icon: SearchIcon,
    },
    {
      href: '/hot',
      labelKey: 'hot',
      icon: HotIcon,
      highlight: true,
    },
    {
      href: '/notifications',
      labelKey: 'notifications',
      icon: BellIcon,
      badge: unreadCount,
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
                gap: 3,
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
                  fontSize: 10,
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
