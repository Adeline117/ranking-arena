'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { TraderFeedItem } from '@/lib/data/trader'

interface PinnedPostProps {
  item: TraderFeedItem
}

export default function PinnedPost({ item }: PinnedPostProps) {
  return (
    <Box
      bg="secondary"
      p={4}
      radius="lg"
      border="primary"
      style={{
        borderLeft: `3px solid ${tokens.colors.accent.primary}`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
        <Text size="xs" style={{ color: tokens.colors.accent.primary, fontWeight: tokens.typography.fontWeight.black }}>
          📌 置顶
        </Text>
      </Box>
      <Link
        href={item.groupId ? `/groups/${item.groupId}` : `/posts/${item.id}`}
        style={{ textDecoration: 'none' }}
      >
        <Text size="sm" weight="black" style={{ color: tokens.colors.text.primary, marginBottom: tokens.spacing[2], display: 'block' }}>
          {item.title}
        </Text>
        {item.content && (
          <Text size="xs" color="secondary" style={{ lineHeight: 1.5, display: 'block' }}>
            {item.content.slice(0, 150)}...
          </Text>
        )}
        {item.groupName && (
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2], display: 'block' }}>
            {item.groupName}
          </Text>
        )}
      </Link>
    </Box>
  )
}

