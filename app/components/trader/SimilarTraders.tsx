'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { getAvatarFallbackGradient, getAvatarInitial } from '@/lib/utils/avatar'
import type { TraderProfile } from '@/lib/data/trader'

interface SimilarTradersProps {
  traders: TraderProfile[]
}

/**
 * 带 fallback 的头像组件
 * 解决头像图片加载时首字母和图片同时显示的问题
 */
function AvatarWithFallback({ 
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
  
  const showFallback = !avatarUrl || imageError || !imageLoaded
  
  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        background: getAvatarFallbackGradient(traderId),
        border: `1.5px solid ${tokens.colors.border.primary}`,
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        boxShadow: tokens.shadow.sm,
        transition: `all ${tokens.transition.base}`,
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.08)'
        e.currentTarget.style.boxShadow = tokens.shadow.md
        e.currentTarget.style.borderColor = tokens.colors.accent.primary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)'
        e.currentTarget.style.boxShadow = tokens.shadow.sm
        e.currentTarget.style.borderColor = tokens.colors.border.primary
      }}
    >
      {/* 头像图片 - 始终渲染但根据状态显示/隐藏 */}
      {avatarUrl && !imageError && (
        <img 
          src={avatarUrl} 
          alt={handle} 
          referrerPolicy="origin-when-cross-origin"
          loading="lazy"
          style={{ 
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%', 
            height: '100%', 
            objectFit: 'cover',
            opacity: imageLoaded ? 1 : 0,
            transition: `opacity ${tokens.transition.base}`,
          }}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageError(true)}
        />
      )}
      {/* 首字母 fallback - 只在需要时显示 */}
      {showFallback && (
        <Text 
          size="sm" 
          weight="black" 
          style={{ 
            color: '#ffffff',
            textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
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
}

export default function SimilarTraders({ traders }: SimilarTradersProps) {
  if (traders.length === 0) return null

  return (
    <Box 
      bg="secondary" 
      p={6} 
      radius="xl" 
      border="primary"
      style={{
        boxShadow: tokens.shadow.md,
        transition: `all ${tokens.transition.base}`,
      }}
    >
      <Text 
        size="lg" 
        weight="black" 
        style={{ 
          marginBottom: tokens.spacing[5],
          color: tokens.colors.text.primary,
          paddingBottom: tokens.spacing[3],
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        相似交易员
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
        {traders.slice(0, 6).map((trader) => (
          <Link key={trader.handle} href={`/trader/${trader.handle}`} style={{ textDecoration: 'none' }}>
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
                boxShadow: tokens.shadow.xs,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.tertiary || tokens.colors.bg.hover || `${tokens.colors.bg.secondary}CC`
                e.currentTarget.style.transform = 'translateX(4px)'
                e.currentTarget.style.boxShadow = tokens.shadow.sm
                e.currentTarget.style.borderColor = tokens.colors.accent.primary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.primary
                e.currentTarget.style.transform = 'translateX(0)'
                e.currentTarget.style.boxShadow = tokens.shadow.xs
                e.currentTarget.style.borderColor = tokens.colors.border.primary
              }}
            >
              {/* 头像 */}
              <AvatarWithFallback 
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
                    marginBottom: tokens.spacing[1],
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {(() => {
                    // 如果是钱包地址（0x开头且长度>20），则缩写
                    const handle = trader.handle || ''
                    if (handle.startsWith('0x') && handle.length > 20) {
                      return `${handle.substring(0, 6)}...${handle.substring(handle.length - 4)}`
                    }
                    return handle
                  })()}
                </Text>
                <Text 
                  size="xs" 
                  color="tertiary"
                  style={{
                    fontWeight: tokens.typography.fontWeight.medium,
                  }}
                >
                  {/* 粉丝数来自 Arena 注册用户的关注（trader_follows 表统计） */}
                  {trader.followers?.toLocaleString() || 0} 粉丝
                </Text>
              </Box>
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}

