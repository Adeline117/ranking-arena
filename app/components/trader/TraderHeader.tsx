'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../Base'
import FollowButton from '../UI/FollowButton'
import ClaimTraderButton from './ClaimTraderButton'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'

interface TraderHeaderProps {
  handle: string
  traderId: string
  avatarUrl?: string
  isRegistered?: boolean
  followers?: number // 粉丝数 - 仅来自 Arena 注册用户的关注（trader_follows 表统计）
  isOwnProfile?: boolean
  source?: string // 'binance', 'bybit', etc.
}

export default function TraderHeader({ handle, traderId, avatarUrl, isRegistered, followers = 0, isOwnProfile = false, source }: TraderHeaderProps) {
  const [userId, setUserId] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  return (
    <Box
      className="profile-header"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: tokens.spacing[8],
        paddingBottom: tokens.spacing[6],
        paddingTop: tokens.spacing[4],
        borderBottom: `2px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        padding: tokens.spacing[6],
        boxShadow: tokens.shadow.sm,
      }}
    >
      {/* 左侧：Avatar + Handle */}
      <Box className="profile-header-info" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], flex: 1 }}>
        <Box
          className="profile-header-avatar"
          style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.full,
            background: avatarUrl ? tokens.colors.bg.secondary : getAvatarGradient(traderId),
            border: `2px solid ${tokens.colors.border.primary}`,
            display: 'grid',
            placeItems: 'center',
            fontWeight: tokens.typography.fontWeight.black,
            fontSize: tokens.typography.fontSize.xl,
            color: '#ffffff',
            overflow: 'hidden',
            flexShrink: 0,
            boxShadow: tokens.shadow.md,
            transition: `all ${tokens.transition.base}`,
            position: 'relative',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.05)'
            e.currentTarget.style.boxShadow = tokens.shadow.lg
            e.currentTarget.style.borderColor = tokens.colors.accent.primary
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)'
            e.currentTarget.style.boxShadow = tokens.shadow.md
            e.currentTarget.style.borderColor = tokens.colors.border.primary
          }}
        >
          {avatarUrl ? (
            <img 
              src={avatarUrl} 
              alt={handle} 
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
                // 隐藏图片，显示首字母
                if (e.target) {
                  (e.target as HTMLImageElement).style.display = 'none'
                  const container = e.currentTarget.parentElement
                  if (container) {
                    container.style.background = getAvatarGradient(traderId)
                  }
                }
              }}
            />
          ) : null}
          {!avatarUrl && (
            <Text 
              size="2xl" 
              weight="black" 
              style={{ 
                color: '#ffffff',
                textShadow: '0 2px 4px rgba(0, 0, 0, 0.4)',
                fontSize: '28px',
                lineHeight: '1',
              }}
            >
              {getAvatarInitial(handle)}
            </Text>
          )}
        </Box>

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text 
            size="2xl" 
            weight="black" 
            style={{ 
              marginBottom: tokens.spacing[2],
              color: tokens.colors.text.primary,
              lineHeight: tokens.typography.lineHeight.tight,
            }}
          >
            {handle}
          </Text>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
            <Text size="sm" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.semibold }}>
              {followers.toLocaleString()} 粉丝
            </Text>
            {source && (
              <Box
                style={{
                  padding: `2px ${tokens.spacing[2]}`,
                  background: `${tokens.colors.accent.primary}20`,
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.colors.accent.primary}40`,
                }}
              >
                <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary, textTransform: 'uppercase' }}>
                  {source}
                </Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* 右侧：Buttons */}
      <Box className="profile-header-actions" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
        {/* 退出按钮 */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push('/')}
          style={{
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          ← 返回
        </Button>
        
        {!isOwnProfile && (
          <>
            {!isRegistered && userId && (
              <ClaimTraderButton traderId={traderId} handle={handle} userId={userId} source={source} />
            )}
            {userId && <FollowButton traderId={traderId} userId={userId} />}
          </>
        )}
      </Box>
    </Box>
  )
}

