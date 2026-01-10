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
import { SearchIcon, UserIcon, DashboardIcon, NotificationIcon } from '../Icons'
import { Box } from '../Base'

export default function TopNav({ email }: { email: string | null }) {
  const { t } = useLanguage()
  const pathname = usePathname()
  const [myId, setMyId] = useState<string | null>(null)
  const [myHandle, setMyHandle] = useState<string | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
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
      
      // 获取用户的handle
      if (userId) {
        // 直接使用 user_profiles 表（profiles 表不存在）
        supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', userId)
          .maybeSingle()
          .then(({ data: userProfile }) => {
            if (!alive) return
            if (userProfile && userProfile.handle) {
              setMyHandle(userProfile.handle)
            } else {
              // 如果都没有 handle，尝试从邮箱创建默认 handle
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
      className="top-nav"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: tokens.zIndex.sticky,
        background: tokens.colors.bg.primary,
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
        height: 64,
        backdropFilter: 'blur(10px)',
        boxShadow: tokens.shadow.xs,
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
              const logoBox = e.currentTarget.querySelector('[data-logo-box]') as HTMLElement
              if (logoBox) {
                logoBox.style.transform = 'scale(1.05) rotate(2deg)'
                logoBox.style.boxShadow = tokens.shadow.md
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              const logoBox = e.currentTarget.querySelector('[data-logo-box]') as HTMLElement
              if (logoBox) {
                logoBox.style.transform = 'scale(1) rotate(0deg)'
                logoBox.style.boxShadow = tokens.shadow.sm
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                window.location.href = '/'
              }
            }}
          >
            {/* Logo Icon - 紫色系现代设计 */}
            <Box
              data-logo-box
              style={{
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: tokens.radius.lg,
                // 紫色系渐变：深紫到浅紫（适配主题）
                background: theme === 'light'
                  ? 'linear-gradient(135deg, #7C3AED 0%, #A855F7 50%, #C084FC 100%)' // 亮色主题：深紫到浅紫
                  : 'linear-gradient(135deg, #8B5CF6 0%, #A78BFA 50%, #C4B5FD 100%)', // 暗色主题：稍亮紫色
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: tokens.typography.fontWeight.black,
                color: '#FFFFFF', // 白色文字确保在紫色背景上清晰可见
                fontSize: tokens.typography.fontSize.lg,
                boxShadow: theme === 'light'
                  ? '0 2px 8px rgba(124, 58, 237, 0.3)' // 亮色主题：紫色阴影
                  : '0 2px 8px rgba(139, 92, 246, 0.4), 0 0 16px rgba(139, 92, 246, 0.2)', // 暗色主题：紫色光晕
                transition: `all ${tokens.transition.base}`,
                overflow: 'hidden',
              }}
            >
              {/* 内部装饰光效 - 紫色光效 */}
              <Box
                style={{
                  position: 'absolute',
                  top: '-50%',
                  left: '-50%',
                  width: '200%',
                  height: '200%',
                  background: `radial-gradient(circle, rgba(255,255,255,0.25) 0%, rgba(167, 139, 250, 0.3) 50%, transparent 70%)`,
                  opacity: 0.7,
                  transition: `opacity ${tokens.transition.base}`,
                }}
              />
              {/* Logo文字 - 使用更现代的设计 */}
              <Box
                style={{
                  position: 'relative',
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '100%',
                  height: '100%',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  letterSpacing: '-0.5px',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.2)', // 添加文字阴影增强可读性
                }}
              >
                RA
              </Box>
            </Box>
            {/* Logo文字 - 可选：如果需要显示完整品牌名 */}
            <Box
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                lineHeight: tokens.typography.lineHeight.tight,
              }}
            >
              <Box
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.black,
                  color: tokens.colors.text.primary,
                  letterSpacing: '-0.3px',
                }}
              >
                Ranking
              </Box>
              <Box
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: tokens.colors.text.secondary,
                  letterSpacing: '0.5px',
                  marginTop: '-2px',
                }}
              >
                Arena
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
          className="top-nav-actions"
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
                  role="menu"
                  aria-label="用户菜单选项"
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
              aria-label={t('login')}
              tabIndex={0}
              role="button"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                background: tokens.colors.accent.primary,
                color: tokens.colors.black || '#000000',
                textDecoration: 'none',
                fontWeight: tokens.typography.fontWeight.black,
                fontSize: tokens.typography.fontSize.base,
                transition: `all ${tokens.transition.base}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 80,
                height: 36,
                border: `1px solid ${tokens.colors.accent.primary}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.text.secondary || '#ffffff'
                e.currentTarget.style.opacity = '0.9'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.accent.primary
                e.currentTarget.style.opacity = '1'
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
