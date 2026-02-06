'use client'

import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ProBadgeOverlay } from '@/app/components/ui/ProBadge'

interface AvatarLinkProps {
  handle?: string | null
  avatarUrl?: string | null
  isPro?: boolean
  showProBadge?: boolean
}

export function AvatarLink({ handle, avatarUrl, isPro, showProBadge = true }: AvatarLinkProps) {
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
      }}
      title="进入交易者主页"
    >
      <span style={{ position: 'relative', flexShrink: 0 }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: tokens.radius.md,
            display: 'grid',
            placeItems: 'center',
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            fontWeight: tokens.typography.fontWeight.black,
            fontSize: tokens.typography.fontSize.xs,
            transition: `all ${tokens.transition.base}`,
            overflow: 'hidden',
          }}
        >
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt={handle}
              width={24}
              height={24}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              unoptimized={avatarUrl?.startsWith('data:')}
            />
          ) : (
            (handle?.[0] || 'U').toUpperCase()
          )}
        </span>
        {shouldShowBadge && <ProBadgeOverlay position="bottom-right" />}
      </span>
      <span style={{ fontWeight: 850, fontSize: 12, color: tokens.colors.text.secondary }}>
        {handle}
      </span>
    </Link>
  )
}


