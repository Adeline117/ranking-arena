'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { PRO_FREE_PROMO } from '@/lib/types/premium'
import ThemeToggle from '../ui/ThemeToggle'
import LanguageSwitcher from '../ui/LanguageToggle'
import LoginButton from './LoginButton'
import { useTopNavState } from './useTopNavState'

export const TOP_NAV_AUTH_SLOT_WIDTH = 104
export const TOP_NAV_PRO_SLOT_WIDTH = 72

function NavSearchBarFallback() {
  return (
    <div
      className="top-nav-search hide-mobile"
      data-testid="top-nav-search-fallback"
      aria-hidden="true"
      style={{
        flex: 1,
        display: 'flex',
        justifyContent: 'center',
        maxWidth: 600,
        height: 44,
        position: 'relative',
      }}
    >
      <div
        className="skeleton"
        style={{
          width: '100%',
          height: 44,
          borderRadius: tokens.radius.full,
          border: tokens.glass.border.light,
          background: tokens.glass.bg.light,
        }}
      />
    </div>
  )
}

function MobileSearchButtonFallback() {
  return (
    <div
      className="show-mobile-flex skeleton"
      data-testid="mobile-search-button-fallback"
      aria-hidden="true"
      style={{
        width: 44,
        height: 44,
        borderRadius: tokens.radius.full,
        flexShrink: 0,
      }}
    />
  )
}

export function GoProButtonFallback() {
  return (
    <div
      className="skeleton"
      data-testid="top-nav-pro-fallback"
      aria-hidden="true"
      style={{
        width: '100%',
        height: 30,
        borderRadius: tokens.radius.full,
      }}
    />
  )
}

export function TopNavProSlot({
  promoEnabled,
  children,
}: {
  promoEnabled: boolean
  children: ReactNode
}) {
  if (promoEnabled) return null

  return (
    <div
      className="hide-mobile top-nav-pro-slot"
      data-testid="top-nav-pro-slot"
      style={{
        width: TOP_NAV_PRO_SLOT_WIDTH,
        height: 30,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  )
}

// Search bar: large component (autocomplete, dropdown, API calls) — defer to reduce initial chunk
const NavSearchBar = dynamic(() => import('./NavSearchBar'), {
  ssr: false,
  loading: NavSearchBarFallback,
})
const MobileSearchButton = dynamic(() => import('./MobileSearchButton'), {
  ssr: false,
  loading: MobileSearchButtonFallback,
})

// Auth-dependent components: only needed when logged in, dynamic to reduce initial bundle
const NotificationButton = dynamic(() => import('./NotificationButton'), { ssr: false })
const UserMenuDropdown = dynamic(() => import('./UserMenuDropdown'), { ssr: false })
const GoProButton = dynamic(() => import('./GoProButton'), {
  ssr: false,
  loading: GoProButtonFallback,
})

// Lazy load non-critical components
const MobileSearchOverlay = dynamic(() => import('../search/MobileSearchOverlay'), { ssr: false })
const InboxPanel = dynamic(() => import('../inbox/InboxPanel'), { ssr: false })

export default function TopNavClient() {
  const router = useRouter()

  const {
    authPending,
    myId,
    myHandle,
    myAvatarUrl,
    myEmail,
    viewerScopeKey,
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

  // PROD P1-PROD-3 (audit): Cmd+K / Ctrl+K focuses the search input from
  // anywhere on the page. The search bar's placeholder already advertises
  // ⌘K but the keyboard listener was missing. On mobile, opens the
  // mobile search overlay instead since the desktop search bar is hidden.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Cmd+K (Mac) or Ctrl+K (Win/Linux). Ignore when typing in an input
      // unless the input is the search bar itself (re-focus is harmless).
      if (e.key !== 'k' || !(e.metaKey || e.ctrlKey)) return
      const target = e.target as HTMLElement | null
      const inEditableField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          (target as HTMLElement).isContentEditable)
      // Allow Cmd+K to refocus the search input if it's already focused;
      // block when user is in any OTHER editable field.
      const isSearchInput = target instanceof HTMLInputElement && target.type === 'search'
      if (inEditableField && !isSearchInput) return

      e.preventDefault()
      // Desktop: focus the search input inside searchRef.
      const searchEl = searchRef.current?.querySelector<HTMLInputElement>('input[type="search"]')
      if (searchEl && searchEl.offsetParent !== null) {
        searchEl.focus()
        searchEl.select()
        setShowSearchDropdown(true)
        return
      }
      // Mobile: search input is hidden — open the mobile overlay instead.
      setShowMobileSearch(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchRef, setShowSearchDropdown, setShowMobileSearch])

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
        <TopNavProSlot promoEnabled={PRO_FREE_PROMO}>
          <GoProButton />
        </TopNavProSlot>
        <LanguageSwitcher />
        <div className="top-nav-theme-action">
          <ThemeToggle />
        </div>
        <div
          className="top-nav-auth-slot"
          data-testid="top-nav-auth-slot"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: tokens.spacing[2],
            width: TOP_NAV_AUTH_SLOT_WIDTH,
            flexShrink: 0,
          }}
        >
          {authPending ? (
            <div
              className="skeleton"
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                flexShrink: 0,
              }}
            />
          ) : myId ? (
            <>
              <NotificationButton totalUnread={totalUnread} />
              <UserMenuDropdown
                key={viewerScopeKey}
                myId={myId}
                myHandle={myHandle}
                myAvatarUrl={myAvatarUrl}
                email={myEmail}
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
    </>
  )
}
