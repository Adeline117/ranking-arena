'use client'

import { useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'

interface TraderHeaderProps {
  handle: string
  avatarUrl?: string
  isRegistered?: boolean
  followers?: number
}

export default function TraderHeader({ handle, avatarUrl, isRegistered, followers = 0 }: TraderHeaderProps) {
  const [isFollowing, setIsFollowing] = useState(false)

  return (
    <Box
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
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4] }}>
        <Box
          style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.full,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            display: 'grid',
            placeItems: 'center',
            fontWeight: tokens.typography.fontWeight.black,
            fontSize: tokens.typography.fontSize.xl,
            color: tokens.colors.text.primary,
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt={handle} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            (handle?.[0] ?? 'T').toUpperCase()
          )}
        </Box>

        <Box>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[1] }}>
            {handle}
          </Text>
          <Text size="sm" color="secondary">
            {followers.toLocaleString()} 粉丝
          </Text>
        </Box>
      </Box>

      {/* 右侧：Buttons - 最小化 */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
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
      </Box>
    </Box>
  )
}

