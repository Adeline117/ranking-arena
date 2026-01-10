'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { getAvatarFallbackGradient, getAvatarInitial } from '@/lib/utils/avatar'
import type { TraderProfile } from '@/lib/data/trader'

interface SimilarTradersProps {
  traders: TraderProfile[]
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
              {/* 头像 - 优化UI，使用img标签 */}
              <Box
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: tokens.radius.full,
                  background: trader.avatar_url ? tokens.colors.bg.secondary : getAvatarFallbackGradient(trader.id),
                  border: `1.5px solid ${tokens.colors.border.primary}`,
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: tokens.typography.fontWeight.black,
                  fontSize: tokens.typography.fontSize.sm,
                  color: '#ffffff',
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
                {trader.avatar_url ? (
                  <img 
                    src={trader.avatar_url} 
                    alt={trader.handle} 
                    referrerPolicy="origin-when-cross-origin"
                    loading="lazy"
                    style={{ 
                      width: '100%', 
                      height: '100%', 
                      objectFit: 'cover',
                      transition: `opacity ${tokens.transition.base}`,
                      opacity: 0,
                    }}
                    onLoad={(e) => {
                      e.currentTarget.style.opacity = '1'
                    }}
                    onError={(e) => {
                      if (e.target) {
                        (e.target as HTMLImageElement).style.display = 'none'
                        const container = e.currentTarget.parentElement
                        if (container) {
                          container.style.background = getAvatarFallbackGradient(trader.id)
                        }
                      }
                    }}
                  />
                ) : null}
                {!trader.avatar_url && (
                  <Text 
                    size="sm" 
                    weight="black" 
                    style={{ 
                      color: '#ffffff',
                      textShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
                      fontSize: '16px',
                      lineHeight: '1',
                    }}
                  >
                    {getAvatarInitial(trader.handle)}
                  </Text>
                )}
              </Box>
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

