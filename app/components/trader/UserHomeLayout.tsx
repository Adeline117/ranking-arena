'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
import type { TraderPerformance } from '@/lib/data/trader'
import type { TraderFeedItem } from '@/lib/data/trader'
type Group = {
  id: string
  name: string
}

interface UserHomeLayoutProps {
  userId: string
  handle: string
  avatarUrl?: string
  bio?: string
  followers?: number
  following?: number
  performance?: TraderPerformance
  feed?: TraderFeedItem[]
  groups?: Group[]
  isOwnProfile?: boolean
}

export default function UserHomeLayout({
  handle,
  performance,
  feed = [],
  groups = [],
  isOwnProfile = false,
}: UserHomeLayoutProps) {
  const handleViewPerformance = () => {
    // 跳转到交易员外部主页
    window.location.href = `/trader/${handle}?tab=overview&focus=performance`
  }

  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 320px',
        gap: tokens.spacing[6],
      }}
    >
      {/* Left Column */}
      <Box>
        {/* Performance Card */}
        {performance && (
          <Box bg="secondary" p={6} radius="xl" border="primary" style={{ marginBottom: tokens.spacing[6] }}>
            <Box
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: tokens.spacing[4],
              }}
            >
              <Text size="lg" weight="black">
                Performance
              </Text>
              <Button variant="ghost" size="sm" onClick={handleViewPerformance}>
                详情 →
              </Button>
            </Box>
            <Box>
              <Text size="2xl" weight="black" style={{ color: (performance.roi_90d || 0) >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
                {(performance.roi_90d || 0) >= 0 ? '+' : ''}
                {(performance.roi_90d || 0).toFixed(2)}%
              </Text>
              <Text size="sm" color="tertiary">
                ROI (90D)
              </Text>
            </Box>
          </Box>
        )}

        {/* Feed */}
        {feed.length > 0 && (
          <Box bg="secondary" p={6} radius="xl" border="primary">
            <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
              动态
            </Text>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {feed.map((item) => (
                <Link
                  key={item.id}
                  href={item.groupId ? `/groups/${item.groupId}` : `/posts/${item.id}`}
                  style={{ textDecoration: 'none' }}
                >
                  <Box
                    bg="primary"
                    p={4}
                    radius="lg"
                    border="secondary"
                    style={{
                      transition: `all ${tokens.transition.base}`,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                      e.currentTarget.style.borderColor = tokens.colors.border.primary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.primary
                      e.currentTarget.style.borderColor = tokens.colors.border.secondary
                    }}
                  >
                    <Text size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                      {item.title}
                    </Text>
                    {item.content && (
                      <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                        {item.content.slice(0, 150)}...
                      </Text>
                    )}
                    <Text size="xs" color="tertiary" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {new Date(item.time).toLocaleDateString('zh-CN')}
                      {item.groupId && item.groupName && (
                        <>
                          {' · '}
                          <Link
                            href={`/groups/${item.groupId}`}
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: '#8b6fa8', textDecoration: 'none' }}
                          >
                            {item.groupName}
                          </Link>
                        </>
                      )}
                    </Text>
                  </Box>
                </Link>
              ))}
            </Box>
          </Box>
        )}
      </Box>

      {/* Right Column */}
      <Box>
        {/* Badges */}
        <Box bg="secondary" p={6} radius="xl" border="primary" style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            徽章
          </Text>
          <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
            <Box
              bg="primary"
              px={3}
              py={2}
              radius="md"
              border="secondary"
              style={{
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
              }}
            >
              💎 VIP交易者
            </Box>
            <Box
              bg="primary"
              px={3}
              py={2}
              radius="md"
              border="secondary"
              style={{
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.bold,
              }}
            >
              🔥 顶尖表现者
            </Box>
          </Box>
          {isOwnProfile && (
            <Button variant="ghost" size="md" style={{ width: '100%', marginTop: tokens.spacing[4] }} onClick={() => alert('编辑个人资料')}>
              编辑个人资料
            </Button>
          )}
        </Box>

        {/* Joined Groups */}
        <Box bg="secondary" p={6} radius="xl" border="primary">
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            加入小组
          </Text>
          {groups.length === 0 ? (
            <Text size="sm" color="tertiary">
              暂未加入任何小组
            </Text>
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {groups.map((group) => (
                <Link key={group.id} href={`/groups/${group.id}`} style={{ textDecoration: 'none' }}>
                  <Box
                    bg="primary"
                    p={4}
                    radius="lg"
                    border="secondary"
                    style={{
                      transition: `all ${tokens.transition.base}`,
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.secondary
                      e.currentTarget.style.borderColor = tokens.colors.border.primary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = tokens.colors.bg.primary
                      e.currentTarget.style.borderColor = tokens.colors.border.secondary
                    }}
                  >
                    <Text size="base" weight="bold">
                      {group.name}
                    </Text>
                  </Box>
                </Link>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

