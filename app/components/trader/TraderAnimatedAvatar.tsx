'use client'

import { useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

export interface TraderAnimatedAvatarProps {
  avatarUrl?: string
  handle: string
  traderId: string
  size?: number
}

/**
 * Animated avatar with hover scale, glow ring, and letter fallback.
 */
export function TraderAnimatedAvatar({
  avatarUrl,
  handle,
  traderId,
  size = 80,
}: TraderAnimatedAvatarProps) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const showFallback = !avatarUrl || imageError || !imageLoaded

  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        background: getAvatarGradient(traderId),
        border: `3px solid ${isHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
        display: 'grid',
        placeItems: 'center',
        marginBottom: tokens.spacing[4],
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: isHovered
          ? `0 8px 32px var(--color-accent-primary-40), 0 0 0 4px ${tokens.colors.accent.primary}20`
          : tokens.shadow.lg,
        transition: `all ${tokens.transition.smooth}`,
        position: 'relative',
        transform: isHovered ? 'scale(1.08) rotate(2deg)' : 'scale(1) rotate(0deg)',
        cursor: 'pointer',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Glow ring */}
      <Box
        style={{
          position: 'absolute',
          inset: -4,
          borderRadius: tokens.radius.full,
          background: `conic-gradient(from 0deg, ${tokens.colors.accent.primary}00, ${tokens.colors.accent.primary}40, ${tokens.colors.accent.primary}00)`,
          opacity: isHovered ? 1 : 0,
          transition: 'opacity 0.4s ease',
          animation: isHovered ? 'spin 3s linear infinite' : 'none',
        }}
      />
      {/* Avatar image */}
      {avatarUrl && !imageError && (
        <Image
          src={avatarUrl.startsWith("/") ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
          alt={handle}
          fill
          sizes="64px"
          loading="lazy"
          style={{
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: 'opacity 0.4s ease',
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
        />
      )}
      {/* Letter fallback */}
      {showFallback && (
        <Text
          size="2xl"
          weight="black"
          style={{
            color: tokens.colors.white,
            textShadow: '0 2px 8px var(--color-overlay-dark)',
            fontSize: `${Math.round(size * 0.42)}px`,
            lineHeight: '1',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {getAvatarInitial(handle)}
        </Text>
      )}
    </Box>
  )
}
