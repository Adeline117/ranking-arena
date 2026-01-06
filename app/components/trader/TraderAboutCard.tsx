'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'

interface TraderAboutCardProps {
  handle: string
  avatarUrl?: string
  bio?: string
  followers?: number
  isRegistered?: boolean
  isOwnProfile?: boolean
}

/**
 * 交易员卡片 - 右侧固定卡片
 * 头像、一句话定位、关注按钮
 */
export default function TraderAboutCard({
  handle,
  avatarUrl,
  bio,
  followers = 0,
  isRegistered,
  isOwnProfile = false,
}: TraderAboutCardProps) {
  const [isFollowing, setIsFollowing] = useState(false)
  const router = useRouter()

  return (
    <Box
      bg="secondary"
      p={6}
      radius="none"
      border="none"
      style={{
        position: 'sticky',
        top: 80, // 在TopNav下方
      }}
    >
      {/* 头像 */}
      <Box
        style={{
          width: 72,
          height: 72,
          borderRadius: tokens.radius.full,
          background: tokens.colors.bg.primary,
          border: `1px solid ${tokens.colors.border.primary}`,
          display: 'grid',
          placeItems: 'center',
          marginBottom: tokens.spacing[4],
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={handle} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <Text size="2xl" weight="black" style={{ color: tokens.colors.text.primary }}>
            {(handle?.[0] ?? 'T').toUpperCase()}
          </Text>
        )}
      </Box>

      {/* 交易员ID */}
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[3], color: tokens.colors.text.primary }}>
        {handle}
      </Text>

      {/* 一句话定位（bio截取前50字符） */}
      {bio && (
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4], lineHeight: 1.5 }}>
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
      ) : (
        <Button
          variant={isFollowing ? 'secondary' : 'primary'}
          size="md"
          fullWidth
          onClick={() => setIsFollowing(!isFollowing)}
          style={{
            marginBottom: tokens.spacing[4],
            fontWeight: tokens.typography.fontWeight.black,
          }}
        >
          {isFollowing ? '已关注' : '关注'}
        </Button>
      )}

      {/* 次要信息 */}
      <Box
        style={{
          paddingTop: tokens.spacing[3],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
          关注者
        </Text>
        <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
          {followers.toLocaleString()}
        </Text>
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
