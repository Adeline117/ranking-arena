// TODO (#P8): Consider splitting into TopNavShell (server component with logo + static nav links)
// and TopNavClient (interactive search, user menu, notifications). The shell would reduce JS
// bundle and improve TTFB. Currently too tightly coupled with client hooks to split easily.
'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import ThemeToggle from '../ui/ThemeToggle'
import LanguageSwitcher from '../ui/LanguageToggle'
import { useLanguage } from '../Providers/LanguageProvider'
import NavLinks from './NavLinks'
import NavSearchBar from './NavSearchBar'
import MobileSearchButton from './MobileSearchButton'
import LoginButton from './LoginButton'
import { useTopNavState } from './useTopNavState'

// Auth-dependent components: only needed when logged in, dynamic to reduce initial bundle
const NotificationButton = dynamic(() => import('./NotificationButton'), { ssr: false })
const UserMenuDropdown = dynamic(() => import('./UserMenuDropdown'), { ssr: false })

// Lazy load non-critical components
const MobileSearchOverlay = dynamic(() => import('../search/MobileSearchOverlay'), { ssr: false })
const InboxPanel = dynamic(() => import('../inbox/InboxPanel'), { ssr: false })

export default function TopNav({ email = null }: { email?: string | null }) {
  const { t } = useLanguage()
  const router = useRouter()

  const {
    authLoggedIn,
    authChecked,
    isReady,
    myId,
    myHandle,
    myAvatarUrl,
    showUserMenu,
    setShowUserMenu,
    searchQuery,
    setSearchQuery,
    showSearchDropdown,
    setShowSearchDropdown,
    showMobileSearch,
    setShowMobileSearch,
    totalUnread,
    menuRef,
    searchRef,
    handleSearch,
  } = useTopNavState()

  // Prefetch common navigation targets — deferred to avoid blocking initial hydration
  useEffect(() => {
    const prefetch = () => {
      router.prefetch('/rankings')
      router.prefetch('/market')
      router.prefetch('/pricing')
    }
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(prefetch, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    } else {
      const id = setTimeout(prefetch, 2000)
      return () => clearTimeout(id)
    }
  }, [router])

  return (
    <header
      className="top-nav glass top-nav-header"
      style={{
        background: tokens.glass.bg.primary,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        boxShadow: 'var(--shadow-card), var(--shadow-border-glow), var(--shadow-inset-subtle)',
      }}
    >
      <div
        className="top-nav-container top-nav-inner"
        style={{
          paddingLeft: tokens.spacing[3],
          paddingRight: tokens.spacing[3],
          gap: tokens.spacing[2],
        }}
      >
        {/* Left: Logo + Nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
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
            <div
              data-logo-box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              <Image
                src="/logo-symbol-56.png"
                alt="arena"
                width={28}
                height={28}
                priority
                style={{ flexShrink: 0, borderRadius: 4, objectFit: 'contain' }}
              />
              <div
                style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  color: 'var(--color-text-primary)',
                  letterSpacing: '-0.3px',
                  fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
                }}
              >
                <span style={{ color: 'var(--color-brand)', fontWeight: 800 }}>a</span>rena
              </div>
            </div>
          </Link>

          <NavLinks />
        </div>

        {/* Center: Search (desktop) */}
        <NavSearchBar
          searchRef={searchRef}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          showSearchDropdown={showSearchDropdown}
          setShowSearchDropdown={setShowSearchDropdown}
          onSearch={handleSearch}
        />

        {/* Right: Language + Theme + User */}
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
          <MobileSearchButton onOpen={() => setShowMobileSearch(true)} />
          <LanguageSwitcher />
          <ThemeToggle />
          {!isReady ? (
            authChecked && authLoggedIn ? (
              <div
                className="skeleton"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  flexShrink: 0,
                }}
              />
            ) : (
              <LoginButton />
            )
          ) : myId ? (
            <>
              <NotificationButton totalUnread={totalUnread} />
              <UserMenuDropdown
                myId={myId}
                myHandle={myHandle}
                myAvatarUrl={myAvatarUrl}
                email={email ?? null}
                showUserMenu={showUserMenu}
                setShowUserMenu={setShowUserMenu}
                totalUnread={totalUnread}
              />
            </>
          ) : (
            <LoginButton />
          )}
        </div>
      </div>
      <MobileSearchOverlay open={showMobileSearch} onClose={() => setShowMobileSearch(false)} />
      {/* Desktop inbox panel - slides in from right */}
      <div className="hide-mobile hide-tablet">
        <InboxPanel />
      </div>
    </header>
  )
}
