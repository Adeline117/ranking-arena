'use client'

import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { isFloatingActionRoute } from '@/lib/features'
import {
  announceBottomOverlayOpen,
  subscribeToBottomOverlayOpen,
} from '@/lib/ui/bottomOverlayCoordinator'

export default function FloatingActionButton() {
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useLanguage()
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const firstMenuItemRef = useRef<HTMLButtonElement>(null)
  const wasMenuOpenRef = useRef(false)
  const restoreLauncherOnCloseRef = useRef(false)

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
        restoreLauncherOnCloseRef.current = false
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      restoreLauncherOnCloseRef.current = true
      setMenuOpen(false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [menuOpen])

  useLayoutEffect(() => {
    if (menuOpen) {
      wasMenuOpenRef.current = true
      restoreLauncherOnCloseRef.current = false
      firstMenuItemRef.current?.focus({ preventScroll: true })
      return
    }
    if (!wasMenuOpenRef.current) return
    wasMenuOpenRef.current = false
    if (restoreLauncherOnCloseRef.current) {
      launcherRef.current?.focus({ preventScroll: true })
    }
    restoreLauncherOnCloseRef.current = false
  }, [menuOpen])

  useEffect(
    () =>
      subscribeToBottomOverlayOpen((owner) => {
        if (owner === 'fab-menu') return
        restoreLauncherOnCloseRef.current = false
        setMenuOpen(false)
      }),
    []
  )

  useEffect(() => {
    restoreLauncherOnCloseRef.current = false
    setMenuOpen(false)
  }, [pathname])

  // Only show on feed and groups pages when social is enabled
  const shouldShow = isAuthenticated && isFloatingActionRoute(pathname)

  if (!shouldShow) return null

  return (
    <div
      ref={menuRef}
      className="fab-container"
      style={{
        position: 'fixed',
        bottom:
          'calc(var(--mobile-nav-height, 60px) + var(--safe-area-inset-bottom, 0px) + var(--transient-bottom-offset, 0px) + var(--page-bottom-overlay-offset, 0px) + 20px)',
        right: 20,
        zIndex: tokens.zIndex.sticky + 1,
      }}
    >
      {/* Popup menu */}
      {menuOpen && (
        <div
          className="dropdown-enter fab-menu"
          style={{
            position: 'absolute',
            bottom: 64,
            // Keep the expanded menu left of the persistent right-hand widget
            // column. Vertical stacking alone cannot fit it between Compare,
            // Feedback, ScrollToTop and the FAB on a 320px-wide short screen.
            right: 'calc(100% + 12px)',
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
            ref={firstMenuItemRef}
            onClick={() => {
              restoreLauncherOnCloseRef.current = false
              setMenuOpen(false)
              // Try last-used group, otherwise go to first available group
              const lastGroup =
                typeof window !== 'undefined' ? localStorage.getItem('last_post_group_id') : null
              if (lastGroup) {
                router.push(`/groups/${lastGroup}/new`)
              } else {
                // Fetch user's first group and navigate
                fetch('/api/groups?limit=1')
                  .then((r) => r.json())
                  .then((data) => {
                    const groups = data.groups || data
                    if (Array.isArray(groups) && groups.length > 0) {
                      router.push(`/groups/${groups[0].id}/new`)
                    } else {
                      router.push('/groups')
                    }
                  })
                  .catch(() => router.push('/groups'))
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
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.secondary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>{t('newPost')}</span>
          </button>
          <button
            onClick={() => {
              restoreLauncherOnCloseRef.current = false
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
            onMouseEnter={(e) => {
              e.currentTarget.style.background = tokens.colors.bg.secondary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
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
        ref={launcherRef}
        onClick={() => {
          if (menuOpen) {
            restoreLauncherOnCloseRef.current = false
            setMenuOpen(false)
            return
          }
          restoreLauncherOnCloseRef.current = false
          announceBottomOverlayOpen('fab-menu')
          setMenuOpen(true)
        }}
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
          boxShadow: `0 4px 16px ${alpha(tokens.colors.accent.primary, 31)}`,
          transition: `all ${tokens.transition.base}`,
          transform: menuOpen ? 'rotate(45deg)' : 'rotate(0deg)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = menuOpen ? 'rotate(45deg) scale(1.1)' : 'scale(1.1)'
          e.currentTarget.style.boxShadow = `0 6px 24px ${alpha(tokens.colors.accent.primary, 44)}`
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = menuOpen ? 'rotate(45deg)' : 'rotate(0deg)'
          e.currentTarget.style.boxShadow = `0 4px 16px ${alpha(tokens.colors.accent.primary, 31)}`
        }}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  )
}
