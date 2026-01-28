'use client'

import { useEffect, useRef, type CSSProperties } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon } from '../icons'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { formatTimeAgo } from '@/lib/utils/date'
import { CompactErrorBoundary } from '../Utils/ErrorBoundary'
import type { Comment } from './hooks/usePostComments'

const REPLIES_PREVIEW_COUNT = 2

// Shared styles
const styles = {
  actionButton: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    color: tokens.colors.text.tertiary,
    padding: '2px 4px',
  } satisfies CSSProperties,
  input: {
    flex: 1,
    padding: '6px 10px',
    borderRadius: 8,
    border: `1px solid ${tokens.colors.border.primary}`,
    background: tokens.colors.bg.tertiary,
    color: tokens.colors.text.primary,
    fontSize: 13,
    outline: 'none',
  } satisfies CSSProperties,
  submitButton: (disabled: boolean) => ({
    padding: '6px 12px',
    borderRadius: 8,
    border: 'none',
    background: ARENA_PURPLE,
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  }) satisfies CSSProperties,
  avatar: (size: number) => ({
    width: size,
    height: size,
    borderRadius: '50%',
    objectFit: 'cover' as const,
  }),
  avatarPlaceholder: (size: number) => ({
    width: size,
    height: size,
    borderRadius: '50%',
    background: tokens.colors.bg.tertiary,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: size === 24 ? 10 : 12,
    fontWeight: 700,
    color: tokens.colors.text.tertiary,
  }) satisfies CSSProperties,
}

interface CommentsModalProps {
  postId: string
  comments: Comment[]
  loadingComments: boolean
  currentUserId: string | null
  // Comment input
  newComment: string
  setNewComment: (val: string) => void
  submittingComment: boolean
  onSubmitComment: (postId: string) => void
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
  // Delete
  deletingCommentId: string | null
  onDeleteComment: (postId: string, commentId: string) => void
  // Expand replies
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  // Translation
  translatedComments?: Record<string, string>
}

function SkeletonBlock({ width, height }: { width: string; height: number }): React.ReactNode {
  return (
    <div style={{
      width,
      height,
      borderRadius: 4,
      background: tokens.colors.bg.tertiary,
      animation: 'pulse 1.5s ease-in-out infinite',
    }} />
  )
}

function CommentSkeleton(): React.ReactNode {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
      {[1, 2, 3].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 10 }}>
          <div style={{
            width: 32,
            height: 32,
            borderRadius: '50%',
            background: tokens.colors.bg.tertiary,
            animation: 'pulse 1.5s ease-in-out infinite',
            flexShrink: 0,
          }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SkeletonBlock width={`${40 + i * 10}%`} height={12} />
            <SkeletonBlock width={`${60 + i * 5}%`} height={14} />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyComments(): React.ReactNode {
  return (
    <div style={{ textAlign: 'center', padding: '32px 16px', color: tokens.colors.text.tertiary }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 8px' }}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <div style={{ fontSize: 14, fontWeight: 600 }}>暂无评论</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>来发表第一条评论吧</div>
    </div>
  )
}

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
      <svg width={size * 0.57} height={size * 0.57} viewBox="0 0 24 24" fill="#fff">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
    </span>
  )
}

// Avatar component for comments
function CommentAvatar({ handle, avatarUrl, isReply }: { handle?: string | null; avatarUrl?: string | null; isReply: boolean }): React.ReactNode {
  const size = isReply ? 24 : 32
  const href = handle ? `/u/${encodeURIComponent(handle)}` : '#'

  return (
    <Link href={href} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none', flexShrink: 0 }}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" style={styles.avatar(size)} />
      ) : (
        <div style={styles.avatarPlaceholder(size)}>
          {(handle?.[0] || 'A').toUpperCase()}
        </div>
      )}
    </Link>
  )
}

