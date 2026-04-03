'use client'
'use no memo'

import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon } from '../../ui/icons'
import { Action } from './Action'

interface PostDetailActionsProps {
  postId: string
  postTitle?: string
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
  postTitle,
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
        icon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill={isBookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        }
        text={isBookmarked ? t('bookmarked') : t('bookmark')}
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
            borderRadius: tokens.radius.sm,
            transition: `all ${tokens.transition.base}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--overlay-hover)'
            e.currentTarget.style.color = tokens.colors.text.secondary
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = tokens.colors.text.tertiary
          }}
          title={t('selectFolder')}
          aria-label={t('selectFolder')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}
      {/* Repost */}
      <Action
        icon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 1l4 4-4 4" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <path d="M7 23l-4-4 4-4" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        }
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
      {/* Share */}
      <Action
        icon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
        }
        text={t('share')}
        onClick={async (e) => {
          if (e) {
            e.preventDefault()
            e.stopPropagation()
          }
          const shareUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/post/${postId}`
          try {
            if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && /Mobi|Android/i.test(navigator.userAgent)) {
              await navigator.share({ text: postTitle || '', url: shareUrl })
            } else {
              await navigator.clipboard.writeText(shareUrl)
              showToast(t('linkCopied'), 'success')
            }
          } catch {
            // Fallback: copy link if share dialog was cancelled or unavailable
            try {
              await navigator.clipboard.writeText(shareUrl)
              showToast(t('linkCopied'), 'success')
            } catch { /* clipboard also unavailable */ }
          }
        }}
        active={false}
        count={0}
        showCount={false}
      />
    </div>
  )
}
