'use client'

import { useState, useCallback, useMemo, memo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial, isWalletAddress, generateBlockieSvg } from '@/lib/utils/avatar'
import { formatDisplayName, formatROI } from '@/app/components/ranking/utils'
import type { TraderProfile } from '@/lib/data/trader'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// Extended type for similar traders with performance metrics
interface SimilarTraderWithMetrics extends TraderProfile {
  roi_90d?: number
  arena_score?: number
}

interface SimilarTradersProps {
  traders: SimilarTraderWithMetrics[]
}

/**
 * 带动画的头像组件
 */
const AnimatedAvatar = memo(function AnimatedAvatar({
  avatarUrl,
  handle,
  traderId,
  size = 40
}: {
  avatarUrl?: string
  handle: string
  traderId: string
  size?: number
}) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const handleMouseEnter = useCallback(() => setIsHovered(true), [])
  const handleMouseLeave = useCallback(() => setIsHovered(false), [])

  const showFallback = !avatarUrl || imageError || !imageLoaded

  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        background: getAvatarGradient(traderId),
        border: `2px solid ${isHovered ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: isHovered ? `0 4px 12px ${tokens.colors.accent.primary}30` : tokens.shadow.sm,
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'relative',
        transform: isHovered ? 'scale(1.1)' : 'scale(1)',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {avatarUrl && !imageError && (
        <Image
          src={avatarUrl.startsWith("/") ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`}
          alt={handle}
          fill
          sizes="40px"
          loading="lazy"
          placeholder="empty"
          style={{
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: 'opacity 0.3s ease, filter 0.3s ease',
            filter: imageLoaded ? 'none' : 'blur(8px)',
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
        />
      )}
      {showFallback && isWalletAddress(traderId) ? (
        <img
          src={generateBlockieSvg(traderId, size * 2)}
          alt={handle}
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0, zIndex: 1, imageRendering: 'pixelated' }}
        />
      ) : showFallback ? (
        <Text
          size="sm"
          weight="black"
          style={{
            color: tokens.colors.white,
            textShadow: 'var(--text-shadow-md)',
            fontSize: `${Math.round(size * 0.4)}px`,
            lineHeight: '1',
            position: 'relative',
            zIndex: 1,
          }}
        >
          {getAvatarInitial(handle)}
        </Text>
      ) : null}
    </Box>
  )
})

function SimilarTradersInner({ traders }: SimilarTradersProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const { t } = useLanguage()

  // Deduplicate traders by both id+source AND handle (display name)
  // Some traders have multiple source_trader_ids on the same exchange
  const uniqueTraders = useMemo(() => {
    const seenIds = new Set<string>()
    const seenHandles = new Set<string>()
    return traders.filter(t => {
      const idKey = `${(t.id || t.handle).toLowerCase()}:${(t.source || '').toLowerCase()}`
      const handleKey = t.handle ? t.handle.toLowerCase() : ''
      if (seenIds.has(idKey)) return false
      if (handleKey && seenHandles.has(handleKey)) return false
      seenIds.add(idKey)
      if (handleKey) seenHandles.add(handleKey)
      return true
    })
  }, [traders])

  if (uniqueTraders.length === 0) return null

  return (
    <Box 
      className="similar-traders glass-card"
      style={{
        background: `linear-gradient(165deg, ${tokens.colors.bg.secondary}F0 0%, ${tokens.colors.bg.primary}E8 100%)`,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[5],
        boxShadow: `0 4px 20px var(--color-overlay-subtle)`,
        animation: 'fadeInUp 0.5s cubic-bezier(0.4, 0, 0.2, 1) forwards',
        opacity: 0,
      }}
    >
      <Box style={{ 
        display: 'flex', 
        alignItems: 'center', 
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[4],
        paddingBottom: tokens.spacing[3],
        borderBottom: `1px solid ${tokens.colors.border.primary}40`,
      }}>
        <Text
          size="base"
          weight="black"
          style={{
            color: tokens.colors.text.primary,
          }}
        >
          {t('similarTraders')}
        </Text>
        <Box
          style={{
            marginLeft: 'auto',
            background: `${tokens.colors.accent.primary}15`,
            padding: `2px ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.full,
          }}
        >
          <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary }}>
            {uniqueTraders.length}
          </Text>
        </Box>
      </Box>
      
      <Box className="similar-traders-grid" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {uniqueTraders.slice(0, 6).map((trader, index) => (
          <Link key={trader.handle} href={`/trader/${encodeURIComponent(trader.id || trader.handle)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''}`} style={{ textDecoration: 'none' }}>
            <Box
              className="similar-trader-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                background: hoveredIndex === index 
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}10, ${tokens.colors.bg.tertiary})`
                  : tokens.colors.bg.primary,
                border: `1px solid ${hoveredIndex === index ? tokens.colors.accent.primary + '40' : tokens.colors.border.primary}30`,
                cursor: 'pointer',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                transform: hoveredIndex === index ? 'translateX(4px)' : 'translateX(0)',
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <AnimatedAvatar 
                avatarUrl={trader.avatar_url}
                handle={trader.handle}
                traderId={trader.id}
                size={36}
              />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text
                  size="sm"
                  weight="bold"
                  style={{
                    color: tokens.colors.text.primary,
                    marginBottom: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 13,
                  }}
                >
                  {trader.display_name || formatDisplayName(trader.handle || '', trader.source)}
                </Text>
                <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {trader.roi_90d != null && (
                    <Text
                      size="xs"
                      weight="bold"
                      style={{
                        color: trader.roi_90d >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                        fontSize: 11,
                        fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        letterSpacing: '-0.02em',
                      }}
                    >
                      {formatROI(trader.roi_90d)}
                    </Text>
                  )}
                  {trader.arena_score != null && (
                    <Text
                      size="xs"
                      weight="bold"
                      style={{
                        color: tokens.colors.text.tertiary,
                        fontSize: 11,
                        fontFamily: tokens.typography.fontFamily.mono.join(', '),
                      }}
                    >
                      {trader.arena_score.toFixed(0)}
                    </Text>
                  )}
                </Box>
              </Box>
              
              <Text 
                size="xs" 
                style={{ 
                  color: hoveredIndex === index ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                  transition: 'color 0.2s ease',
                  fontSize: 14,
                }}
              >
                →
              </Text>
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}

const SimilarTraders = memo(SimilarTradersInner)
export default SimilarTraders
