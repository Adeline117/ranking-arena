'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'
import { Box, Text, Button } from '../Base'
import FollowButton from '../UI/FollowButton'
import ClaimTraderButton from './ClaimTraderButton'
import Avatar from '../UI/Avatar'

interface TraderHeaderProps {
  handle: string
  traderId: string
  avatarUrl?: string
  isRegistered?: boolean
  followers?: number
  isOwnProfile?: boolean
  source?: string // 'binance', 'bybit', etc.
}

export default function TraderHeader({ handle, traderId, avatarUrl, isRegistered, followers = 0, isOwnProfile = false, source = 'binance' }: TraderHeaderProps) {
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
        marginBottom: tokens.spacing[6],
        paddingBottom: tokens.spacing[6],
        borderBottom: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {/* 左侧：Avatar + Handle */}
      <Box className="profile-header-info" style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], flex: 1 }}>
        {/* 统一使用 Avatar 组件，确保与排行榜显示一致 */}
        <Avatar
          userId={traderId}
          name={handle}
          avatarUrl={avatarUrl}
          size={64}
          isTrader={true}
        />

        <Box>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[1] }}>
            {handle}
          </Text>
          <Text size="sm" color="secondary">
            {followers.toLocaleString()} 粉丝
          </Text>
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
        
        {isOwnProfile ? (
          <Button
            variant="ghost"
            size="md"
            onClick={() => router.push('/settings')}
          >
            编辑个人资料
          </Button>
        ) : (
          <>
            {isRegistered && (
              <Link href={`/u/${handle}`} style={{ textDecoration: 'none' }}>
                <Text
                  size="sm"
                  weight="bold"
                  style={{
                    color: tokens.colors.text.secondary,
                    textDecoration: 'underline',
                  }}
                >
                  主页
                </Text>
              </Link>
            )}
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

