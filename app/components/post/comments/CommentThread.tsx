'use client'

import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon } from '../../ui/icons'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { formatTimeAgo } from '@/lib/utils/date'
import { ProBadgeOverlay } from '../../ui/ProBadge'
import { renderWithStickers, hasStickers } from '../../ui/StickerRenderer'
import { commentStyles, REPLIES_PREVIEW_COUNT, type Comment } from './comment-types'

// Pro badge component
function ProBadge({ size = 14 }: { size?: number }): React.ReactNode {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--color-pro-badge-bg)',
        boxShadow: '0 0 3px var(--color-pro-badge-shadow)',
        flexShrink: 0,
      }}
    >
      <svg width={size * 0.57} height={size * 0.57} viewBox="0 0 24 24" fill="var(--color-on-accent)">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
    </span>
  )
}

// Avatar component for comments
function CommentAvatar({ handle, avatarUrl, isReply, isPro, showProBadge }: { handle?: string | null; avatarUrl?: string | null; isReply: boolean; isPro?: boolean; showProBadge?: boolean }): React.ReactNode {
  const size = isReply ? 24 : 32
  const href = handle ? `/u/${encodeURIComponent(handle)}` : '#'

  return (
    <Link href={href} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none', flexShrink: 0, position: 'relative' }}>
      {avatarUrl ? (
        <Image src={avatarUrl.startsWith('data:') ? avatarUrl : `/api/avatar?url=${encodeURIComponent(avatarUrl)}`} alt={`${handle || 'User'} avatar`} width={size} height={size} sizes={`${size}px`} loading="lazy" unoptimized style={commentStyles.avatar(size)} />
      ) : (
        <div style={commentStyles.avatarPlaceholder(size)}>
          {(handle?.[0] || 'A').toUpperCase()}
        </div>
      )}
      {isPro && showProBadge !== false && <ProBadgeOverlay position="bottom-right" />}
    </Link>
  )
}

export interface CommentThreadProps {
  comment: Comment
  isReply?: boolean
  postId: string
  currentUserId: string | null
  language: string
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
  // Edit
  editingComment?: { id: string; content: string } | null
  editContent?: string
  setEditContent?: (val: string) => void
  submittingEdit?: boolean
  onStartEdit?: (comment: Comment) => void
  onCancelEdit?: () => void
  onSubmitEdit?: (postId: string) => void
  // Expand replies
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  // Translation
  translatedComments?: Record<string, string>
}

export function CommentThread({
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
  editingComment,
  editContent,
  setEditContent,
  submittingEdit,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  expandedReplies,
  setExpandedReplies,
  translatedComments = {},
}: CommentThreadProps): React.ReactNode {
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
        borderLeft: isReply ? `2px solid var(--color-accent-primary-20, ${tokens.colors.border.primary})` : 'none',
        paddingLeft: isReply ? 12 : 0,
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
              {formatTimeAgo(comment.created_at, language as import('@/lib/utils/date').Locale)}
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

            {isOwn && onStartEdit && (
              <button
                onClick={(e) => { e.stopPropagation(); onStartEdit(comment) }}
                style={commentStyles.actionButton}
              >
                {t('edit')}
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

          {/* Edit input */}
          {editingComment?.id === comment.id && setEditContent && onSubmitEdit && onCancelEdit && (
            <div style={{ marginTop: 8, position: 'relative' }}>
              <textarea
                value={editContent || ''}
                onChange={(e) => {
                  setEditContent(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  ta.style.height = Math.min(ta.scrollHeight, 100) + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (!submittingEdit && editContent?.trim()) onSubmitEdit(postId)
                  }
                  if (e.key === 'Escape') onCancelEdit()
                }}
                rows={2}
                style={{
                  ...commentStyles.input,
                  width: '100%',
                  resize: 'none',
                  minHeight: 48,
                  maxHeight: 100,
                  paddingRight: 80,
                  overflow: 'hidden',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{ position: 'absolute', right: 6, bottom: 6, display: 'flex', gap: 4 }}>
                <button
                  onClick={onCancelEdit}
                  style={{
                    padding: '3px 8px',
                    borderRadius: tokens.radius.sm,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.tertiary,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={() => onSubmitEdit(postId)}
                  disabled={submittingEdit || !editContent?.trim()}
                  style={{
                    padding: '3px 10px',
                    borderRadius: tokens.radius.sm,
                    border: 'none',
                    background: editContent?.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
                    color: tokens.colors.white,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: submittingEdit || !editContent?.trim() ? 'default' : 'pointer',
                  }}
                >
                  {submittingEdit ? '...' : t('save')}
                </button>
              </div>
            </div>
          )}

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
                <CommentThread
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
                  editingComment={editingComment}
                  editContent={editContent}
                  setEditContent={setEditContent}
                  submittingEdit={submittingEdit}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
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
