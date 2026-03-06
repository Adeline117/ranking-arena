'use client'

import React, { useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { ProBadgeOverlay } from '../ui/ProBadge'

interface TraderHeaderAvatarProps {
  handle: string
  traderId: string
  avatarUrl?: string
  proBadgeTier?: 'pro' | null
}

export function TraderHeaderAvatar({
  handle,
  traderId,
  avatarUrl,
  proBadgeTier,
}: TraderHeaderAvatarProps): React.ReactElement {
  const [avatarHovered, setAvatarHovered] = useState(false)
  const [avatarError, setAvatarError] = useState(false)

  return (
    <Box
      style={{
        position: 'relative',
        flexShrink: 0,
      }}
      onMouseEnter={() => setAvatarHovered(true)}
      onMouseLeave={() => setAvatarHovered(false)}
    >
      <Box
        className="profile-header-avatar"
        style={{
          width: 72,
          height: 72,
          borderRadius: tokens.radius.full,
          background: avatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(traderId),
          border: `3px solid ${avatarHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
          display: 'grid',
          placeItems: 'center',
          fontWeight: tokens.typography.fontWeight.black,
          fontSize: tokens.typography.fontSize.xl,
          color: tokens.colors.white,
          overflow: 'hidden',
          boxShadow: avatarHovered
            ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${tokens.colors.accent.primary}20`
            : `0 4px 16px var(--color-overlay-light)`,
          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          transform: avatarHovered ? 'scale(1.08)' : 'scale(1)',
          cursor: 'pointer',
        }}
      >
        {avatarUrl && !avatarError ? (
          <Image
            src={`/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
            alt={handle}
            width={72}
            height={72}
            sizes="72px"
            priority
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transition: 'all 0.4s ease',
            }}
            onError={() => setAvatarError(true)}
          />
        ) : (
          <Text
            size="2xl"
            weight="black"
            style={{
              color: tokens.colors.white,
              textShadow: 'var(--text-shadow-md)',
              fontSize: '32px',
              lineHeight: '1',
            }}
          >
            {getAvatarInitial(handle)}
          </Text>
        )}
      </Box>
      {/* Pro badge positioned outside avatar to avoid overflow:hidden clipping */}
      {proBadgeTier === 'pro' && (
        <ProBadgeOverlay position="bottom-right" />
      )}
    </Box>
  )
}
