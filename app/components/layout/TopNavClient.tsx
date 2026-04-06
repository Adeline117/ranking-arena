'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import ThemeToggle from '../ui/ThemeToggle'
import LanguageSwitcher from '../ui/LanguageToggle'
import LoginButton from './LoginButton'
import { useTopNavState } from './useTopNavState'

// Search bar: large component (autocomplete, dropdown, API calls) — defer to reduce initial chunk
const NavSearchBar = dynamic(() => import('./NavSearchBar'), { ssr: false })
const MobileSearchButton = dynamic(() => import('./MobileSearchButton'), { ssr: false })

// Auth-dependent components: only needed when logged in, dynamic to reduce initial bundle
const NotificationButton = dynamic(() => import('./NotificationButton'), { ssr: false })
const UserMenuDropdown = dynamic(() => import('./UserMenuDropdown'), { ssr: false })

// Lazy load non-critical components
const MobileSearchOverlay = dynamic(() => import('../search/MobileSearchOverlay'), { ssr: false })
const InboxPanel = dynamic(() => import('../inbox/InboxPanel'), { ssr: false })

export default function TopNavClient({ email = null }: { email?: string | null }) {
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
    <>
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
      <MobileSearchOverlay open={showMobileSearch} onClose={() => setShowMobileSearch(false)} />
      {/* Desktop inbox panel - slides in from right */}
      <div className="hide-mobile hide-tablet">
        <InboxPanel />
      </div>
    </>
  )
}
