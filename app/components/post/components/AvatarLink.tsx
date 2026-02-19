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
}

export function AvatarLink({ handle, avatarUrl, isPro, showProBadge = true }: AvatarLinkProps) {
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
              src={avatarUrl}
              alt={handle}
              width={28}
              height={28}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              unoptimized={avatarUrl?.startsWith('data:')}
            />
          ) : (
            (handle?.[0] || 'U').toUpperCase()
          )}
        </span>
        {shouldShowBadge && <ProBadgeOverlay position="bottom-right" />}
      </span>
      <span style={{ fontWeight: 700, fontSize: 12, color: tokens.colors.text.secondary, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {handle}
      </span>
    </Link>
  )
}


