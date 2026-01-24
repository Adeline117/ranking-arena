'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon } from '../icons'
import { renderContentWithLinks } from '@/lib/utils/content'
import { formatTimeAgo } from '@/lib/utils/date'
import { CompactErrorBoundary } from '../Utils/ErrorBoundary'
import type { Comment } from './hooks/usePostComments'

const ARENA_PURPLE = '#8b6fa8'
const REPLIES_PREVIEW_COUNT = 2

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

function CommentSkeleton() {
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
          <div style={{ flex: 1 }}>
            <div style={{
              width: `${40 + i * 10}%`,
              height: 12,
              borderRadius: 4,
              background: tokens.colors.bg.tertiary,
              marginBottom: 6,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
            <div style={{
              width: `${60 + i * 5}%`,
              height: 14,
              borderRadius: 4,
              background: tokens.colors.bg.tertiary,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyComments() {
  return (
    <div style={{
      textAlign: 'center',
      padding: '32px 16px',
      color: tokens.colors.text.tertiary,
    }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto' }}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>暂无评论</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>来发表第一条评论吧</div>
    </div>
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

  const renderComment = (comment: Comment, isReply = false) => {
    const displayContent = translatedComments[comment.id] || comment.content
    const isDeleting = deletingCommentId === comment.id
    const isOwn = currentUserId && comment.user_id === currentUserId

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
          {/* Avatar */}
          <Link
            href={comment.author_handle ? `/u/${encodeURIComponent(comment.author_handle)}` : '#'}
            onClick={(e) => e.stopPropagation()}
            style={{ textDecoration: 'none', flexShrink: 0 }}
          >
            {comment.author_avatar_url ? (
              <img
                src={comment.author_avatar_url}
                alt=""
                style={{
                  width: isReply ? 24 : 32,
                  height: isReply ? 24 : 32,
                  borderRadius: '50%',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <div style={{
                width: isReply ? 24 : 32,
                height: isReply ? 24 : 32,
                borderRadius: '50%',
                background: tokens.colors.bg.tertiary,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: isReply ? 10 : 12,
                fontWeight: 700,
                color: tokens.colors.text.tertiary,
              }}>
                {(comment.author_handle?.[0] || 'A').toUpperCase()}
              </div>
            )}
          </Link>

          {/* Content */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Link
                href={comment.author_handle ? `/u/${encodeURIComponent(comment.author_handle)}` : '#'}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: tokens.colors.text.primary,
                  textDecoration: 'none',
                }}
              >
                {comment.author_handle || '匿名'}
              </Link>
              <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                {formatTimeAgo(comment.created_at)}
              </span>
            </div>

            <div translate="no" style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
              {renderContentWithLinks(displayContent || '')}
            </div>

            {/* Actions row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
              {/* Like */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleCommentLike(postId, comment.id)
                }}
                disabled={commentLikeLoading[comment.id]}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '2px 4px',
                  borderRadius: 4,
                  color: comment.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
                  fontSize: 12,
                }}
              >
                <ThumbsUpIcon size={14} />
                {(comment.like_count || 0) > 0 && <span>{comment.like_count}</span>}
              </button>

              {/* Reply button (only for top-level comments) */}
              {!isReply && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setReplyingTo(
                      replyingTo?.commentId === comment.id
                        ? null
                        : { commentId: comment.id, handle: comment.author_handle || '匿名' }
                    )
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: tokens.colors.text.tertiary,
                    padding: '2px 4px',
                  }}
                >
                  回复
                </button>
              )}

              {/* Delete (own comments only) */}
              {isOwn && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteComment(postId, comment.id)
                  }}
                  disabled={isDeleting}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 12,
                    color: tokens.colors.text.tertiary,
                    padding: '2px 4px',
                  }}
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      onSubmitReply(postId, comment.id)
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    borderRadius: 8,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.tertiary,
                    color: tokens.colors.text.primary,
                    fontSize: 13,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={() => onSubmitReply(postId, comment.id)}
                  disabled={submittingReply || !replyContent.trim()}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    border: 'none',
                    background: ARENA_PURPLE,
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: submittingReply ? 'not-allowed' : 'pointer',
                    opacity: submittingReply ? 0.6 : 1,
                  }}
                >
                  {submittingReply ? '...' : '发送'}
                </button>
              </div>
            )}

            {/* Replies */}
            {comment.replies && comment.replies.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {(expandedReplies[comment.id]
                  ? comment.replies
                  : comment.replies.slice(0, REPLIES_PREVIEW_COUNT)
                ).map(reply => renderComment(reply, true))}

                {comment.replies.length > REPLIES_PREVIEW_COUNT && !expandedReplies[comment.id] && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedReplies(prev => ({ ...prev, [comment.id]: true }))
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 12,
                      color: ARENA_PURPLE,
                      padding: '4px 0',
                      marginTop: 4,
                    }}
                  >
                    展开 {comment.replies.length - REPLIES_PREVIEW_COUNT} 条回复
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
