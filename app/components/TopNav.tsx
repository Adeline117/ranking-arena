'use client'

import Link from 'next/link'
import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import ThemeToggle from './ThemeToggle'
import LanguageSwitcher from './LanguageSwitcher'
import SearchDropdown from './SearchDropdown'
import { useLanguage } from './LanguageProvider'
import { SearchIcon, UserIcon, DashboardIcon, NotificationIcon } from './Icons'

export default function TopNav({ email }: { email: string | null }) {
  const { t } = useLanguage()
  const [myId, setMyId] = useState<string | null>(null)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    supabase.auth.getUser().then(({ data }) => {
      if (!alive) return
      setMyId(data.user?.id ?? null)
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
    if (searchQuery.trim()) {
      window.location.href = `/search?q=${encodeURIComponent(searchQuery.trim())}`
    }
  }

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 200,
        background: 'rgba(6,6,6,0.85)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        {/* 左：Logo + Nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: '12px',
                background: 'linear-gradient(135deg, #8b6fa8 0%, #6d5580 100%)',
                display: 'grid',
                placeItems: 'center',
                fontWeight: 900,
                color: '#fff',
                fontSize: '18px',
                boxShadow: '0 2px 8px rgba(139,111,168,0.3)',
              }}
            >
              A
            </div>
            <div>
              <div style={{ fontWeight: 950, lineHeight: 1, color: '#fff', fontSize: '16px' }}>Arena</div>
              <div style={{ fontSize: '11px', color: '#9a9a9a' }}>Ranking Arena</div>
            </div>
          </Link>

          <nav style={{ display: 'flex', gap: 8, color: '#cfcfcf', fontWeight: 900, fontSize: '13px' }}>
            <Link 
              href="/" 
              style={{ 
                color: 'inherit', 
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: '8px',
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = '#cfcfcf'
              }}
            >
              首页
            </Link>
            <Link 
              href="/groups" 
              style={{ 
                color: 'inherit', 
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: '8px',
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = '#cfcfcf'
              }}
            >
              小组
            </Link>
            <Link 
              href="/hot" 
              style={{ 
                color: 'inherit', 
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: '8px',
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = '#cfcfcf'
              }}
            >
              热榜
            </Link>
            <Link 
              href="/" 
              style={{ 
                color: 'inherit', 
                textDecoration: 'none',
                padding: '6px 12px',
                borderRadius: '8px',
                transition: 'all 150ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                e.currentTarget.style.color = '#fff'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = '#cfcfcf'
              }}
            >
              市场
            </Link>
          </nav>
        </div>

        {/* 中：搜索 */}
        <div ref={searchRef} style={{ flex: 1, display: 'flex', justifyContent: 'center', maxWidth: '520px', position: 'relative' }}>
          <form onSubmit={handleSearch} style={{ width: '100%', position: 'relative' }}>
            <input
              type="text"
              placeholder={t('search') + '交易者、帖子、小组...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setShowSearchDropdown(true)}
              style={{
                width: '100%',
                height: 40,
                borderRadius: '999px',
                border: '1px solid rgba(255,255,255,0.1)',
                background: 'rgba(255,255,255,0.05)',
                color: '#eaeaea',
                padding: '0 16px 0 40px',
                outline: 'none',
                fontWeight: 700,
                fontSize: '13px',
                transition: 'all 200ms ease',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '14px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#9a9a9a',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <SearchIcon size={16} />
            </div>
          </form>
          <SearchDropdown open={showSearchDropdown} query={searchQuery} onClose={() => setShowSearchDropdown(false)} />
        </div>

        {/* 右：用户菜单 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }} ref={menuRef}>
          <LanguageSwitcher />
          <ThemeToggle />
          {myId ? (
            <>
              <div 
                onClick={() => setShowUserMenu(!showUserMenu)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '8px',
                  transition: 'all 150ms ease',
                  background: showUserMenu ? 'rgba(255,255,255,0.05)' : 'transparent',
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: '999px',
                    border: '2px solid rgba(255,255,255,0.1)',
                    background: 'rgba(139,111,168,0.2)',
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: 950,
                    color: '#eaeaea',
                    fontSize: '14px',
                  }}
                >
                  {(email?.[0] ?? 'U').toUpperCase()}
                </div>
              </div>

              {showUserMenu && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    background: '#0b0b0b',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    padding: '8px',
                    minWidth: '200px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    zIndex: 300,
                  }}
                >
                  <Link
                    href={`/user/${myId}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      color: '#eaeaea',
                      textDecoration: 'none',
                      fontSize: '14px',
                      fontWeight: 700,
                      transition: 'all 150ms ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <UserIcon size={16} />
                    <span>我的主页</span>
                  </Link>
                  <Link
                    href="/dashboard"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      color: '#eaeaea',
                      textDecoration: 'none',
                      fontSize: '14px',
                      fontWeight: 700,
                      transition: 'all 150ms ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <DashboardIcon size={16} />
                    <span>仪表盘</span>
                  </Link>
                  <Link
                    href="/notifications"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      color: '#eaeaea',
                      textDecoration: 'none',
                      fontSize: '14px',
                      fontWeight: 700,
                      transition: 'all 150ms ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.05)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    <NotificationIcon size={16} />
                    <span>通知</span>
                  </Link>
                  <div
                    style={{
                      height: '1px',
                      background: 'rgba(255,255,255,0.1)',
                      margin: '4px 0',
                    }}
                  />
                  <Link
                    href="/logout"
                    style={{
                      display: 'block',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      color: '#ff7c7c',
                      textDecoration: 'none',
                      fontSize: '14px',
                      fontWeight: 700,
                      transition: 'all 150ms ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,124,124,0.1)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => setShowUserMenu(false)}
                  >
                    退出登录
                  </Link>
                </div>
              )}
            </>
          ) : (
            <Link
              href="/login"
              style={{
                padding: '8px 16px',
                background: '#8b6fa8',
                color: '#fff',
                borderRadius: '8px',
                textDecoration: 'none',
                fontWeight: 900,
                fontSize: '13px',
                transition: 'all 200ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#a085b8'
                e.currentTarget.style.transform = 'translateY(-1px)'
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(139,111,168,0.4)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#8b6fa8'
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = 'none'
              }}
            >
              登录
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}
