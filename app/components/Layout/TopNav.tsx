'use client'

import Link from 'next/link'
import { useEffect, useState, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import ThemeToggle from '../UI/ThemeToggle'
import LanguageSwitcher from '../Utils/LanguageSwitcher'
import SearchDropdown from '../Features/SearchDropdown'
import { useLanguage } from '../Utils/LanguageProvider'
import { SearchIcon, UserIcon, DashboardIcon, NotificationIcon, MessageIcon } from '../Icons'
import { Box } from '../Base'

export default function TopNav({ email }: { email: string | null }) {
  const { t } = useLanguage()
  const pathname = usePathname()
  const [myId, setMyId] = useState<string | null>(null)
  const [myHandle, setMyHandle] = useState<string | null>(null)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const [unreadCount, setUnreadCount] = useState(0)
  const [unreadMessageCount, setUnreadMessageCount] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  // 检测主题变化
  useEffect(() => {
    const updateTheme = () => {
      if (typeof document !== 'undefined') {
        const currentTheme = document.documentElement.getAttribute('data-theme') as 'light' | 'dark'
        setTheme(currentTheme === 'light' ? 'light' : 'dark')
      }
    }
    
    updateTheme()
    const observer = new MutationObserver(updateTheme)
    if (typeof document !== 'undefined') {
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
    }
    
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    supabase.auth.getUser().then(({ data }) => {
      if (!alive) return
      const userId = data.user?.id ?? null
      setMyId(userId)
      
      // 获取用户的handle和头像
      if (userId) {
        // 直接使用 user_profiles 表（profiles 表不存在）
        supabase
          .from('user_profiles')
          .select('handle, avatar_url')
          .eq('id', userId)
          .maybeSingle()
          .then(({ data: userProfile }) => {
            if (!alive) return
            if (userProfile) {
              if (userProfile.handle) {
                setMyHandle(userProfile.handle)
              } else if (data.user?.email) {
                // 如果没有 handle，使用邮箱前缀
                const defaultHandle = data.user.email.split('@')[0]
                setMyHandle(defaultHandle)
              }
              // 设置头像
              if (userProfile.avatar_url) {
                setMyAvatarUrl(userProfile.avatar_url)
              }
            } else {
              // 如果没有 profile，使用邮箱前缀作为 handle
              if (data.user?.email) {
                const defaultHandle = data.user.email.split('@')[0]
                setMyHandle(defaultHandle)
              }
            }
          })
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // 获取未读通知数量并订阅实时更新
  useEffect(() => {
    if (!myId) return

    // 初始获取未读数量
    const fetchUnreadCount = async () => {
      try {
        const { count, error } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', myId)
          .eq('read', false)
        
        if (!error && typeof count === 'number') {
          setUnreadCount(count)
        }
      } catch (err) {
        console.error('Error fetching unread count:', err)
      }
    }

    fetchUnreadCount()

    // 订阅实时通知更新
    const channel = supabase
      .channel(`notifications:${myId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${myId}`,
        },
        (payload) => {
          // 收到新通知或通知状态更新时，重新获取未读数量
          fetchUnreadCount()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [myId])

  // 获取未读私信数量
  useEffect(() => {
    if (!myId) return

    const fetchUnreadMessageCount = async () => {
      try {
        const { count, error } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', myId)
          .eq('read', false)
        
        if (!error && typeof count === 'number') {
          setUnreadMessageCount(count)
        }
      } catch (err) {
        // 如果表不存在，静默处理
        if (!String(err).includes('Could not find')) {
          console.error('Error fetching unread message count:', err)
        }
      }
    }

    fetchUnreadMessageCount()

    // 订阅实时私信更新
    const channel = supabase
      .channel(`messages:${myId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'direct_messages',
          filter: `receiver_id=eq.${myId}`,
        },
        () => {
          fetchUnreadMessageCount()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [myId])

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

  return (
    <Box
      as="header"
      className="top-nav glass"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: tokens.zIndex.sticky,
        background: tokens.glass.bg.primary,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        height: 64,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        boxShadow: `${tokens.shadow.sm}, 0 0 0 1px rgba(255, 255, 255, 0.05)`,
      }}
    >
      <Box
        className="top-nav-container"
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
          <Link 
            href="/" 
            className="top-nav-logo"
            aria-label="返回首页"
            tabIndex={0}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: tokens.spacing[2],
              textDecoration: 'none',
              transition: `all ${tokens.transition.base}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)'
              e.currentTarget.style.opacity = '0.85'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.opacity = '1'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                window.location.href = '/'
              }
            }}
          >
            {/* Logo - 莫比乌斯环 + arena */}
            <Box
              data-logo-box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {/* 无限符号 ∞ - 两个水滴尖端相连 */}
              <svg
                width="28"
                height="14"
                viewBox="0 0 56 28"
                fill="none"
                style={{ flexShrink: 0 }}
              >
                <defs>
                  <linearGradient id="infGrad" x1="0%" y1="50%" x2="100%" y2="50%">
                    <stop offset="0%" stopColor="#A78BFA" />
                    <stop offset="50%" stopColor="#8B5CF6" />
                    <stop offset="100%" stopColor="#7C3AED" />
                  </linearGradient>
                </defs>
                {/* 完整的 ∞：两个水滴，尖端在中心交叉 */}
                <path
                  d="M28 14 C22 6, 12 4, 8 8 C4 12, 4 16, 8 20 C12 24, 22 22, 28 14 C34 6, 44 4, 48 8 C52 12, 52 16, 48 20 C44 24, 34 22, 28 14"
                  stroke="url(#infGrad)"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              {/* 文字：arena - 首字母变色 */}
              <Box
                style={{
                  fontSize: '22px',
                  fontWeight: 700,
                  color: tokens.colors.text.primary,
                  letterSpacing: '-0.3px',
                  fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
                }}
              >
                <span style={{ color: '#8B5CF6', fontWeight: 800 }}>a</span>rena
              </Box>
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
                  aria-label={label}
                  aria-current={isActive ? 'page' : undefined}
                  tabIndex={0}
                  role="menuitem"
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    textDecoration: 'none',
                    fontWeight: isActive ? tokens.typography.fontWeight.black : tokens.typography.fontWeight.semibold,
                    fontSize: tokens.typography.fontSize.sm,
                    background: isActive ? tokens.colors.bg.secondary : 'transparent',
                    transition: `all ${tokens.transition.base}`,
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = tokens.colors.text.primary
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                      e.currentTarget.style.transform = 'translateY(-1px)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.color = tokens.colors.text.secondary
                      e.currentTarget.style.background = 'transparent'
                      e.currentTarget.style.transform = 'translateY(0)'
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      window.location.href = item.href
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
          className="top-nav-search"
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
              aria-label="搜索交易员"
              role="searchbox"
              tabIndex={0}
              style={{
                width: '100%',
                height: 40,
                borderRadius: tokens.radius.full,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.glass.bg.light,
                backdropFilter: tokens.glass.blur.sm,
                WebkitBackdropFilter: tokens.glass.blur.sm,
                color: tokens.colors.text.primary,
                padding: `0 ${tokens.spacing[4]} 0 40px`,
                outline: 'none',
                fontWeight: tokens.typography.fontWeight.bold,
                fontSize: tokens.typography.fontSize.sm,
                transition: tokens.transition.all,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
              onFocus={(e) => {
                setShowSearchDropdown(true)
                e.currentTarget.style.borderColor = tokens.colors.accent.primary
                e.currentTarget.style.background = tokens.glass.bg.medium
                e.currentTarget.style.boxShadow = `0 0 0 3px ${tokens.colors.accent.primary}20`
                e.currentTarget.style.transform = 'scale(1.02)'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSearch(e)
                } else if (e.key === 'Escape') {
                  setShowSearchDropdown(false)
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.background = tokens.glass.bg.light
                e.currentTarget.style.boxShadow = 'none'
                e.currentTarget.style.transform = 'scale(1)'
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
          className="top-nav-actions"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            position: 'relative',
          }}
        >
          {/* 移动端搜索按钮 */}
          <Link
            href="/search"
            className="mobile-search-button"
            aria-label="搜索"
            style={{
              display: 'none',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: tokens.radius.full,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              transition: `all ${tokens.transition.base}`,
              textDecoration: 'none',
            }}
          >
            <SearchIcon size={20} />
          </Link>
          <LanguageSwitcher />
          <ThemeToggle />
          {myId ? (
            <>
              {/* 通知铃铛图标（包含私信和系统通知） */}
              <Link
                href="/notifications"
                prefetch={true}
                aria-label="通知"
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: tokens.radius.full,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  transition: `all ${tokens.transition.base}`,
                  textDecoration: 'none',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                  e.currentTarget.style.color = tokens.colors.text.primary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }}
              >
                <NotificationIcon size={20} />
                {(unreadCount + unreadMessageCount) > 0 && (
                  <Box
                    className="highlight-pulse"
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      minWidth: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: tokens.gradient.error,
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 900,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 4px',
                      border: `2px solid ${tokens.colors.bg.primary}`,
                      boxShadow: tokens.shadow.glowError,
                    }}
                  >
                    {(unreadCount + unreadMessageCount) > 99 ? '99+' : (unreadCount + unreadMessageCount)}
                  </Box>
                )}
              </Link>
              <Box
                as="button"
                onClick={() => setShowUserMenu(!showUserMenu)}
                aria-label="用户菜单"
                aria-expanded={showUserMenu}
                aria-haspopup="true"
                role="button"
                tabIndex={0}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[2],
                  cursor: 'pointer',
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.md,
                  transition: `all ${tokens.transition.base}`,
                  background: showUserMenu ? tokens.colors.bg.secondary : 'transparent',
                  border: 'none',
                  fontFamily: 'inherit',
                  color: 'inherit',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setShowUserMenu(!showUserMenu)
                  } else if (e.key === 'Escape' && showUserMenu) {
                    e.preventDefault()
                    setShowUserMenu(false)
                  }
                }}
              >
                {myAvatarUrl ? (
                  <img
                    src={myAvatarUrl}
                    alt="头像"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: tokens.radius.full,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      objectFit: 'cover',
                    }}
                  />
                ) : (
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
                    {(myHandle?.[0] ?? email?.[0] ?? 'U').toUpperCase()}
                  </Box>
                )}
              </Box>

              {showUserMenu && (
                <Box
                  role="menu"
                  aria-label="用户菜单选项"
                  className="dropdown-enter glass-card"
                  style={{
                    position: 'absolute',
                    top: `calc(100% + ${tokens.spacing[2]})`,
                    right: 0,
                    background: tokens.glass.bg.secondary,
                    backdropFilter: tokens.glass.blur.xl,
                    WebkitBackdropFilter: tokens.glass.blur.xl,
                    border: tokens.glass.border.light,
                    borderRadius: tokens.radius.xl,
                    padding: tokens.spacing[2],
                    minWidth: 220,
                    boxShadow: `${tokens.shadow.xl}, 0 0 40px rgba(0, 0, 0, 0.2)`,
                    zIndex: tokens.zIndex.dropdown,
                  }}
                >
                  <Link
                    href={myHandle ? `/u/${encodeURIComponent(myHandle)}` : '/'}
                    onClick={(e) => {
                      if (!myHandle) {
                        e.preventDefault()
                        // 如果没有 handle，跳转到设置页面
                        window.location.href = '/settings'
                      } else {
                        setShowUserMenu(false)
                      }
                    }}
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
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
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
                    href="/messages"
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
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <Box style={{ position: 'relative' }}>
                      <MessageIcon size={16} />
                      {unreadMessageCount > 0 && (
                        <Box
                          style={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            minWidth: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: '#8b6fa8',
                            color: '#fff',
                            fontSize: 10,
                            fontWeight: 900,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '0 4px',
                          }}
                        >
                          {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                        </Box>
                      )}
                    </Box>
                    <span>私信</span>
                  </Link>
                  <Link
                    href="/notifications"
                    prefetch={true}
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
                      position: 'relative',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <Box style={{ position: 'relative' }}>
                      <NotificationIcon size={16} />
                      {unreadCount > 0 && (
                        <Box
                          style={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            minWidth: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: '#ff4d4d',
                            color: '#fff',
                            fontSize: 10,
                            fontWeight: 900,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '0 4px',
                          }}
                        >
                          {unreadCount > 99 ? '99+' : unreadCount}
                        </Box>
                      )}
                    </Box>
                    <span>{t('notifications')}</span>
                  </Link>
                  <Box
                    style={{
                      height: 1,
                      background: tokens.colors.border.primary,
                      margin: `${tokens.spacing[2]} 0`,
                    }}
                  />
                  {/* 告警管理 */}
                  <Link
                    href="/dashboard#alerts"
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
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                    <span>{t('alertManagement')}</span>
                  </Link>
                  {/* 跟单日记 */}
                  <Link
                    href="/dashboard#journals"
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
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                      <polyline points="10 9 9 9 8 9" />
                    </svg>
                    <span>{t('followJournal')}</span>
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
              aria-label={t('login')}
              tabIndex={0}
              role="button"
              className="btn-press"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                color: '#ffffff',
                textDecoration: 'none',
                fontWeight: tokens.typography.fontWeight.black,
                fontSize: tokens.typography.fontSize.sm,
                transition: tokens.transition.all,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 80,
                height: 38,
                border: 'none',
                boxShadow: `0 4px 12px ${tokens.colors.accent.primary}40`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = tokens.shadow.glow
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = `0 4px 12px ${tokens.colors.accent.primary}40`
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
