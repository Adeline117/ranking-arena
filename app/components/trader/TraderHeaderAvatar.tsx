'use client'

import { useState } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
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
 * 48×48 trader avatar with hover lift, gradient placeholder, blockie
 * fallback for wallet addresses, and Pro badge overlay.
 *
 * Self-contained: hover/load/error state lives here so the parent
 * TraderHeader doesn't have to wire setters.
 *
 * Click scrolls the page back to the top — historically this was the
 * cheapest "reset view" affordance on long trader pages.
 */
export function TraderHeaderAvatar({
  traderId,
  handle,
  avatarUrl,
  claimedAvatarUrl,
  proBadgeTier,
}: TraderHeaderAvatarProps) {
  const [hovered, setHovered] = useState(false)
  const [errored, setErrored] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const effectiveAvatarUrl = claimedAvatarUrl || avatarUrl

  return (
    <Box
      style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Box
        className="profile-header-avatar"
        style={{
          width: 48,
          height: 48,
          borderRadius: tokens.radius.full,
          // Always use the gradient as background — it shows through as a blur
          // placeholder until the real avatar image loads (and then gets covered).
          background: getAvatarGradient(traderId),
          border: `2px solid ${hovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
          display: 'grid',
          placeItems: 'center',
          fontWeight: tokens.typography.fontWeight.black,
          fontSize: tokens.typography.fontSize.base,
          color: tokens.colors.white,
          overflow: 'hidden',
          boxShadow: hovered
            ? `0 4px 16px var(--color-accent-primary-40)`
            : `0 2px 8px var(--color-overlay-light)`,
          transition: 'all 0.3s ease',
          transform: hovered ? 'scale(1.05)' : 'scale(1)',
          cursor: 'pointer',
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
            src={`/api/avatar?url=${encodeURIComponent(effectiveAvatarUrl)}`}
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
          // eslint-disable-next-line @next/next/no-img-element -- blockie is a data URI
          <img
            src={generateBlockieSvg(traderId, 96)}
            alt={handle}
            width={48}
            height={48}
            style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
          />
        ) : (
          <Text weight="black" style={{ color: tokens.colors.white, fontSize: '20px', lineHeight: '1' }}>
            {getAvatarInitial(handle)}
          </Text>
        )}
      </Box>
      {proBadgeTier === 'pro' && <ProBadgeOverlay position="bottom-right" />}
    </Box>
  )
}
