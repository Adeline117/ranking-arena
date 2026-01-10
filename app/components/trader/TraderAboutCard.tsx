'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../Base'
import FollowButton from '../UI/FollowButton'
import Avatar from '../UI/Avatar'

interface TraderAboutCardProps {
  handle: string
  traderId?: string // 交易员ID，用于关注功能
  avatarUrl?: string
  bio?: string
  followers?: number // 关注他的人数量（粉丝数）
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
      radius="none"
      border="none"
      style={{
        position: 'sticky',
        top: 80, // 在TopNav下方
      }}
    >
      {/* 头像 - 统一使用 Avatar 组件 */}
      <Box style={{ marginBottom: tokens.spacing[4] }}>
        <Avatar
          userId={traderId || handle}
          name={handle}
          avatarUrl={avatarUrl}
          size={72}
          isTrader={true}
        />
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
      ) : traderId && userId ? (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <FollowButton traderId={traderId} userId={userId} />
        </Box>
      ) : null}

      {/* 次要信息 */}
      <Box
        style={{
          paddingTop: tokens.spacing[3],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          gap: tokens.spacing[4],
        }}
      >
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
            关注者
          </Text>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
            {followers.toLocaleString()}
          </Text>
        </Box>
        {following !== undefined && (
          <Box>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
              关注中
            </Text>
            <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
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