export default function CommentsModal({
  postId,
  comments,
  loadingComments,
  currentUserId,
  newComment,
  setNewComment,
  submittingComment,
  onSubmitComment,
  replyingTo,
  setReplyingTo,
  replyContent,
  setReplyContent,
  submittingReply,
  onSubmitReply,
  commentLikeLoading,
  onToggleCommentLike,
  deletingCommentId,
  onDeleteComment,
  expandedReplies,
  setExpandedReplies,
  translatedComments = {},
}: CommentsModalProps) {
  const commentInputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-focus reply input
  useEffect(() => {
    if (replyingTo) {
      commentInputRef.current?.focus()
    }
  }, [replyingTo])

  const renderComment = (comment: Comment, isReply = false): React.ReactNode => {
    const displayContent = translatedComments[comment.id] || comment.content
    const isDeleting = deletingCommentId === comment.id
    const isOwn = currentUserId && comment.user_id === currentUserId
    const showProBadge = comment.author_is_pro && comment.author_show_pro_badge !== false
    const authorHref = comment.author_handle ? `/u/${encodeURIComponent(comment.author_handle)}` : '#'

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
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
          <CommentAvatar handle={comment.author_handle} avatarUrl={comment.author_avatar_url} isReply={isReply} />

          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Author info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <Link
                href={authorHref}
                onClick={(e) => e.stopPropagation()}
                style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.text.primary, textDecoration: 'none' }}
              >
                {comment.author_handle || '匿名'}
              </Link>
              {showProBadge && <ProBadge />}
              <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                {formatTimeAgo(comment.created_at)}
              </span>
            </div>

            {/* Content */}
            <div translate="no" style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
              {renderContentWithLinks(displayContent || '')}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleCommentLike(postId, comment.id) }}
                disabled={commentLikeLoading[comment.id]}
                style={{
                  ...styles.actionButton,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  borderRadius: 4,
                  color: comment.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
                }}
              >
                <ThumbsUpIcon size={14} />
                {(comment.like_count || 0) > 0 && <span>{comment.like_count}</span>}
              </button>

              {!isReply && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setReplyingTo(replyingTo?.commentId === comment.id ? null : { commentId: comment.id, handle: comment.author_handle || '匿名' })
                  }}
                  style={styles.actionButton}
                >
                  回复
                </button>
              )}

              {isOwn && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteComment(postId, comment.id) }}
                  disabled={isDeleting}
                  style={styles.actionButton}
                >
                  删除
                </button>
              )}
            </div>

            {/* Reply input */}
            {replyingTo?.commentId === comment.id && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  placeholder={`回复 @${replyingTo.handle}`}
                  onKeyDown={handleKeyDown}
                  style={styles.input}
                />
                <button
                  onClick={() => onSubmitReply(postId, comment.id)}
                  disabled={submittingReply || !replyContent.trim()}
                  style={styles.submitButton(submittingReply || !replyContent.trim())}
                >
                  {submittingReply ? '...' : '发送'}
                </button>
              </div>
            )}

            {/* Replies */}
            {visibleReplies && visibleReplies.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {visibleReplies.map(reply => renderComment(reply, true))}
                {hiddenReplyCount > 0 && !expandedReplies[comment.id] && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedReplies(prev => ({ ...prev, [comment.id]: true })) }}
                    style={{ ...styles.actionButton, color: ARENA_PURPLE, padding: '4px 0', marginTop: 4 }}
                  >
                    展开 {hiddenReplyCount} 条回复
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Comment input */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <textarea
          ref={commentInputRef}
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="写评论..."
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmitComment(postId)
            }
          }}
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 12,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.tertiary,
            color: tokens.colors.text.primary,
            fontSize: 14,
            resize: 'none',
            outline: 'none',
            minHeight: 40,
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={() => onSubmitComment(postId)}
          disabled={submittingComment || !newComment.trim()}
          style={{
            padding: '10px 16px',
            borderRadius: 12,
            border: 'none',
            background: ARENA_PURPLE,
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            cursor: submittingComment ? 'not-allowed' : 'pointer',
            opacity: (submittingComment || !newComment.trim()) ? 0.6 : 1,
            alignSelf: 'flex-end',
          }}
        >
          {submittingComment ? '...' : '发送'}
        </button>
      </div>

      {/* Comments list */}
      <CompactErrorBoundary>
        {loadingComments ? (
          <CommentSkeleton />
        ) : comments.length === 0 ? (
          <EmptyComments />
        ) : (
          <div>
            {comments.map(comment => renderComment(comment))}
          </div>
        )}
      </CompactErrorBoundary>
    </div>
  )
}
