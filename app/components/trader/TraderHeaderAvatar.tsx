'use client'

import { useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import {
  getAvatarGradient,
  getAvatarInitial,
  isWalletAddress,
  generateBlockieSvg,
} from '@/lib/utils/avatar'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import { ProBadgeOverlay } from '../ui/ProBadge'

interface TraderHeaderAvatarProps {
  /** Stable trader identity used for the gradient and blockie fallback */
  traderId: string
  /** Display name used as alt text and the initial-letter fallback */
  handle: string
  /** Exchange-supplied avatar URL — fallback when claimedAvatarUrl is null */
  avatarUrl?: string
  /** Avatar from a claimed user profile — preferred over the exchange one */
  claimedAvatarUrl?: string | null
  /** Pro badge overlay (bottom-right corner) when set to 'pro' */
  proBadgeTier?: 'pro' | null
}

/**
 * Static 48×48 trader avatar with a gradient placeholder, blockie fallback
 * for wallet addresses, and Pro badge overlay.
 *
 * Load/error state stays local so the parent TraderHeader does not have to
 * wire image setters. The avatar is identity content, not an action.
 */
export function TraderHeaderAvatar({
  traderId,
  handle,
  avatarUrl,
  claimedAvatarUrl,
  proBadgeTier,
}: TraderHeaderAvatarProps) {
  const [errored, setErrored] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const effectiveAvatarUrl = claimedAvatarUrl || avatarUrl

  return (
    <Box style={{ position: 'relative', flexShrink: 0 }}>
      <Box
        className="profile-header-avatar"
        style={{
          width: 48,
          height: 48,
          borderRadius: tokens.radius.full,
          // Always use the gradient as background — it shows through as a blur
          // placeholder until the real avatar image loads (and then gets covered).
          background: getAvatarGradient(traderId),
          border: `2px solid ${tokens.colors.border.primary}`,
          display: 'grid',
          placeItems: 'center',
          fontWeight: tokens.typography.fontWeight.black,
          fontSize: tokens.typography.fontSize.base,
          color: tokens.colors.white,
          overflow: 'hidden',
          boxShadow: `0 2px 8px var(--color-overlay-light)`,
          position: 'relative',
        }}
      >
        {/* Initial letter shows behind the avatar until it loads */}
        {effectiveAvatarUrl && !errored && !loaded && (
          <Text
            weight="black"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: tokens.colors.white,
              fontSize: '20px',
              lineHeight: '1',
              pointerEvents: 'none',
            }}
          >
            {getAvatarInitial(handle)}
          </Text>
        )}
        {effectiveAvatarUrl && !errored ? (
          <Image
            src={avatarSrc(effectiveAvatarUrl)}
            alt={handle}
            width={48}
            height={48}
            sizes="(max-width: 640px) 40px, 48px"
            priority
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              position: 'relative',
              opacity: loaded ? 1 : 0,
              transition: 'opacity 0.3s ease-out',
            }}
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
          />
        ) : isWalletAddress(traderId) ? (
          <img
            src={generateBlockieSvg(traderId, 96)}
            alt={handle}
            width={48}
            height={48}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              imageRendering: 'pixelated',
            }}
          />
        ) : (
          <Text
            weight="black"
            style={{ color: tokens.colors.white, fontSize: '20px', lineHeight: '1' }}
          >
            {getAvatarInitial(handle)}
          </Text>
        )}
      </Box>
      {proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
    </Box>
  )
}
