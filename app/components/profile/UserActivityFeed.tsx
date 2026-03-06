'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'

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
  rate_book: '\u2605',
  want_read: '\u25CF',
  reading: '\u25CF',
  read_book: '\u2713',
  review_book: '\u25CF',
  follow_trader: '\u25CF',
  follow_user: '\u25CF',
  join_group: '\u25CF',
  create_post: '\u25CF',
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

function ActivityDescription({ activity, t }: { activity: Activity; t: (key: string) => string }) {
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
          {t('userActivityMarked')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {bookTitle}
          </Link>
          {t('userActivityWantRead')}
        </span>
      )
    case 'reading':
      return (
        <span>
          {t('userActivityStartedReading')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {bookTitle}
          </Link>
        </span>
      )
    case 'read_book':
      return (
        <span>
          {t('userActivityFinishedReading')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {bookTitle}
          </Link>
        </span>
      )
    case 'rate_book':
      return (
        <span>
          {t('userActivityRated')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {bookTitle}
          </Link>
          {`${t('userActivityRatedSuffix')}${'\u2605'.repeat(rating || 0)}`}
        </span>
      )
    case 'review_book':
      return (
        <span>
          {t('userActivityReviewed')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {bookTitle}
          </Link>
        </span>
      )
    case 'follow_trader':
      return (
        <span>
          {t('userActivityFollowedTrader')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {traderHandle}
          </Link>
        </span>
      )
    case 'follow_user':
      return (
        <span>
          {t('userActivityFollowedUser')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            @{handle}
          </Link>
        </span>
      )
    case 'join_group':
      return (
        <span>
          {t('userActivityJoinedGroup')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {groupName}
          </Link>
        </span>
      )
    case 'create_post':
      return (
        <span>
          {t('userActivityPublishedPost')}
          <Link href={link} style={{ color: tokens.colors.accent.brand, textDecoration: 'none', fontWeight: 600 }}>
            {postTitle || t('userActivityView')}
          </Link>
        </span>
      )
    default:
      return <span>{activity.activity_type}</span>
  }
}

export default function UserActivityFeed({ handle }: { handle: string }) {
  const { language, t } = useLanguage()
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
          {t('userActivityNoActivities')}
        </Text>
      </Box>
    )
  }

  // Group activities by date
  const grouped = new Map<string, Activity[]>()
  for (const a of activities) {
    const dateKey = new Date(a.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
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
        {t('userActivityTitle')}
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
                      {ACTIVITY_ICONS[activity.activity_type] || '\u25CF'}
                    </span>
                    <ActivityDescription activity={activity} t={t} />
                  </Text>
                  <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>
                    {formatTimeAgo(activity.created_at, language)}
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
          {t('userActivityLoadMore')}
        </button>
      )}
    </Box>
  )
}
