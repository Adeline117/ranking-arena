'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type ActivityItem = {
  id: string
  type: 'post' | 'book_rating' | 'follow_trader' | 'join_group'
  timestamp: string
  data: Record<string, any>
}

const ICONS: Record<string, string> = {
  post: '📝',
  book_rating: '📖',
  follow_trader: '👤',
  join_group: '👥',
}

function formatRelativeTime(ts: string, isZh: boolean): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return isZh ? '刚刚' : 'just now'
  if (mins < 60) return isZh ? `${mins}分钟前` : `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return isZh ? `${hours}小时前` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return isZh ? `${days}天前` : `${days}d ago`
  const months = Math.floor(days / 30)
  return isZh ? `${months}个月前` : `${months}mo ago`
}

function ActivityDescription({ item, isZh }: { item: ActivityItem; isZh: boolean }) {
  switch (item.type) {
    case 'post': {
      const group = item.data.group
      const groupName = isZh ? (group?.name || '') : (group?.name_en || group?.name || '')
      return (
        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
          {isZh ? '发表了帖子' : 'Published a post'}{' '}
          <Link href={`/groups/${item.data.postId}`} style={{ color: tokens.colors.accent.primary, textDecoration: 'none', fontWeight: 600 }}>
            {item.data.title || (isZh ? '无标题' : 'Untitled')}
          </Link>
          {groupName && (
            <span style={{ color: tokens.colors.text.tertiary }}>
              {' '}{isZh ? '在' : 'in'} {groupName}
            </span>
          )}
        </Text>
      )
    }
    case 'book_rating': {
      const book = item.data.book
      const statusMap: Record<string, { zh: string; en: string }> = {
        want_to_read: { zh: '想读', en: 'wants to read' },
        reading: { zh: '在读', en: 'is reading' },
        read: { zh: '读过', en: 'finished reading' },
      }
      const statusText = statusMap[item.data.status as string] || { zh: '评价了', en: 'rated' }
      return (
        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
          {isZh ? statusText.zh : statusText.en}{' '}
          <Link href={`/library/${item.data.itemId}`} style={{ color: tokens.colors.accent.primary, textDecoration: 'none', fontWeight: 600 }}>
            {book?.title || (isZh ? '一本书' : 'a book')}
          </Link>
          {item.data.rating && (
            <span style={{ color: tokens.colors.accent.warning, marginLeft: 4 }}>
              {'★'.repeat(item.data.rating as number)}
            </span>
          )}
        </Text>
      )
    }
    case 'follow_trader': {
      const trader = item.data.trader
      return (
        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
          {isZh ? '关注了交易员' : 'Followed trader'}{' '}
          <Link href={`/trader/${trader?.handle || item.data.traderId}`} style={{ color: tokens.colors.accent.primary, textDecoration: 'none', fontWeight: 600 }}>
            {trader?.display_name || trader?.handle || (isZh ? '未知' : 'Unknown')}
          </Link>
        </Text>
      )
    }
    case 'join_group': {
      const group = item.data.group
      const name = isZh ? (group?.name || '') : (group?.name_en || group?.name || '')
      return (
        <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
          {isZh ? '加入了小组' : 'Joined group'}{' '}
          <Link href={`/groups/${item.data.groupId}`} style={{ color: tokens.colors.accent.primary, textDecoration: 'none', fontWeight: 600 }}>
            {name || (isZh ? '未知小组' : 'Unknown group')}
          </Link>
        </Text>
      )
    }
    default:
      return null
  }
}

export default function ProfileActivityFeed({ handle }: { handle: string }) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [activities, setActivities] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/users/${encodeURIComponent(handle)}/activity?limit=15`)
      .then(r => r.json())
      .then(d => setActivities(d.activities || []))
      .catch(e => logger.error('[ProfileActivityFeed]', e))
      .finally(() => setLoading(false))
  }, [handle])

  if (loading) {
    return (
      <Box bg="secondary" p={4} radius="lg" border="primary">
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
          <Text size="lg" weight="black">🕐 {isZh ? '动态' : 'Activity'}</Text>
        </Box>
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {[1, 2, 3].map(i => (
            <Box key={i} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
              <Box className="skeleton" style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0 }} />
              <Box style={{ flex: 1 }}>
                <Box className="skeleton" style={{ height: 14, borderRadius: 4, width: `${70 - i * 10}%`, marginBottom: 6 }} />
                <Box className="skeleton" style={{ height: 10, borderRadius: 4, width: 60 }} />
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    )
  }

  if (activities.length === 0) {
    return (
      <Box bg="secondary" p={4} radius="lg" border="primary">
        <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          🕐 {isZh ? '动态' : 'Activity'}
        </Text>
        <Text size="sm" color="tertiary">{isZh ? '暂无动态' : 'No recent activity'}</Text>
      </Box>
    )
  }

  return (
    <Box bg="secondary" p={4} radius="lg" border="primary">
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[3] }}>
        🕐 {isZh ? '动态' : 'Activity'}
      </Text>
      <Box style={{ display: 'flex', flexDirection: 'column', position: 'relative', paddingLeft: tokens.spacing[4] }}>
        {/* Timeline vertical line */}
        <Box style={{
          position: 'absolute', left: 13, top: 8, bottom: 8, width: 2,
          background: `linear-gradient(to bottom, ${tokens.colors.accent.primary}30, ${tokens.colors.border.primary}20)`,
          borderRadius: 1,
        }} />
        {activities.map((item, idx) => (
          <Box
            key={item.id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: tokens.spacing[3],
              padding: `${tokens.spacing[3]} 0`,
              position: 'relative',
            }}
          >
            {/* Timeline dot */}
            <Box style={{
              position: 'absolute', left: -20, top: 16,
              width: 10, height: 10, borderRadius: '50%',
              background: idx === 0 ? tokens.colors.accent.primary : tokens.colors.bg.tertiary,
              border: `2px solid ${idx === 0 ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              zIndex: 1,
            }} />
            <Text style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
              {ICONS[item.type]}
            </Text>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <ActivityDescription item={item} isZh={isZh} />
              <Text size="xs" color="tertiary" style={{ marginTop: 3 }}>
                {formatRelativeTime(item.timestamp, isZh)}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
