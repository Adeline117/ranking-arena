'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import type { TraderPerformance } from '@/lib/data/trader'
import type { TraderFeedItem } from '@/lib/data/trader'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Group = {
  id: string
  name: string
  name_en?: string | null
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
  const router = useRouter()
  const { language } = useLanguage()

  const handleEditProfile = () => {
    router.push('/settings')
  }

  const handleViewPerformance = () => {
    // 跳转到交易员外部主页
    window.location.href = `/trader/${handle}?tab=overview&focus=performance`
  }

  return (
    <Box
      className="profile-grid"
      style={{
        display: 'grid',
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
                {language === 'zh' ? '详情 →' : 'Details →'}
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
              {language === 'zh' ? '动态' : 'Feed'}
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
            {language === 'zh' ? '徽章' : 'Badges'}
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
              {language === 'zh' ? 'VIP交易者' : 'VIP Trader'}
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
              {language === 'zh' ? '顶尖表现者' : 'Top Performer'}
            </Box>
          </Box>
          {isOwnProfile && (
            <Button variant="ghost" size="md" style={{ width: '100%', marginTop: tokens.spacing[4] }} onClick={handleEditProfile}>
              {language === 'zh' ? '编辑个人资料' : 'Edit Profile'}
            </Button>
          )}
        </Box>

        {/* Joined Groups */}
        <Box bg="secondary" p={6} radius="xl" border="primary">
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            {language === 'zh' ? '加入小组' : 'Joined Groups'}
          </Text>
          {groups.length === 0 ? (
            <Text size="sm" color="tertiary">
              {language === 'zh' ? '暂未加入任何小组' : 'Not joined any groups yet'}
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
                      {language === 'zh' ? group.name : (group.name_en || group.name)}
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

