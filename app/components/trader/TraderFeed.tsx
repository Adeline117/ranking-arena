'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { TraderFeedItem } from '@/lib/data/trader'

interface TraderFeedProps {
  items: TraderFeedItem[]
  title: string
}

export default function TraderFeed({ items, title }: TraderFeedProps) {
  if (items.length === 0) return null

  // 交易员动态 - 系统生成内容为主，标记为认证交易员
  const isTraderActivity = title === '交易员动态'

  return (
    <Box bg="secondary" p={6} radius="none" border="none">
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {title}
        </Text>
        {isTraderActivity && (
          <Text
            size="xs"
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              background: tokens.colors.bg.primary,
              borderRadius: tokens.radius.sm,
              color: tokens.colors.text.tertiary,
              fontWeight: tokens.typography.fontWeight.normal,
            }}
          >
            认证交易员
          </Text>
        )}
      </Box>
      <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {items.map((item, idx) => (
          <Link
            key={item.id}
            href={item.groupId ? `/groups/${item.groupId}` : `/posts/${item.id}`}
            style={{ textDecoration: 'none' }}
          >
            <Box
              style={{
                padding: tokens.spacing[4],
                background: tokens.colors.bg.primary,
                borderBottom: idx < items.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.bg.primary
              }}
            >
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                <Text size="sm" weight="black" style={{ flex: 1, color: tokens.colors.text.primary }}>
                  {item.title}
                </Text>
                <Text size="xs" color="tertiary" style={{ marginLeft: tokens.spacing[2], flexShrink: 0 }}>
                  {new Date(item.time).toLocaleDateString('zh-CN')}
                </Text>
              </Box>
              {item.content && (
                <Text size="xs" color="secondary" style={{ lineHeight: 1.5 }}>
                  {item.content.slice(0, 120)}...
                </Text>
              )}
              {item.groupName && (
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
                  {item.groupName}
                </Text>
              )}
            </Box>
          </Link>
        ))}
      </Box>
    </Box>
  )
}

