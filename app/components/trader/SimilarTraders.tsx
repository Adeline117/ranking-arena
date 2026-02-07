'use client'

import { useState, useEffect, useCallback, memo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
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
          src={avatarUrl} 
          alt={handle} 
          fill
          unoptimized
          style={{ 
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
        />
      )}
      {showFallback && (
        <Text 
          size="sm" 
          weight="black" 
          style={{ 
            color: '#ffffff',
            textShadow: '0 1px 3px rgba(0, 0, 0, 0.4)',
            fontSize: `${Math.round(size * 0.4)}px`,
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
})

export default function SimilarTraders({ traders }: SimilarTradersProps) {
  const [mounted, setMounted] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const { t } = useLanguage()

  useEffect(() => {
    setMounted(true)
  }, [])

  if (traders.length === 0) return null

  return (
    <Box 
      className="similar-traders glass-card"
      style={{
        background: `linear-gradient(165deg, ${tokens.colors.bg.secondary}F0 0%, ${tokens.colors.bg.primary}E8 100%)`,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[5],
        boxShadow: `0 4px 20px rgba(0, 0, 0, 0.1)`,
        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
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
            {traders.length}
          </Text>
        </Box>
      </Box>
      
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {traders.slice(0, 6).map((trader, index) => (
          <Link key={trader.handle} href={`/trader/${trader.handle}`} style={{ textDecoration: 'none' }}>
            <Box
              className="similar-trader-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                background: hoveredIndex === index 
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}10, ${tokens.colors.bg.tertiary})`
                  : tokens.colors.bg.primary,
                border: `1px solid ${hoveredIndex === index ? tokens.colors.accent.primary + '40' : tokens.colors.border.primary}`,
                cursor: 'pointer',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                transform: hoveredIndex === index ? 'translateX(6px)' : 'translateX(0)',
                opacity: mounted ? 1 : 0,
                animationDelay: `${index * 0.05}s`,
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <AnimatedAvatar 
                avatarUrl={trader.avatar_url}
                handle={trader.handle}
                traderId={trader.id}
                size={40}
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
                  }}
                >
                  {(() => {
                    const handle = trader.handle || ''
                    if (handle.startsWith('0x') && handle.length > 20) {
                      return `${handle.substring(0, 6)}...${handle.substring(handle.length - 4)}`
                    }
                    return handle
                  })()}
                </Text>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                  {/* ROI Badge */}
                  {trader.roi_90d != null && (
                    <Box
                      style={{
                        background: trader.roi_90d >= 0 ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
                        padding: `1px ${tokens.spacing[1]}`,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      <Text
                        size="xs"
                        weight="bold"
                        style={{
                          color: trader.roi_90d >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                          fontSize: '10px',
                        }}
                      >
                        {trader.roi_90d >= 0 ? '+' : ''}{trader.roi_90d.toFixed(1)}%
                      </Text>
                    </Box>
                  )}
                  {/* Arena Score Badge */}
                  {trader.arena_score != null && (
                    <Box
                      style={{
                        background: `${tokens.colors.accent.primary}15`,
                        padding: `1px ${tokens.spacing[1]}`,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      <Text
                        size="xs"
                        weight="bold"
                        style={{
                          color: tokens.colors.accent.primary,
                          fontSize: '10px',
                        }}
                      >
                        {trader.arena_score.toFixed(0)}
                      </Text>
                    </Box>
                  )}
                  {/* Followers */}
                  <Text
                    size="xs"
                    color="tertiary"
                    style={{
                      fontWeight: tokens.typography.fontWeight.medium,
                    }}
                  >
                    {trader.followers?.toLocaleString() || 0} {t('fans')}
                  </Text>
                </Box>
              </Box>
              
              {/* Arrow indicator */}
              <Box
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: tokens.radius.full,
                  background: hoveredIndex === index ? tokens.colors.accent.primary : tokens.colors.bg.tertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.3s ease',
                  transform: hoveredIndex === index ? 'translateX(0)' : 'translateX(-4px)',
                  opacity: hoveredIndex === index ? 1 : 0.5,
                }}
              >
                <Text 
                  size="xs" 
                  style={{ 
                    color: hoveredIndex === index ? '#fff' : tokens.colors.text.tertiary,
                    lineHeight: 1,
                  }}
                >
                  →
                </Text>
              </Box>
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}
