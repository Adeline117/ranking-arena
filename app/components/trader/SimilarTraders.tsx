'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import Avatar from '../UI/Avatar'
import type { TraderProfile } from '@/lib/data/trader'

interface SimilarTradersProps {
  traders: TraderProfile[]
}

export default function SimilarTraders({ traders }: SimilarTradersProps) {
  if (traders.length === 0) return null

  return (
    <Box bg="secondary" p={6} radius="xl" border="primary">
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        相似交易员
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {traders.slice(0, 6).map((trader) => (
          <Link key={trader.handle} href={`/trader/${trader.handle}`} style={{ textDecoration: 'none' }}>
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.none,
                background: tokens.colors.bg.primary,
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.primary
              }}
            >
              <Avatar
                userId={trader.id}
                name={trader.handle}
                avatarUrl={trader.avatar_url}
                size={40}
              />
              <Box style={{ flex: 1 }}>
                <Text size="sm" weight="bold">
                  {(() => {
                    // 如果是钱包地址（0x开头且长度>20），则缩写
                    const handle = trader.handle || ''
                    if (handle.startsWith('0x') && handle.length > 20) {
                      return `${handle.substring(0, 6)}...${handle.substring(handle.length - 4)}`
                    }
                    return handle
                  })()}
                </Text>
                <Text size="xs" color="tertiary">
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

