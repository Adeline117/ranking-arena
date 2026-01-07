'use client'

import Link from 'next/link'
import { useEffect, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import ThemeToggle from '../Utils/ThemeToggle'
import LanguageSwitcher from '../Utils/LanguageSwitcher'
import SearchDropdown from '../Features/SearchDropdown'
import { useLanguage } from '../Utils/LanguageProvider'
import { SearchIcon, UserIcon, DashboardIcon, NotificationIcon, SettingsIcon } from '../Icons'
import { Box, Text } from '../Base'

export default function TopNav({ email }: { email: string | null }) {
  const { t } = useLanguage()
  const pathname = usePathname()
  const [myId, setMyId] = useState<string | null>(null)
  const [myHandle, setMyHandle] = useState<string | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    supabase.auth.getUser().then(({ data }) => {
      if (!alive) return
      const userId = data.user?.id ?? null
      setMyId(userId)
      
      // 获取用户的handle
      if (userId) {
        supabase
          .from('profiles')
          .select('handle')
          .eq('id', userId)
          .maybeSingle()
          .then(({ data: profile }) => {
            if (!alive) return
            if (profile) {
              setMyHandle(profile.handle)
            }
          })
      }
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearchDropdown(false)
      }
    }

    if (showUserMenu || showSearchDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserMenu, showSearchDropdown])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmedQuery = searchQuery.trim()
    if (trimmedQuery) {
      // 保存搜索历史
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem('searchHistory')
        const history: Array<{ id: string; query: string; timestamp: number }> = stored ? JSON.parse(stored) : []
        const newItem = {
          id: Date.now().toString(),
          query: trimmedQuery,
          timestamp: Date.now(),
        }
        // 移除重复项，添加新项到最前面
        const filtered = history.filter((item) => item.query !== trimmedQuery)
        const updated = [newItem, ...filtered].slice(0, 10) // 最多保留10条
        localStorage.setItem('searchHistory', JSON.stringify(updated))
      }
      window.location.href = `/search?q=${encodeURIComponent(trimmedQuery)}`
    }
  }

  const navLinkStyle: React.CSSProperties = {
    color: tokens.colors.text.secondary,
    textDecoration: 'none',
    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.md,
    transition: `all ${tokens.transition.base}`,
    fontWeight: tokens.typography.fontWeight.bold,
    fontSize: tokens.typography.fontSize.sm,
  }

  return (
    <Box
      as="header"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: tokens.zIndex.sticky,
        background: tokens.colors.bg.primary,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        height: 56, // Fixed height for trader-focused UI
      }}
    >
      <Box
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          paddingLeft: tokens.spacing[4],
          paddingRight: tokens.spacing[4],
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[4],
        }}
      >
        {/* 左：Logo + Nav */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
            <Box
              style={{
                width: 32,
                height: 32,
                borderRadius: tokens.radius.md,
                background: tokens.colors.text.primary,
                display: 'grid',
                placeItems: 'center',
                fontWeight: tokens.typography.fontWeight.black,
                color: tokens.colors.bg.primary,
                fontSize: tokens.typography.fontSize.base,
              }}
            >
              A
            </Box>
          </Link>
          
          {/* 导航链接 */}
          <Box as="nav" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
            {[
              { href: '/', labelKey: 'home' as const },
              { href: '/groups', labelKey: 'groups' as const },
              { href: '/hot', labelKey: 'hot' as const },
            ].map((item) => {
              const label = t(item.labelKey)
              const isActive = pathname === item.href || (item.href === '/' && pathname === '/')
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    textDecoration: 'none',
                    fontWeight: isActive ? tokens.typography.fontWeight.black : tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                    background: isActive ? tokens.colors.bg.secondary : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = tokens.colors.text.primary
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = tokens.colors.text.secondary
                    }
                  }}
                >
                  {label}
                </Link>
              )
            })}
          </Box>
        </Box>

        {/* 中：搜索 */}
        <div
          ref={searchRef}
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            maxWidth: 520,
            position: 'relative',
          }}
        >
          <form onSubmit={handleSearch} style={{ width: '100%', position: 'relative' }}>
            <input
              type="text"
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                width: '100%',
                height: 40,
                borderRadius: tokens.radius.full,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                padding: `0 ${tokens.spacing[4]} 0 40px`,
                outline: 'none',
                fontWeight: tokens.typography.fontWeight.bold,
                fontSize: tokens.typography.fontSize.sm,
                transition: `all ${tokens.transition.base}`,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
              onFocus={(e) => {
                setShowSearchDropdown(true)
                e.currentTarget.style.borderColor = tokens.colors.border.focus
                e.currentTarget.style.background = tokens.colors.bg.tertiary
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.background = tokens.colors.bg.secondary
              }}
            />
            <Box
              style={{
                position: 'absolute',
                left: tokens.spacing[3],
                top: '50%',
                transform: 'translateY(-50%)',
                color: tokens.colors.text.tertiary,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <SearchIcon size={16} />
            </Box>
          </form>
          <SearchDropdown open={showSearchDropdown} query={searchQuery} onClose={() => setShowSearchDropdown(false)} />
        </div>

        {/* 右：语言切换 + 主题切换 + 用户 */}
        <div
          ref={menuRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            position: 'relative',
          }}
        >
          <LanguageSwitcher />
          <ThemeToggle />
          {myId ? (
            <>
              <Box
                onClick={() => setShowUserMenu(!showUserMenu)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  cursor: 'pointer',
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.md,
                  transition: `all ${tokens.transition.base}`,
                  background: showUserMenu ? tokens.colors.bg.secondary : 'transparent',
                }}
              >
                <Box
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: tokens.radius.full,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: tokens.typography.fontWeight.black,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  {(email?.[0] ?? 'U').toUpperCase()}
                </Box>
              </Box>

              {showUserMenu && (
                <Box
                  style={{
                    position: 'absolute',
                    top: `calc(100% + ${tokens.spacing[2]})`,
                    right: 0,
                    background: tokens.colors.bg.primary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: tokens.radius.lg,
                    padding: tokens.spacing[2],
                    minWidth: 200,
                    boxShadow: tokens.shadow.lg,
                    zIndex: tokens.zIndex.dropdown,
                  }}
                >
                  <Link
                    href={myHandle ? `/u/${myHandle}` : `/user/${myId}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.primary,
                      textDecoration: 'none',
                      fontSize: tokens.typography.fontSize.base,
                      fontWeight: tokens.typography.fontWeight.bold,
                      transition: `all ${tokens.transition.base}`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <UserIcon size={16} />
                    <span>{t('myHome')}</span>
                  </Link>
                  <Link
                    href="/dashboard"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.primary,
                      textDecoration: 'none',
                      fontSize: tokens.typography.fontSize.base,
                      fontWeight: tokens.typography.fontWeight.bold,
                      transition: `all ${tokens.transition.base}`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <DashboardIcon size={16} />
                    <span>{t('dashboard')}</span>
                  </Link>
                  <Link
                    href="/notifications"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.primary,
                      textDecoration: 'none',
                      fontSize: tokens.typography.fontSize.base,
                      fontWeight: tokens.typography.fontWeight.bold,
                      transition: `all ${tokens.transition.base}`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <NotificationIcon size={16} />
                    <span>{t('notifications')}</span>
                  </Link>
                  <Box
                    style={{
                      height: 1,
                      background: tokens.colors.border.primary,
                      margin: `${tokens.spacing[2]} 0`,
                    }}
                  />
                  <Link
                    href="/logout"
                    style={{
                      display: 'block',
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.secondary,
                      textDecoration: 'none',
                      fontSize: tokens.typography.fontSize.base,
                      fontWeight: tokens.typography.fontWeight.bold,
                      transition: `all ${tokens.transition.base}`,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                      e.currentTarget.style.color = tokens.colors.text.primary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.color = tokens.colors.text.secondary
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    {t('logout')}
                  </Link>
                </Box>
              )}
            </>
          ) : (
            <Link
              href="/login"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                background: tokens.colors.accent.primary,
                color: tokens.colors.black,
                textDecoration: 'none',
                fontWeight: tokens.typography.fontWeight.black,
                fontSize: tokens.typography.fontSize.sm,
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.text.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.accent.primary
              }}
            >
              {t('login')}
            </Link>
          )}
        </div>
      </Box>
    </Box>
  )
}
