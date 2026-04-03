'use client'

import Link from 'next/link'
import Image from 'next/image'
import { ProBadgeOverlay } from '../../ui/ProBadge'
import { commentStyles } from './commentStyles'

// Pro badge inline icon (used next to usernames)
export function ProBadge({ size = 14 }: { size?: number }): React.ReactNode {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--color-pro-badge-bg)',
        boxShadow: '0 0 3px var(--color-pro-badge-shadow)',
        flexShrink: 0,
      }}
    >
      <svg width={size * 0.57} height={size * 0.57} viewBox="0 0 24 24" fill="var(--color-on-accent)">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
    </span>
  )
}

// Avatar component for comments
export function CommentAvatar({ handle, avatarUrl, isReply, isPro, showProBadge }: {
  handle?: string | null
  avatarUrl?: string | null
  isReply: boolean
  isPro?: boolean
  showProBadge?: boolean
}): React.ReactNode {
  const size = isReply ? 24 : 32
  const href = handle ? `/u/${encodeURIComponent(handle)}` : '#'

  return (
    <Link href={href} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none', flexShrink: 0, position: 'relative' }}>
      {avatarUrl ? (
        <Image src={avatarUrl.startsWith('data:') ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`} alt={`${handle || 'User'} avatar`} width={size} height={size} sizes={`${size}px`} loading="lazy" unoptimized style={commentStyles.avatar(size)} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
      ) : (
        <div style={commentStyles.avatarPlaceholder(size)}>
          {(handle?.[0] || 'A').toUpperCase()}
        </div>
      )}
      {isPro && showProBadge !== false && <ProBadgeOverlay position="bottom-right" />}
    </Link>
  )
}
