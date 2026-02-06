'use client'

import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon } from '../../ui/icons'
import { Action } from './Action'

interface PostDetailActionsProps {
  postId: string
  authorId: string
  currentUserId: string | null
  userReaction: 'up' | 'down' | null | undefined
  likeCount: number
  dislikeCount: number
  isBookmarked: boolean
  bookmarkCount: number
  accessToken: string | null
  onToggleReaction: (postId: string, type: 'up' | 'down') => void
  onBookmark: (postId: string) => void
  onOpenBookmarkFolder: (postId: string) => void
  onRepost: (postId: string) => void
  showToast: (message: string, type: 'warning' | 'success' | 'error') => void
  t: (key: string) => string
}

export function PostDetailActions({
  postId,
  authorId,
  currentUserId,
  userReaction,
  likeCount,
  dislikeCount,
  isBookmarked,
  bookmarkCount,
  accessToken,
  onToggleReaction,
  onBookmark,
  onOpenBookmarkFolder,
  onRepost,
  showToast,
  t,
}: PostDetailActionsProps) {
  return (
    <div style={{
      marginTop: 14,
      paddingTop: 12,
      borderTop: `1px solid ${tokens.colors.border.secondary}`,
      display: 'flex',
      gap: 14,
      flexWrap: 'wrap',
    }}>
      <Action
        icon={<ThumbsUpIcon size={14} />}
        text={t('upvote')}
        onClick={(e) => {
          if (e) {
            e.preventDefault()
            e.stopPropagation()
          }
          onToggleReaction(postId, 'up')
        }}
        active={userReaction === 'up'}
        count={likeCount}
        showCount={true}
      />
      <Action
        icon={<ThumbsDownIcon size={14} />}
        text={t('downvote')}
        onClick={(e) => {
          if (e) {
            e.preventDefault()
            e.stopPropagation()
          }
          onToggleReaction(postId, 'down')
        }}
        active={userReaction === 'down'}
        count={dislikeCount}
        showCount={false}
      />
      {/* Bookmark */}
      <Action
        icon={<span style={{ fontSize: 14 }}>{isBookmarked ? '★' : '☆'}</span>}
        text={isBookmarked ? t('bookmarked') : t('save')}
        onClick={(e) => {
          if (e) {
            e.preventDefault()
            e.stopPropagation()
          }
          onBookmark(postId)
        }}
        active={isBookmarked}
        count={bookmarkCount}
        showCount={true}
      />
      {/* Bookmark folder selector - only when logged in */}
      {accessToken && (
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpenBookmarkFolder(postId)
          }}
          style={{
            background: 'transparent',
            border: 'none',
            color: tokens.colors.text.tertiary,
            cursor: 'pointer',
            padding: '6px 8px',
            fontSize: 12,
            borderRadius: 6,
            transition: 'all 0.2s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
            e.currentTarget.style.color = tokens.colors.text.secondary
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = tokens.colors.text.tertiary
          }}
          title={t('selectFolder')}
        >
          ▼
        </button>
      )}
      {/* Repost */}
      <Action
        icon={<span style={{ fontSize: 14 }}>↗</span>}
        text={t('repost')}
        onClick={(e) => {
          if (e) {
            e.preventDefault()
            e.stopPropagation()
          }
          if (authorId === currentUserId) {
            showToast(t('cannotRepostOwn'), 'warning')
            return
          }
          onRepost(postId)
        }}
        active={false}
        count={0}
        showCount={false}
      />
    </div>
  )
}
