'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatDistanceToNow } from '@/lib/utils/date'

interface Activity {
  id: string
  user_id: string
  activity_type: string
  target_type: string
  target_id: string
  metadata: Record<string, unknown>
  created_at: string
}

const ACTIVITY_ICONS: Record<string, string> = {
  rate_book: '⭐',
  want_read: '📚',
  reading: '📖',
  read_book: '✅',
  review_book: '✍️',
  follow_trader: '📊',
  follow_user: '👤',
  join_group: '👥',
  create_post: '📝',
}

function getActivityLink(activity: Activity): string {
  switch (activity.target_type) {
    case 'book':
      return `/library/${activity.target_id}`
    case 'trader':
      return `/trader/${activity.metadata.trader_handle || activity.target_id}`
    case 'user':
      return `/u/${activity.metadata.handle || activity.target_id}`
    case 'post':
      return `/post/${activity.target_id}`
    case 'group':
      return `/groups/${activity.target_id}`
    default:
      return '#'
  }
}

function ActivityDescription({ activity, isZh }: { activity: Activity; isZh: boolean }) {
  const meta = activity.metadata
  const bookTitle = (meta.book_title as string) || ''
  const rating = meta.rating as number | null
  const traderHandle = (meta.trader_handle as string) || ''
  const handle = (meta.handle as string) || ''
  const groupName = (meta.group_name as string) || ''
  const postTitle = (meta.title as string) || ''

  const link = getActivityLink(activity)

  switch (activity.activity_type) {
    case 'want_read':
      return (
        <span>
          {isZh ? '标记' : 'Marked '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            《{bookTitle}》
          </Link>
          {isZh ? ' 为想读' : ' as want to read'}
        </span>
      )
    case 'reading':
      return (
        <span>
          {isZh ? '开始阅读 ' : 'Started reading '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            《{bookTitle}》
          </Link>
        </span>
      )
    case 'read_book':
      return (
        <span>
          {isZh ? '读过 ' : 'Finished reading '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            《{bookTitle}》
          </Link>
        </span>
      )
    case 'rate_book':
      return (
        <span>
          {isZh ? '给 ' : 'Rated '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            《{bookTitle}》
          </Link>
          {isZh ? ` 评分 ${'★'.repeat(rating || 0)}` : ` ${'★'.repeat(rating || 0)}`}
        </span>
      )
    case 'review_book':
      return (
        <span>
          {isZh ? '评论了 ' : 'Reviewed '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            《{bookTitle}》
          </Link>
        </span>
      )
    case 'follow_trader':
      return (
        <span>
          {isZh ? '关注了交易员 ' : 'Followed trader '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {traderHandle}
          </Link>
        </span>
      )
    case 'follow_user':
      return (
        <span>
          {isZh ? '关注了 ' : 'Followed '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            @{handle}
          </Link>
        </span>
      )
    case 'join_group':
      return (
        <span>
          {isZh ? '加入了群组 ' : 'Joined group '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {groupName}
          </Link>
        </span>
      )
    case 'create_post':
      return (
        <span>
          {isZh ? '发布了帖子 ' : 'Published post '}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {postTitle || (isZh ? '查看' : 'View')}
          </Link>
        </span>
      )
    default:
      return <span>{activity.activity_type}</span>
  }
}

export default function UserActivityFeed({ handle }: { handle: string }) {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const loadActivities = useCallback(async (newOffset: number) => {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(handle)}/activities?limit=20&offset=${newOffset}`)
      if (!res.ok) return
      const data = await res.json()
      if (newOffset === 0) {
        setActivities(data.activities)
      } else {
        setActivities(prev => [...prev, ...data.activities])
      }
      setHasMore(data.hasMore)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [handle])

  useEffect(() => {
    loadActivities(0)
  }, [loadActivities])

  const loadMore = () => {
    const newOffset = offset + 20
    setOffset(newOffset)
    loadActivities(newOffset)
  }

  if (loading) {
    return (
      <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">...</Text>
      </Box>
    )
  }

  if (activities.length === 0) {
    return (
      <Box bg="secondary" p={6} radius="lg" border="primary" style={{ textAlign: 'center' }}>
        <Text size="sm" color="tertiary">
          {isZh ? '暂无动态' : 'No activities yet'}
        </Text>
      </Box>
    )
  }

  // Group activities by date
  const grouped = new Map<string, Activity[]>()
  for (const a of activities) {
    const dateKey = new Date(a.created_at).toLocaleDateString(isZh ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    if (!grouped.has(dateKey)) grouped.set(dateKey, [])
    grouped.get(dateKey)!.push(a)
  }

  return (
    <Box bg="secondary" p={4} radius="lg" border="primary">
      <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
        {isZh ? '动态' : 'Activity'}
      </Text>

      <Box style={{ position: 'relative', paddingLeft: 24 }}>
        {/* Timeline line */}
        <Box
          style={{
            position: 'absolute',
            left: 7,
            top: 4,
            bottom: 4,
            width: 2,
            background: `${tokens.colors.border.primary}`,
            borderRadius: 1,
          }}
        />

        {Array.from(grouped.entries()).map(([dateLabel, items]) => (
          <Box key={dateLabel} style={{ marginBottom: tokens.spacing[4] }}>
            <Text
              size="xs"
              weight="bold"
              color="tertiary"
              style={{
                marginBottom: tokens.spacing[2],
                marginLeft: -4,
                letterSpacing: '0.03em',
              }}
            >
              {dateLabel}
            </Text>

            {items.map((activity) => (
              <Box
                key={activity.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: tokens.spacing[3],
                  padding: `${tokens.spacing[2]} 0`,
                  position: 'relative',
                }}
              >
                {/* Timeline dot */}
                <Box
                  style={{
                    position: 'absolute',
                    left: -21,
                    top: 12,
                    width: 12,
                    height: 12,
                    borderRadius: '50%',
                    background: tokens.colors.bg.primary,
                    border: `2px solid ${tokens.colors.accent.brand}`,
                    display: 'grid',
                    placeItems: 'center',
                    fontSize: 6,
                    zIndex: 1,
                  }}
                />

                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    size="sm"
                    style={{
                      color: tokens.colors.text.primary,
                      lineHeight: '1.6',
                    }}
                  >
                    <span style={{ marginRight: 6 }}>
                      {ACTIVITY_ICONS[activity.activity_type] || '📌'}
                    </span>
                    <ActivityDescription activity={activity} isZh={isZh} />
                  </Text>
                  <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>
                    {formatDistanceToNow(new Date(activity.created_at), isZh)}
                  </Text>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>

      {hasMore && (
        <button
          onClick={loadMore}
          style={{
            width: '100%',
            padding: tokens.spacing[3],
            background: 'transparent',
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
            marginTop: tokens.spacing[3],
          }}
        >
          {isZh ? '加载更多' : 'Load more'}
        </button>
      )}
    </Box>
  )
}
