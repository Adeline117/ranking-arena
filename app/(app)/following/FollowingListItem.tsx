'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { RoiDisplay } from './components'
import { getSourceDisplayName, getSourceColor } from './types'
import type { FollowItem } from './types'

type FollowingListItemProps = {
  item: FollowItem
  language: string
  unfollowingId: string | null
  onItemClick: (item: FollowItem) => void
  onUnfollow: (item: FollowItem, e: React.MouseEvent) => void
  t: (key: string) => string
}

export default function FollowingListItem({
  item,
  language,
  unfollowingId,
  onItemClick,
  onUnfollow,
  t,
}: FollowingListItemProps) {
  return (
    <Box
      onClick={() => onItemClick(item)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: tokens.spacing[3],
        borderRadius: tokens.radius.md,
        cursor: 'pointer',
        transition: `background ${tokens.transition.base}`,
        background: 'transparent',
      }}
      className="hover-bg-tertiary"
    >
      {/* 头像 */}
      <Avatar
        userId={item.id}
        name={item.handle}
        avatarUrl={item.avatar_url}
        size={48}
        style={{ flexShrink: 0 }}
      />

      {/* 信息区域 */}
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="semibold" style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {item.handle}
          </Text>
          {/* 类型标签 */}
          <span style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: tokens.radius.sm,
            background: item.type === 'trader'
              ? getSourceColor(item.source || 'binance') + '20'
              : tokens.colors.accent.brand + '20',
            color: item.type === 'trader'
              ? getSourceColor(item.source || 'binance')
              : tokens.colors.accent.brand,
            fontWeight: 500,
          }}>
            {item.type === 'trader'
              ? getSourceDisplayName(item.source || 'binance', language)
              : (language === 'en' ? 'User' : '用户')}
          </span>
        </Box>

        {/* 交易员：ROI + Arena Score 行 */}
        {item.type === 'trader' ? (
          <Box style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[3],
            marginTop: 4,
            flexWrap: 'wrap',
          }}>
            <RoiDisplay value={item.roi} label="ROI" />
            {item.roi_7d !== undefined && (
              <RoiDisplay value={item.roi_7d} label="7D" />
            )}
            {item.arena_score !== undefined && item.arena_score > 0 && (
              <Text size="xs" color="tertiary">
                Score: <span style={{ color: tokens.colors.accent.brand, fontWeight: 500 }}>
                  {item.arena_score.toFixed(1)}
                </span>
              </Text>
            )}
            {item.win_rate !== undefined && item.win_rate > 0 && (
              <Text size="xs" color="tertiary">
                {t('winRate')}: {item.win_rate.toFixed(1)}%
              </Text>
            )}
            {item.followers !== undefined && item.followers > 0 && (
              <Text size="xs" color="tertiary">
                {t('copiers')}: {item.followers.toLocaleString('en-US')}
              </Text>
            )}
          </Box>
        ) : item.bio ? (
          <Text size="xs" color="tertiary" style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 4,
          }}>
            {item.bio}
          </Text>
        ) : null}
      </Box>

      {/* 右侧：Arena Score + 取消关注 + 箭头 */}
      <Box style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        flexShrink: 0,
      }}>
        {item.type === 'trader' && item.arena_score !== undefined && item.arena_score > 0 && (
          <Box style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            background: tokens.colors.accent.brand + '10',
            borderRadius: tokens.radius.md,
            minWidth: 50,
          }}>
            <Text size="xs" color="tertiary" style={{ fontSize: 10, lineHeight: 1 }}>Score</Text>
            <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.brand }}>
              {item.arena_score.toFixed(0)}
            </Text>
          </Box>
        )}
        <button
          onClick={(e) => onUnfollow(item, e)}
          disabled={unfollowingId === item.id}
          title={t('unfollow')}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: 'transparent',
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.xs,
            cursor: unfollowingId === item.id ? 'not-allowed' : 'pointer',
            opacity: unfollowingId === item.id ? 0.5 : 1,
            transition: `all ${tokens.transition.base}`,
            whiteSpace: 'nowrap',
          }}
          className="hover-unfollow"
        >
          {unfollowingId === item.id
            ? t('removing')
            : t('unfollow')
          }
        </button>
        <Box style={{ color: tokens.colors.text.tertiary }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </Box>
      </Box>
    </Box>
  )
}
