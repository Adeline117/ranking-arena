'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { UserIcon, NotificationIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { avatarSrc } from '@/lib/utils/avatar-proxy'

const AccountSwitcher = dynamic(() => import('../ui/AccountSwitcher'), { ssr: false })

function formatUnreadBadge(count: number): string {
  return count > 99 ? '99+' : String(count)
}

const MENU_LINK_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.spacing[2],
  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
  borderRadius: tokens.radius.md,
  color: 'var(--color-text-primary)',
  textDecoration: 'none',
  fontSize: tokens.typography.fontSize.base,
  fontWeight: tokens.typography.fontWeight.bold,
  minHeight: 44,
}

export interface UserMenuDropdownProps {
  myId: string
  myHandle: string | null
  myAvatarUrl: string | null
  email: string | null
  showUserMenu: boolean
  setShowUserMenu: (show: boolean) => void
  totalUnread: number
}

export default function UserMenuDropdown({
  myId,
  myHandle,
  myAvatarUrl,
  email,
  showUserMenu,
  setShowUserMenu,
  totalUnread,
}: UserMenuDropdownProps) {
  const { t } = useLanguage()
  const [avatarError, setAvatarError] = useState(false)
  const router = useRouter()
  // myId is used to confirm the user is logged in (required by parent)
  void myId

  // Close dropdown on Escape key (works even when focus is inside menu items)
  useEffect(() => {
    if (!showUserMenu) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowUserMenu(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showUserMenu, setShowUserMenu])

  return (
    <>
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
          background: showUserMenu ? 'var(--color-bg-secondary)' : 'transparent',
          border: 'none',
          fontFamily: 'inherit',
          color: 'inherit',
          minWidth: 44,
          minHeight: 44,
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
        {myAvatarUrl && !avatarError ? (
          <Image
            src={avatarSrc(myAvatarUrl)}
            alt="Avatar"
            width={36}
            height={36}
            sizes="36px"
            unoptimized
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radius.full,
              border: `1px solid var(--color-border-primary)`,
              objectFit: 'cover',
            }}
            onError={() => setAvatarError(true)}
          />
        ) : (
          <Box
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radius.full,
              border: `1px solid var(--color-border-primary)`,
              background: getAvatarGradient(myId || 'user'),
              display: 'grid',
              placeItems: 'center',
              fontWeight: tokens.typography.fontWeight.black,
              color: tokens.colors.white,
              fontSize: tokens.typography.fontSize.sm,
              textShadow: 'var(--text-shadow-sm)',
            }}
          >
            {getAvatarInitial(myHandle || email)}
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
            minWidth: 'min(220px, calc(100vw - 32px))',
            maxWidth: 'calc(100vw - 16px)',
            boxShadow: `${tokens.shadow.xl}, 0 0 40px var(--color-overlay-medium)`,
            zIndex: tokens.zIndex.dropdown,
          }}
        >
          {/* Account Switcher - wrapped in group for ARIA menu compliance */}
          <div role="group" aria-label="Account switcher">
            <AccountSwitcher onClose={() => setShowUserMenu(false)} />
          </div>
          <Box
            style={{
              height: 1,
              background: 'var(--color-border-primary)',
              margin: `${tokens.spacing[1]} 0`,
            }}
            role="separator"
          />

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
            href="/user-center"
            role="menuitem"
            className="top-nav-menu-link"
            style={MENU_LINK_STYLE}
            onClick={() => setShowUserMenu(false)}
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
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{t('userCenter')}</span>
          </Link>
          {/* 持仓和多链资产已移到个人主页 tabs */}
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
                    background: tokens.colors.accent.error,
                    color: tokens.colors.white,
                    fontSize: 12,
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
          {/* 升级Pro已合并到用户中心 */}
          <Link
            href="/claim"
            role="menuitem"
            className="top-nav-menu-link"
            style={MENU_LINK_STYLE}
            onClick={() => setShowUserMenu(false)}
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
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <polyline points="9 12 11 14 15 10" />
            </svg>
            <span>{t('claimTrader')}</span>
          </Link>
          <Link
            href="/referral"
            role="menuitem"
            className="top-nav-menu-link"
            style={MENU_LINK_STYLE}
            onClick={() => setShowUserMenu(false)}
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
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            <span>{t('referral')}</span>
          </Link>
          <Link
            href="/portfolio"
            role="menuitem"
            className="top-nav-menu-link"
            style={MENU_LINK_STYLE}
            onClick={() => setShowUserMenu(false)}
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
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
            </svg>
            <span>{t('portfolio')}</span>
          </Link>
          {/* B2C primary navigation: saved traders belongs in the account menu.
              The developer API remains available from the footer/docs routes. */}
          <Link
            href="/saved?tab=traders"
            role="menuitem"
            className="top-nav-menu-link"
            style={MENU_LINK_STYLE}
            onClick={() => setShowUserMenu(false)}
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
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span>{t('watchlist')}</span>
          </Link>
          <Link
            href="/settings"
            role="menuitem"
            className="top-nav-menu-link"
            style={MENU_LINK_STYLE}
            onClick={() => setShowUserMenu(false)}
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
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{t('settings')}</span>
          </Link>
          <Box
            role="separator"
            style={{
              height: 1,
              background: 'var(--color-border-primary)',
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
              color: 'var(--color-text-secondary)',
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
  )
}
