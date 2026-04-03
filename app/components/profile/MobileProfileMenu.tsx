'use client'

import { localizedLabel } from '@/lib/utils/format'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { features } from '@/lib/features'

interface UserInfo {
  handle: string | null
  email: string | null
  avatarUrl: string | null
  displayName: string | null
}

const ALL_MENU_ITEMS = [
  { href: '/watchlist', iconPath: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z', labelZh: '我的 Watchlist', labelEn: 'My Watchlist' },
  { href: '/compare', iconPath: 'M18 20V10M12 20V4M6 20v-6', labelZh: '对比交易员', labelEn: 'Compare Traders' },
  { href: '/groups', iconPath: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75', labelZh: '我的群组', labelEn: 'My Groups', social: true },
  { href: '/notifications', iconPath: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0', labelZh: '通知', labelEn: 'Notifications' },
] as const

const MENU_ITEMS = ALL_MENU_ITEMS.filter(item => !('social' in item && item.social) || features.social)

const SETTINGS_ITEMS = [
  { href: '/settings', iconPath: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', labelZh: '设置', labelEn: 'Settings' },
  { href: '/pricing', iconPath: 'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z', labelZh: '升级 Pro', labelEn: 'Upgrade to Pro', highlight: true },
] as const

/**
 * Mobile-optimized profile menu — shown when "Me" tab is tapped
 * Displays user info + quick navigation links in iOS Settings-like layout
 */
export default function MobileProfileMenu() {
  const { t, language } = useLanguage()
  const [user, setUser] = useState<UserInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session?.user) {
        setLoading(false)
        return
      }
      const u = data.session.user
      supabase
        .from('user_profiles')
        .select('handle, display_name, avatar_url')
        .eq('id', u.id)
        .maybeSingle()
        .then(({ data: profile }) => {
          setUser({
            handle: profile?.handle || null,
            email: u.email || null,
            avatarUrl: profile?.avatar_url || null,
            displayName: profile?.display_name || null,
          })
          setLoading(false)
        })
    })
  }, [])

  if (loading) {
    return (
      <div style={{ padding: tokens.spacing[6], display: 'flex', justifyContent: 'center' }}>
        <div className="skeleton" style={{ width: '100%', height: 200, borderRadius: tokens.radius.xl }} />
      </div>
    )
  }

  return (
    <div style={{ padding: tokens.spacing[4], display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {/* User card */}
      <Link
        href={user?.handle ? `/u/${encodeURIComponent(user.handle)}` : '/settings'}
        style={{ textDecoration: 'none' }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[4],
            padding: tokens.spacing[4],
            background: 'var(--color-bg-secondary)',
            borderRadius: tokens.radius.xl,
            border: '1px solid var(--color-border-primary)',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: tokens.radius.full,
              background: user?.avatarUrl ? 'var(--color-bg-tertiary)' : `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
              display: 'grid',
              placeItems: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {user?.avatarUrl ? (
              <img
                src={`/api/avatar?url=${encodeURIComponent(user.avatarUrl)}`}
                alt={user?.handle || 'Avatar'}
                width={56}
                height={56}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <span style={{ color: tokens.colors.white, fontSize: 20, fontWeight: 700 }}>
                {(user?.displayName || user?.handle || user?.email || '?').charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: tokens.typography.fontSize.md, fontWeight: 700, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user ? (user.displayName || user.handle || user.email) : t('loginOrSignUp')}
            </div>
            {user?.handle && (
              <div style={{ fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                @{user.handle}
              </div>
            )}
          </div>

          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth={2}>
            <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </Link>

      {/* Menu items */}
      <div
        style={{
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.xl,
          border: '1px solid var(--color-border-primary)',
          overflow: 'hidden',
        }}
      >
        {MENU_ITEMS.map((item, i) => (
          <MenuItem
            key={item.href}
            href={item.href}
            iconPath={item.iconPath}
            label={localizedLabel(item.labelZh, item.labelEn, language)}
            showDivider={i < MENU_ITEMS.length - 1}
          />
        ))}
      </div>

      {/* Settings items */}
      <div
        style={{
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.xl,
          border: '1px solid var(--color-border-primary)',
          overflow: 'hidden',
        }}
      >
        {SETTINGS_ITEMS.map((item, i) => (
          <MenuItem
            key={item.href}
            href={item.href}
            iconPath={item.iconPath}
            label={localizedLabel(item.labelZh, item.labelEn, language)}
            showDivider={i < SETTINGS_ITEMS.length - 1}
            highlight={'highlight' in item ? item.highlight : false}
          />
        ))}
      </div>
    </div>
  )
}

function MenuItem({
  href,
  iconPath,
  label,
  showDivider,
  highlight = false,
}: {
  href: string
  iconPath: string
  label: string
  showDivider: boolean
  highlight?: boolean
}) {
  return (
    <Link
      href={href}
      className="settings-menu-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        textDecoration: 'none',
        minHeight: 52,
        borderBottom: showDivider ? '1px solid var(--color-border-primary)' : 'none',
        color: highlight ? tokens.colors.accent.primary : 'var(--color-text-primary)',
      }}
    >
      <svg
        width={20}
        height={20}
        viewBox="0 0 24 24"
        fill={highlight ? tokens.colors.accent.primary : 'none'}
        stroke={highlight ? tokens.colors.accent.primary : 'var(--color-text-secondary)'}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={iconPath} />
      </svg>
      <span style={{ flex: 1, fontSize: tokens.typography.fontSize.base, fontWeight: highlight ? 600 : 400 }}>
        {label}
      </span>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth={2}>
        <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  )
}
