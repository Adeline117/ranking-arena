'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon } from '../../ui/icons'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import { renderWithStickers, hasStickers } from '../../ui/StickerRenderer'
import type { Comment } from '../hooks/usePostComments'
import { commentStyles, REPLIES_PREVIEW_COUNT } from './commentStyles'
import { CommentAvatar, ProBadge } from './CommentAvatar'

interface CommentCardProps {
  comment: Comment
  isReply?: boolean
  postId: string
  currentUserId: string | null
  language: Locale
  t: (key: string) => string
  // Reply
  replyingTo: { commentId: string; handle: string } | null
  setReplyingTo: (val: { commentId: string; handle: string } | null) => void
  replyContent: string
  setReplyContent: (val: string) => void
  submittingReply: boolean
  onSubmitReply: (postId: string, parentId: string) => void
  // Like
  commentLikeLoading: Record<string, boolean>
  onToggleCommentLike: (postId: string, commentId: string) => void
  onToggleCommentDislike?: (postId: string, commentId: string) => void
  // Delete
  deletingCommentId: string | null
  onDeleteComment: (postId: string, commentId: string) => void
  // Expand replies
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  // Translation
  translatedComments: Record<string, string>
}

export function CommentCard({
  comment,
  isReply = false,
  postId,
  currentUserId,
  language,
  t,
  replyingTo,
  setReplyingTo,
  replyContent,
  setReplyContent,
  submittingReply,
  onSubmitReply,
  commentLikeLoading,
  onToggleCommentLike,
  onToggleCommentDislike,
  deletingCommentId,
  onDeleteComment,
  expandedReplies,
  setExpandedReplies,
  translatedComments,
}: CommentCardProps): React.ReactNode {
  const displayContent = translatedComments[comment.id] || comment.content
  const isDeleting = deletingCommentId === comment.id
  const isOwn = currentUserId && comment.user_id === currentUserId
  const showProBadge = comment.author_is_pro && comment.author_show_pro_badge !== false
  const authorHref = comment.author_handle ? `/u/${encodeURIComponent(comment.author_handle)}` : '#'

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (submittingReply || !replyContent.trim()) return
      onSubmitReply(postId, comment.id)
    }
  }

  const visibleReplies = expandedReplies[comment.id]
    ? comment.replies
    : comment.replies?.slice(0, REPLIES_PREVIEW_COUNT)

  const hiddenReplyCount = (comment.replies?.length || 0) - REPLIES_PREVIEW_COUNT

  return (
    <div
      key={comment.id}
      style={{
        marginLeft: isReply ? 42 : 0,
        padding: '10px 0',
        borderBottom: isReply ? 'none' : `1px solid ${tokens.colors.border.primary}`,
        opacity: isDeleting ? 0.5 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <div style={{ display: 'flex', gap: 10 }}>
        <CommentAvatar handle={comment.author_handle} avatarUrl={comment.author_avatar_url} isReply={isReply} isPro={comment.author_is_pro} showProBadge={comment.author_show_pro_badge} />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Author info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Link
              href={authorHref}
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.text.primary, textDecoration: 'none' }}
            >
              {comment.author_handle || 'user'}
            </Link>
            {showProBadge && <ProBadge />}
            <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
              {formatTimeAgo(comment.created_at, language)}
            </span>
          </div>

          {/* Content */}
          <div translate="no" style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
            {hasStickers(displayContent || '')
              ? renderWithStickers(displayContent || '', 64)
              : renderContentWithLinks(displayContent || '')}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCommentLike(postId, comment.id) }}
              disabled={commentLikeLoading[comment.id]}
              style={{
                ...commentStyles.actionButton,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                borderRadius: tokens.radius.sm,
                color: comment.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
              }}
            >
              <ThumbsUpIcon size={14} />
              {(comment.like_count || 0) > 0 && <span>{comment.like_count}</span>}
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); onToggleCommentDislike?.(postId, comment.id) }}
              disabled={commentLikeLoading[comment.id]}
              style={{
                ...commentStyles.actionButton,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                borderRadius: tokens.radius.sm,
                color: comment.user_disliked ? tokens.colors.accent.error : tokens.colors.text.tertiary,
              }}
            >
              <ThumbsDownIcon size={14} />
              {(comment.dislike_count || 0) > 0 && <span>{comment.dislike_count}</span>}
            </button>

            {!isReply && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setReplyingTo(replyingTo?.commentId === comment.id ? null : { commentId: comment.id, handle: comment.author_handle || 'user' })
                }}
                style={commentStyles.actionButton}
              >
                {t('reply')}
              </button>
            )}

            {isOwn && (
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteComment(postId, comment.id) }}
                disabled={isDeleting}
                style={commentStyles.actionButton}
              >
                {t('delete')}
              </button>
            )}
          </div>

          {/* Reply input */}
          {replyingTo?.commentId === comment.id && (
            <div style={{ marginTop: 8, position: 'relative' }}>
              <textarea
                value={replyContent}
                onChange={(e) => {
                  setReplyContent(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  ta.style.height = Math.min(ta.scrollHeight, 100) + 'px'
                }}
                placeholder={`${t('reply')} @${replyingTo.handle}`}
                aria-label={`${t('reply')} @${replyingTo.handle}`}
                onKeyDown={handleKeyDown}
                rows={1}
                style={{
                  ...commentStyles.input,
                  width: '100%',
                  resize: 'none',
                  minHeight: 36,
                  maxHeight: 100,
                  paddingRight: 60,
                  overflow: 'hidden',
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => onSubmitReply(postId, comment.id)}
                disabled={submittingReply || !replyContent.trim()}
                style={{
                  position: 'absolute',
                  right: 6,
                  bottom: 6,
                  padding: '3px 10px',
                  borderRadius: tokens.radius.sm,
                  border: 'none',
                  background: replyContent.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
                  color: tokens.colors.white,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: submittingReply || !replyContent.trim() ? 'default' : 'pointer',
                }}
              >
                {submittingReply ? '...' : t('send')}
              </button>
            </div>
          )}

          {/* Replies */}
          {visibleReplies && visibleReplies.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {visibleReplies.map(reply => (
                <CommentCard
                  key={reply.id}
                  comment={reply}
                  isReply
                  postId={postId}
                  currentUserId={currentUserId}
                  language={language}
                  t={t}
                  replyingTo={replyingTo}
                  setReplyingTo={setReplyingTo}
                  replyContent={replyContent}
                  setReplyContent={setReplyContent}
                  submittingReply={submittingReply}
                  onSubmitReply={onSubmitReply}
                  commentLikeLoading={commentLikeLoading}
                  onToggleCommentLike={onToggleCommentLike}
                  onToggleCommentDislike={onToggleCommentDislike}
                  deletingCommentId={deletingCommentId}
                  onDeleteComment={onDeleteComment}
                  expandedReplies={expandedReplies}
                  setExpandedReplies={setExpandedReplies}
                  translatedComments={translatedComments}
                />
              ))}
              {hiddenReplyCount > 0 && !expandedReplies[comment.id] && (
                <button
                  onClick={(e) => { e.stopPropagation(); setExpandedReplies(prev => ({ ...prev, [comment.id]: true })) }}
                  style={{ ...commentStyles.actionButton, color: ARENA_PURPLE, padding: '4px 0', marginTop: 4 }}
                >
                  {t('expandReplies').replace('{count}', String(hiddenReplyCount))}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
