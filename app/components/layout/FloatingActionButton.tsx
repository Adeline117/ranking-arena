'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { features } from '@/lib/features'

export default function FloatingActionButton() {
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useLanguage()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Use getSession() — reads from local storage, no network request
    supabase.auth.getSession().then(({ data }) => {
      setIsAuthenticated(!!data.session?.user)
    })
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  // Only show on feed and groups pages when social is enabled
  const showOnPages = features.social ? ['/', '/hot', '/groups'] : []
  const shouldShow = isAuthenticated && features.social && showOnPages.some(p => pathname === p || pathname.startsWith('/groups/'))

  if (!shouldShow) return null

  return (
    <div
      ref={menuRef}
      className="fab-container"
      style={{
        position: 'fixed',
        bottom: 'calc(var(--mobile-nav-height, 60px) + env(safe-area-inset-bottom, 0px) + 20px)',
        right: 20,
        zIndex: tokens.zIndex.sticky + 1,
      }}
    >
      {/* Popup menu */}
      {menuOpen && (
        <div
          className="dropdown-enter"
          style={{
            position: 'absolute',
            bottom: 64,
            right: 0,
            background: tokens.glass.bg.secondary,
            backdropFilter: tokens.glass.blur.xl,
            WebkitBackdropFilter: tokens.glass.blur.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.xl,
            padding: tokens.spacing[2],
            minWidth: 180,
            boxShadow: tokens.shadow.xl,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[1],
          }}
        >
          <button
            onClick={() => {
              setMenuOpen(false)
              // Try last-used group, otherwise go to first available group
              const lastGroup = typeof window !== 'undefined' ? localStorage.getItem('last_post_group_id') : null
              if (lastGroup) {
                router.push(`/groups/${lastGroup}/new`)
              } else {
                // Fetch user's first group and navigate
                fetch('/api/groups?limit=1').then(r => r.json()).then(data => {
                  const groups = data.groups || data
                  if (Array.isArray(groups) && groups.length > 0) {
                    router.push(`/groups/${groups[0].id}/new`)
                  } else {
                    router.push('/groups')
                  }
                }).catch(() => router.push('/groups'))
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.md,
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              cursor: 'pointer',
              width: '100%',
              textAlign: 'left',
              transition: `background ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>{t('newPost')}</span>
          </button>
          <button
            onClick={() => {
              setMenuOpen(false)
              router.push('/groups')
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.md,
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: 600,
              cursor: 'pointer',
              width: '100%',
              textAlign: 'left',
              transition: `background ${tokens.transition.fast}`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>{t('postToGroup')}</span>
          </button>
        </div>
      )}

      {/* FAB button */}
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={t('createPost')}
        aria-expanded={menuOpen}
        aria-haspopup="true"
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          border: 'none',
          background: tokens.gradient.primary,
          color: tokens.colors.white,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 4px 16px ${tokens.colors.accent.primary}50`,
          transition: `all ${tokens.transition.base}`,
          transform: menuOpen ? 'rotate(45deg)' : 'rotate(0deg)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = menuOpen ? 'rotate(45deg) scale(1.1)' : 'scale(1.1)'
          e.currentTarget.style.boxShadow = `0 6px 24px ${tokens.colors.accent.primary}70`
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = menuOpen ? 'rotate(45deg)' : 'rotate(0deg)'
          e.currentTarget.style.boxShadow = `0 4px 16px ${tokens.colors.accent.primary}50`
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  )
}
