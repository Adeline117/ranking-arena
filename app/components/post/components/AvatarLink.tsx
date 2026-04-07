'use client'

import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { ProBadgeOverlay } from '@/app/components/ui/ProBadge'

interface AvatarLinkProps {
  handle?: string | null
  avatarUrl?: string | null
  isPro?: boolean
  showProBadge?: boolean
  isOfficial?: boolean
}

export function AvatarLink({ handle, avatarUrl, isPro, showProBadge = true, isOfficial }: AvatarLinkProps) {
  const { t } = useLanguage()
  if (!handle) return null

  const href = `/u/${encodeURIComponent(handle)}`
  const shouldShowBadge = isPro && showProBadge

  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        textDecoration: 'none',
        color: tokens.colors.text.primary,
        overflow: 'hidden',
        minWidth: 0,
        flexShrink: 1,
      }}
      title={t('goToTraderProfile')}
    >
      <span style={{ position: 'relative', flexShrink: 0 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: tokens.radius.md,
            display: 'grid',
            placeItems: 'center',
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            fontWeight: tokens.typography.fontWeight.black,
            fontSize: 11,
            transition: `all ${tokens.transition.base}`,
            overflow: 'hidden',
          }}
        >
          {avatarUrl ? (
            <Image
              src={avatarUrl.startsWith('data:') ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
              alt={handle}
              width={28}
              height={28}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              unoptimized
            />
          ) : (
            (handle?.[0] || 'U').toUpperCase()
          )}
        </span>
        {shouldShowBadge && <ProBadgeOverlay position="bottom-right" />}
      </span>
      <span title={handle} style={{ fontWeight: 700, fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {handle}
        {isOfficial && (
          <span style={{
            fontSize: 10,
            fontWeight: 800,
            color: tokens.colors.accent.brand,
            background: `color-mix(in srgb, ${tokens.colors.accent.brand} 12%, transparent)`,
            padding: '1px 5px',
            borderRadius: 4,
            letterSpacing: 0.5,
            textTransform: 'uppercase' as const,
            flexShrink: 0,
          }}>
            Official
          </span>
        )}
      </span>
    </Link>
  )
}


