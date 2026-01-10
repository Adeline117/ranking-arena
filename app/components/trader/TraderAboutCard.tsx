'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../Base'
import FollowButton from '../UI/FollowButton'
import { getAvatarFallbackGradient, getAvatarInitial } from '@/lib/utils/avatar'

interface TraderAboutCardProps {
  handle: string
  traderId?: string // 交易员ID，用于关注功能
  avatarUrl?: string
  bio?: string
  followers?: number // 关注他的人数量（粉丝数）- 仅来自 Arena 注册用户的关注（trader_follows 表统计）
  following?: number // 他关注的人数量
  isRegistered?: boolean
  isOwnProfile?: boolean
}

/**
 * 交易员卡片 - 右侧固定卡片
 * 头像、一句话定位、关注按钮
 */
export default function TraderAboutCard({
  handle,
  traderId,
  avatarUrl,
  bio,
  followers = 0,
  following = 0,
  isRegistered,
  isOwnProfile = false,
}: TraderAboutCardProps) {
  const [userId, setUserId] = useState<string | null>(null)
  const router = useRouter()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    })
  }, [])

  return (
    <Box
      bg="secondary"
      p={6}
      radius="lg"
      border="primary"
      style={{
        position: 'sticky',
        top: 80, // 在TopNav下方
        boxShadow: tokens.shadow.md,
        transition: `all ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.lg
        e.currentTarget.style.transform = 'translateY(-2px)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.md
        e.currentTarget.style.transform = 'translateY(0)'
      }}
    >
      {/* 头像 - 优化UI */}
      <Box
        style={{
          width: 72,
          height: 72,
          borderRadius: tokens.radius.full,
          background: avatarUrl ? tokens.colors.bg.secondary : getAvatarFallbackGradient(traderId || handle),
          border: `2px solid ${tokens.colors.border.primary}`,
          display: 'grid',
          placeItems: 'center',
          marginBottom: tokens.spacing[4],
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
                  container.style.background = getAvatarFallbackGradient(traderId || handle)
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
              fontSize: '32px',
              lineHeight: '1',
            }}
          >
            {getAvatarInitial(handle)}
          </Text>
        )}
      </Box>

      {/* 交易员ID */}
      <Text 
        size="lg" 
        weight="black" 
        style={{ 
          marginBottom: tokens.spacing[2], 
          color: tokens.colors.text.primary,
          lineHeight: tokens.typography.lineHeight.tight,
        }}
      >
        {handle}
      </Text>

      {/* 一句话定位（bio截取前50字符） */}
      {bio && (
        <Text 
          size="sm" 
          color="secondary" 
          style={{ 
            marginBottom: tokens.spacing[4], 
            lineHeight: tokens.typography.lineHeight.relaxed,
            padding: tokens.spacing[3],
            background: tokens.colors.bg.primary,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          {bio.length > 50 ? bio.slice(0, 50) + '...' : bio}
        </Text>
      )}

      {/* 关注按钮/编辑个人资料按钮 - 主要操作 */}
      {isOwnProfile ? (
        <Button
          variant="primary"
          size="md"
          fullWidth
          onClick={() => router.push('/settings')}
          style={{
            marginBottom: tokens.spacing[4],
            fontWeight: tokens.typography.fontWeight.black,
          }}
        >
          编辑个人资料
        </Button>
      ) : traderId && userId ? (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <FollowButton traderId={traderId} userId={userId} />
        </Box>
      ) : null}

      {/* 次要信息 */}
      <Box
        style={{
          paddingTop: tokens.spacing[4],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          gap: tokens.spacing[6],
        }}
      >
        <Box style={{ flex: 1 }}>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1], fontWeight: tokens.typography.fontWeight.medium }}>
            关注者
          </Text>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg }}>
            {followers.toLocaleString()}
          </Text>
        </Box>
        {following !== undefined && (
          <Box style={{ flex: 1 }}>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1], fontWeight: tokens.typography.fontWeight.medium }}>
              关注中
            </Text>
            <Text size="base" weight="bold" style={{ color: tokens.colors.text.primary, fontSize: tokens.typography.fontSize.lg }}>
              {following.toLocaleString()}
            </Text>
          </Box>
        )}
      </Box>

      {/* 如果是注册用户，显示主页链接 */}
      {isRegistered && (
        <Box style={{ marginTop: tokens.spacing[3] }}>
          <Link href={`/u/${handle}`} style={{ textDecoration: 'none' }}>
            <Text
              size="sm"
              weight="bold"
              style={{
                color: tokens.colors.text.secondary,
                textDecoration: 'underline',
              }}
            >
              查看主页 →
            </Text>
          </Link>
        </Box>
      )}
    </Box>
  )
}
