'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
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
              <Box
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: tokens.radius.full,
                  background: tokens.colors.bg.secondary,
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: tokens.typography.fontWeight.black,
                  fontSize: tokens.typography.fontSize.base,
                  color: tokens.colors.text.primary,
                }}
              >
                {(trader.handle?.[0] ?? 'T').toUpperCase()}
              </Box>
              <Box style={{ flex: 1 }}>
                <Text size="sm" weight="bold">
                  {trader.handle}
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

