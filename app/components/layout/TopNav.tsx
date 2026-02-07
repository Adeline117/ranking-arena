'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useState, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { tokens } from '@/lib/design-tokens'
import ThemeToggle from '../ui/ThemeToggle'
import LanguageSwitcher from '../ui/LanguageToggle'
const SearchDropdown = dynamic(() => import('../search/SearchDropdown'), { ssr: false })
import { useLanguage } from '../Providers/LanguageProvider'
import { SearchIcon, UserIcon, NotificationIcon } from '../ui/icons'
import { Box } from '../base'
import { useInboxStore } from '@/lib/stores/inboxStore'
import { usePostStore } from '@/lib/stores/postStore'

// Lazy load non-critical components
const MobileSearchOverlay = dynamic(() => import('../search/MobileSearchOverlay'), { ssr: false })
const AccountSwitcher = dynamic(() => import('../ui/AccountSwitcher'), { ssr: false })
const InboxPanel = dynamic(() => import('../inbox/InboxPanel'), { ssr: false })

function formatUnreadBadge(count: number): string {
  return count > 99 ? '99+' : String(count)
}

const MENU_LINK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.spacing[2],
  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
  borderRadius: tokens.radius.md,
  color: tokens.colors.text.primary,
  textDecoration: 'none',
  fontSize: tokens.typography.fontSize.base,
  fontWeight: tokens.typography.fontWeight.bold,
}

