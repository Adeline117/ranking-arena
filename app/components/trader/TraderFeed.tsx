'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import type { TraderFeedItem } from '@/lib/data/trader'

interface TraderFeedProps {
  items: TraderFeedItem[]
  title: string
  showPostButton?: boolean
  onPostClick?: () => void
}

type SortType = 'all' | 'top'

export default function TraderFeed({ items, title, showPostButton = false, onPostClick }: TraderFeedProps) {
  const [sortType, setSortType] = useState<SortType>('all')

  // 排序逻辑
  const sortedItems = useMemo(() => {
    if (sortType === 'top') {
      return [...items].sort((a, b) => (b.like_count || 0) - (a.like_count || 0))
    }
    // all: 按时间最新排序
    return [...items].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  }, [items, sortType])

  return (
    <Box bg="secondary" p={6} radius="none" border="none">
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {title}
        </Text>
        {/* 排序按钮和发动态按钮 */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* 排序按钮 */}
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <button
              onClick={() => setSortType('all')}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${sortType === 'all' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: sortType === 'all' ? tokens.colors.accent.primary + '20' : tokens.colors.bg.primary,
                color: sortType === 'all' ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: sortType === 'all' ? tokens.typography.fontWeight.black : tokens.typography.fontWeight.normal,
                cursor: 'pointer',
              }}
            >
              All
            </button>
            <button
              onClick={() => setSortType('top')}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${sortType === 'top' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                background: sortType === 'top' ? tokens.colors.accent.primary + '20' : tokens.colors.bg.primary,
                color: sortType === 'top' ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: sortType === 'top' ? tokens.typography.fontWeight.black : tokens.typography.fontWeight.normal,
                cursor: 'pointer',
              }}
            >
              Top
            </button>
          </Box>
          {/* 发动态按钮 */}
          {showPostButton && onPostClick && (
            <button
              onClick={onPostClick}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: tokens.colors.accent.primary,
                color: tokens.colors.black,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.black,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = tokens.colors.text.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = tokens.colors.accent.primary
              }}
            >
              发动态
            </button>
          )}
        </Box>
      </Box>
      {items.length === 0 ? (
        <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">
            暂无动态
          </Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {sortedItems.map((item, idx) => (
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
                <Box style={{ flex: 1, display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Text size="sm" weight="black" style={{ color: tokens.colors.text.primary }}>
                    {item.title}
                  </Text>
                  {sortType === 'top' && item.like_count !== undefined && item.like_count > 0 && (
                    <Text size="xs" color="tertiary">
                      ❤️ {item.like_count}
                    </Text>
                  )}
                </Box>
                <Text size="xs" color="tertiary" style={{ marginLeft: tokens.spacing[2], flexShrink: 0 }}>
                  {new Date(item.time).toLocaleDateString('zh-CN')}
                </Text>
              </Box>
              {item.content && (
                <Text size="xs" color="secondary" style={{ lineHeight: 1.5 }}>
                  {item.content.slice(0, 120)}...
                </Text>
              )}
              {item.groupId && item.groupName && (
                <Link
                  href={`/groups/${item.groupId}`}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    display: 'block',
                    marginTop: tokens.spacing[2],
                    fontSize: tokens.typography.fontSize.xs,
                    color: '#8b6fa8',
                    textDecoration: 'none',
                  }}
                >
                  {item.groupName}
                </Link>
              )}
            </Box>
          </Link>
        ))}
      </Box>
      )}
    </Box>
  )
}