export default function TopNav({ email = null }: { email?: string | null }) {
  const { t } = useLanguage()
  const pathname = usePathname()
  const router = useRouter()
  const { userId: authUserId, isLoggedIn: authLoggedIn, authChecked } = useAuthSession()
  const [isReady, setIsReady] = useState(false)
  const [myId, setMyId] = useState<string | null>(null)
  const [myHandle, setMyHandle] = useState<string | null>(null)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [showMobileSearch, setShowMobileSearch] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [unreadMessageCount, setUnreadMessageCount] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  const totalUnread = unreadCount + unreadMessageCount

  // Sync auth state from global hook immediately (prevents login flicker on navigation)
  useEffect(() => {
    if (authChecked && authUserId && !myId) {
      setMyId(authUserId)
    }
  }, [authChecked, authUserId, myId])

  // Performance: Defer profile/notification fetching - not LCP-critical
  useEffect(() => {
    if ('requestIdleCallback' in window) {
      const idleId = (window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback(() => setIsReady(true), { timeout: 2000 })
      return () => {
        (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(idleId)
      }
    } else {
      const timer = setTimeout(() => setIsReady(true), 1000)
      return () => clearTimeout(timer)
    }
  }, [])

  // Performance: Fetch user auth and profile/notifications/messages in parallel (deferred)
  useEffect(() => {
    if (!isReady) return

    let alive = true

    const initAuth = async () => {
      try {
        const { data, error } = await supabase.auth.getUser()
        if (!alive || error || !data.user) return

        const userId = data.user.id
        setMyId(userId)

        // Parallel fetch: profile, notifications, messages (instead of sequential)
        const [profileResult, notificationsResult, messagesResult] = await Promise.all([
          // Fetch profile
          supabase
            .from('user_profiles')
            .select('handle, avatar_url')
            .eq('id', userId)
            .maybeSingle(),
          // Fetch unread notifications count
          supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('read', false),
          // Fetch unread messages count
          supabase
            .from('direct_messages')
            .select('*', { count: 'exact', head: true })
            .eq('receiver_id', userId)
            .eq('read', false),
        ])

        if (!alive) return

        // Process profile
        const userProfile = profileResult.data
        if (userProfile?.handle) {
          setMyHandle(userProfile.handle)
        } else if (data.user.email) {
          setMyHandle(data.user.email.split('@')[0])
        }
        if (userProfile?.avatar_url) {
          setMyAvatarUrl(userProfile.avatar_url)
        }

        // Process notification count
        if (!notificationsResult.error && typeof notificationsResult.count === 'number') {
          setUnreadCount(notificationsResult.count)
        }

        // Process message count
        if (!messagesResult.error && typeof messagesResult.count === 'number') {
          setUnreadMessageCount(messagesResult.count)
        }
      } catch (err) {
        if (!alive) return
        // Only log unexpected errors, not auth session failures (expected for non-logged-in users)
        if (err instanceof Error && err.message?.includes('Auth session')) return
        console.warn('[TopNav] Auth initialization error:', err)
      }
    }

    initAuth()

    return () => {
      alive = false
    }
  }, [isReady])

  // Real-time subscriptions deferred to after idle to avoid competing with LCP
  useEffect(() => {
    if (!myId) return

    let notifChannel: ReturnType<typeof supabase.channel> | null = null
    let msgChannel: ReturnType<typeof supabase.channel> | null = null

    const setupSubscriptions = () => {
      const fetchUnreadCount = async () => {
        const { count, error } = await supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', myId)
          .eq('read', false)
        if (!error && typeof count === 'number') {
          setUnreadCount(count)
        }
      }

      const fetchUnreadMessageCount = async () => {
        const { count, error } = await supabase
          .from('direct_messages')
          .select('*', { count: 'exact', head: true })
          .eq('receiver_id', myId)
          .eq('read', false)
        if (!error && typeof count === 'number') {
          setUnreadMessageCount(count)
        }
      }

      notifChannel = supabase
        .channel(`notifications:${myId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${myId}` },
          () => fetchUnreadCount()
        )
        .subscribe()

      msgChannel = supabase
        .channel(`messages:${myId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'direct_messages', filter: `receiver_id=eq.${myId}` },
          () => fetchUnreadMessageCount()
        )
        .subscribe()
    }

    const hasIdleCallback = typeof requestIdleCallback !== 'undefined'
    const idleId = hasIdleCallback ? requestIdleCallback(setupSubscriptions, { timeout: 3000 }) : undefined
    const fallbackTimer = hasIdleCallback ? undefined : setTimeout(setupSubscriptions, 2000)

    return () => {
      if (idleId !== undefined) cancelIdleCallback(idleId)
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer)
      if (notifChannel) supabase.removeChannel(notifChannel)
      if (msgChannel) supabase.removeChannel(msgChannel)
    }
  }, [myId])

  useEffect(() => {
    if (!showUserMenu && !showSearchDropdown) return

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSearchDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
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
        try {
          const stored = localStorage.getItem('arena_search_history')
          const history: string[] = stored ? JSON.parse(stored) : []
          const filtered = history.filter((item) => item !== trimmedQuery)
          const updated = [trimmedQuery, ...filtered].slice(0, 10)
          localStorage.setItem('arena_search_history', JSON.stringify(updated))
        } catch (error) {
          // If quota exceeded or localStorage unavailable, try to clear and save just current search
          try {
            localStorage.removeItem('arena_search_history')
            localStorage.setItem('arena_search_history', JSON.stringify([trimmedQuery]))
          } catch {
            // If still failing (e.g., private mode), silently fail
            console.warn('[TopNav] localStorage unavailable')
          }
        }
      }
      router.push(`/search?q=${encodeURIComponent(trimmedQuery)}`)
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
        height: 56,
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
          paddingLeft: tokens.spacing[3],
          paddingRight: tokens.spacing[3],
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[2],
        }}
      >
        {/* 左：Logo + Nav */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Link
            href="/"
            className="top-nav-logo top-nav-logo-link touch-target"
            aria-label={t('backToHome')}
            tabIndex={0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              textDecoration: 'none',
              padding: '4px',
              marginLeft: '-4px',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                router.push('/')
              }
            }}
          >
            {/* Logo - 莫比乌斯环 + arena */}
            <Box
              data-logo-box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              {/* 无限符号 ∞ - 两个水滴尖端相连 */}
              <svg
                width="24"
                height="12"
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
                  fontSize: '20px',
                  fontWeight: 700,
                  color: tokens.colors.text.primary,
                  letterSpacing: '-0.3px',
                  fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
                }}
              >
                <span style={{ color: tokens.colors.accent.brand, fontWeight: 800 }}>a</span>rena
              </Box>
            </Box>
          </Link>

          {/* 导航链接 - 移动端隐藏 */}
          <Box as="nav" className="hide-mobile" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
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
                  className={`top-nav-link${isActive ? ' top-nav-link-active' : ''}`}
                  onClick={() => {
                    // Trigger feed refresh when clicking groups link while already on groups page
                    if (item.href === '/groups' && isActive) {
                      usePostStore.getState().triggerFeedRefresh()
                    }
                  }}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
                    textDecoration: 'none',
                    fontWeight: isActive ? 800 : 600,
                    fontSize: tokens.typography.fontSize.sm,
                    background: isActive ? tokens.colors.bg.secondary : 'transparent',
                  }}
                >
                  {label}
                </Link>
              )
            })}
          </Box>
        </Box>

        {/* 中：搜索 - 移动端隐藏 */}
        <div
          ref={searchRef}
          className="top-nav-search hide-mobile"
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            maxWidth: 600,
            position: 'relative',
          }}
        >
          <form onSubmit={handleSearch} role="search" style={{ width: '100%', position: 'relative' }}>
            <input
              type="search"
              className="top-nav-search-input"
              placeholder={t('searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={t('searchTraders')}
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
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
              onFocus={() => {
                setShowSearchDropdown(true)
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
          {/* 移动端搜索按钮 - 显示在移动端 */}
          <button
            className="show-mobile-flex touch-target"
            aria-label={t('search')}
            onClick={() => setShowMobileSearch(true)}
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              borderRadius: tokens.radius.full,
              background: `${tokens.colors.accent.primary}12`,
              color: tokens.colors.text.secondary,
              transition: `all ${tokens.transition.base}`,
              border: `1px solid ${tokens.colors.accent.primary}30`,
              cursor: 'pointer',
            }}
          >
            <SearchIcon size={20} />
          </button>
          {/* 语言切换 - 移动端隐藏 */}
          <Box className="hide-mobile">
            <LanguageSwitcher />
          </Box>
          <ThemeToggle />
          {!isReady ? (
            /* Generic Login placeholder while auth is deferred - reduces TBT */
            <Link
              href="/login"
              aria-label={t('login')}
              tabIndex={0}
              className="btn-press touch-target top-nav-login-link"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                color: tokens.colors.white,
                textDecoration: 'none',
                fontWeight: tokens.typography.fontWeight.black,
                fontSize: tokens.typography.fontSize.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 72,
                height: 44,
                border: 'none',
                boxShadow: `0 4px 12px ${tokens.colors.accent.primary}40`,
              }}
            >
              {t('login')}
            </Link>
          ) : myId ? (
            <>
              {/* 通知铃铛图标 - desktop opens panel, mobile navigates to /inbox */}
              <button
                data-inbox-trigger
                className="top-nav-notif-btn"
                aria-label={t('inbox')}
                onClick={() => {
                  // On mobile, navigate to inbox page; on desktop, toggle panel
                  if (window.innerWidth < 1024) {
                    router.push('/inbox')
                  } else {
                    useInboxStore.getState().togglePanel()
                  }
                }}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  height: 44,
                  borderRadius: tokens.radius.full,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <NotificationIcon size={20} />
                {totalUnread > 0 && (
                  <Box
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: -2,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 8,
                      background: '#ef4444',
                      border: `1.5px solid ${tokens.colors.bg.primary}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 4px',
                    }}
                  >
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', lineHeight: 1 }}>
                      {totalUnread > 99 ? '99+' : totalUnread}
                    </span>
                  </Box>
                )}
              </button>
              <Box
                as="button"
                onClick={() => setShowUserMenu(!showUserMenu)}
                aria-label={t('userMenu')}
                aria-expanded={showUserMenu}
                aria-haspopup="menu"
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
                  <Image
                    src={myAvatarUrl}
                    alt={t('avatar')}
                    width={36}
                    height={36}
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: tokens.radius.full,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      objectFit: 'cover',
                    }}
                    unoptimized={myAvatarUrl?.startsWith('data:')}
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
                  aria-label={t('userMenuOptions')}
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
                  {/* Account Switcher - wrapped in group for ARIA menu compliance */}
                  <div role="group" aria-label="Account switcher">
                    <AccountSwitcher onClose={() => setShowUserMenu(false)} />
                  </div>
                  <Box style={{ height: 1, background: tokens.colors.border.primary, margin: `${tokens.spacing[1]} 0` }} role="separator" />

                  <Link
                    href={myHandle ? `/u/${encodeURIComponent(myHandle)}` : '/'}
                    role="menuitem"
                    className="top-nav-menu-link"
                    onClick={(e) => {
                      if (!myHandle) {
                        e.preventDefault()
                        router.push('/settings')
                      } else {
                        setShowUserMenu(false)
                      }
                    }}
                    style={{ ...MENU_LINK_STYLE, cursor: 'pointer' }}
                  >
                    <UserIcon size={16} />
                    <span>{t('myHome')}</span>
                  </Link>
                  <Link
                    href="/inbox"
                    role="menuitem"
                    className="top-nav-menu-link"
                    style={{ ...MENU_LINK_STYLE, position: 'relative' }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <Box style={{ position: 'relative' }}>
                      <NotificationIcon size={16} />
                      {totalUnread > 0 && (
                        <Box
                          style={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            minWidth: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: '#ef4444',
                            color: '#ffffff',
                            fontSize: 10,
                            fontWeight: 900,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '0 4px',
                          }}
                        >
                          {formatUnreadBadge(totalUnread)}
                        </Box>
                      )}
                    </Box>
                    <span>{t('inbox')}</span>
                  </Link>
                  <Link
                    href="/settings"
                    role="menuitem"
                    className="top-nav-menu-link"
                    style={MENU_LINK_STYLE}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    <span>{t('settings')}</span>
                  </Link>
                  <Box
                    role="separator"
                    style={{
                      height: 1,
                      background: tokens.colors.border.primary,
                      margin: `${tokens.spacing[2]} 0`,
                    }}
                  />
                  <Link
                    href="/logout"
                    role="menuitem"
                    className="top-nav-logout-link"
                    style={{
                      display: 'block',
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.text.secondary,
                      textDecoration: 'none',
                      fontSize: tokens.typography.fontSize.base,
                      fontWeight: tokens.typography.fontWeight.bold,
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
              className="btn-press touch-target top-nav-login-link"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                background: tokens.gradient.primary,
                color: tokens.colors.white,
                textDecoration: 'none',
                fontWeight: tokens.typography.fontWeight.black,
                fontSize: tokens.typography.fontSize.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 72,
                height: 44,
                border: 'none',
                boxShadow: `0 4px 12px ${tokens.colors.accent.primary}40`,
              }}
            >
              {t('login')}
            </Link>
          )}
        </div>
      </Box>
      <MobileSearchOverlay open={showMobileSearch} onClose={() => setShowMobileSearch(false)} />
      {/* Desktop inbox panel - slides in from right */}
      <div className="hide-mobile hide-tablet">
        <InboxPanel />
      </div>
    </Box>
  )
}
