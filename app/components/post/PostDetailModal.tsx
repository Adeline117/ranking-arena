'use client'

/**
 * PostDetailModal - Unified post detail modal component
 *
 * PRINCIPLES:
 * 1. Uses postStore as single source of truth for post/comment data
 * 2. Comments are only shown after server confirms (no optimistic ghost comments)
 * 3. All click targets (author, group) are independent Links with stopPropagation
 * 4. Close behavior: overlay click, close button, ESC (via useUrlModal)
 * 5. Consistent across all entry points (hot, groups, feed)
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { tokens, alpha } from '@/lib/design-tokens'
import { useModalA11y } from '@/lib/hooks/useModalA11y'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { formatTimeAgo } from '@/lib/utils/date'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  usePostStore,
  loadPostComments,
  loadMorePostComments,
  submitPostComment,
  togglePostReaction,
} from '@/lib/stores/postStore'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'

type PostDetailModalProps = {
  postId: string
  onClose: () => void
}

export default function PostDetailModal({ postId, onClose }: PostDetailModalProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const auth = useAuthSession()

  // Restore draft comment from localStorage on mount
  const [newComment, setNewCommentRaw] = useState(() => {
    try {
      return localStorage.getItem(`comment-draft-${postId}`) || ''
    } catch {
      return ''
    }
  })
  const [submittingComment, setSubmittingComment] = useState(false)
  const [reacting, setReacting] = useState(false)

  // Auto-save comment draft (debounced 500ms)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setNewComment = useCallback(
    (value: string) => {
      setNewCommentRaw(value)
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      draftTimerRef.current = setTimeout(() => {
        try {
          if (value.trim()) localStorage.setItem(`comment-draft-${postId}`, value)
          else localStorage.removeItem(`comment-draft-${postId}`)
        } catch {
          /* quota exceeded */
        }
      }, 500)
    },
    [postId]
  )

  // Prevent duplicate submissions
  const commentPendingRef = useRef(false)
  const reactionPendingRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)

  useModalA11y({ open: true, onClose, modalRef: dialogRef })

  // Read from canonical store
  const post = usePostStore((s) => s.posts[postId])
  const comments = usePostStore((s) => s.comments[postId] || [])
  const pagination = usePostStore((s) => s.commentsPagination[postId])

  // Load comments on mount
  useEffect(() => {
    loadPostComments(postId)
  }, [postId])

  const handleSubmitComment = useCallback(async () => {
    // Prevent duplicate submissions
    if (commentPendingRef.current) return

    const token = auth.isLoggedIn ? auth.accessToken : null
    if (!token) return
    if (!newComment.trim()) return

    commentPendingRef.current = true
    setSubmittingComment(true)
    try {
      const result = await submitPostComment(postId, newComment.trim(), token)
      if ('error' in result) {
        showToast(result.error, 'error')
      } else {
        setNewCommentRaw('')
        try {
          localStorage.removeItem(`comment-draft-${postId}`)
        } catch {
          /* ignore */
        }
      }
    } catch {
      showToast(t('commentFailedRetry'), 'error')
    } finally {
      setSubmittingComment(false)
      commentPendingRef.current = false
    }
  }, [postId, newComment, auth, showToast, t])

  const handleReaction = useCallback(
    async (reactionType: 'up' | 'down') => {
      // Prevent duplicate reactions
      if (reactionPendingRef.current || reacting) return

      const token = auth.isLoggedIn ? auth.accessToken : null
      if (!token) return

      reactionPendingRef.current = true
      setReacting(true)
      try {
        const result = await togglePostReaction(postId, reactionType, token)
        if (!result.success) {
          showToast(result.error || t('operationFailed'), 'error')
        }
      } catch {
        showToast(t('operationFailedRetry'), 'error')
      } finally {
        setReacting(false)
        reactionPendingRef.current = false
      }
    },
    [postId, auth, showToast, reacting, t]
  )

  const handleLoadMore = useCallback(() => {
    loadMorePostComments(postId)
  }, [postId])

  if (!post) {
    return (
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.colors.overlay.dark,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: tokens.zIndex.modal,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: 32,
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.xl,
            color: tokens.colors.text.secondary,
          }}
        >
          {t('loading')}
        </div>
      </div>
    )
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: tokens.colors.overlay.dark,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'clamp(0px, 2vw, 20px)',
        zIndex: tokens.zIndex.modal,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('postDetail') || 'Post detail'}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 'clamp(0px, 2vw, 16px)',
          background: tokens.colors.bg.secondary,
          padding: 16,
        }}
      >
        {/* Close button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: tokens.typography.fontSize.xl,
              width: 44,
              height: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: tokens.radius.md,
            }}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        {/* Group link */}
        {post.group_id ? (
          <Link
            href={`/groups/${post.group_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: ARENA_PURPLE,
              textDecoration: 'none',
            }}
          >
            {post.group_name || t('generalDiscussion')}
          </Link>
        ) : (
          <div style={{ fontSize: tokens.typography.fontSize.xs, color: ARENA_PURPLE }}>
            {t('generalDiscussion')}
          </div>
        )}

        {/* Title */}
        <div
          style={{
            fontSize: tokens.typography.fontSize.xl,
            fontWeight: tokens.typography.fontWeight.black,
            lineHeight: 1.25,
            marginTop: 8,
          }}
        >
          {post.title}
        </div>

        {/* Meta: author (clickable) + time + comments */}
        <div
          style={{
            marginTop: 8,
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Link
            href={`/u/${encodeURIComponent(post.author_handle)}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              color: tokens.colors.text.secondary,
              textDecoration: 'none',
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            {post.author_handle || 'user'}
          </Link>
          <span>&middot;</span>
          <span>{formatTimeAgo(post.created_at, language)}</span>
          <span>&middot;</span>
          <CommentIcon size={12} /> {post.comment_count}
        </div>

        {/* Content */}
        <div
          translate="no"
          style={{
            marginTop: 12,
            fontSize: tokens.typography.fontSize.base,
            color: tokens.colors.text.primary,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
          }}
        >
          {renderContentWithLinks(post.content || '')}
        </div>

        {/* Reactions */}
        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: `1px solid ${tokens.colors.border.secondary}`,
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => handleReaction('up')}
            disabled={reacting}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              border: 'none',
              borderRadius: tokens.radius.md,
              background:
                post.user_reaction === 'up'
                  ? `${alpha(tokens.colors.accent.success, 13)}`
                  : tokens.colors.bg.tertiary,
              color:
                post.user_reaction === 'up'
                  ? tokens.colors.accent.success
                  : tokens.colors.text.secondary,
              cursor: reacting ? 'not-allowed' : 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              opacity: reacting ? 0.6 : 1,
            }}
          >
            <ThumbsUpIcon size={14} /> {post.like_count}
          </button>
          <button
            onClick={() => handleReaction('down')}
            disabled={reacting}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              border: 'none',
              borderRadius: tokens.radius.md,
              background:
                post.user_reaction === 'down'
                  ? `${alpha(tokens.colors.accent.error, 13)}`
                  : tokens.colors.bg.tertiary,
              color:
                post.user_reaction === 'down'
                  ? tokens.colors.accent.error
                  : tokens.colors.text.secondary,
              cursor: reacting ? 'not-allowed' : 'pointer',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              opacity: reacting ? 0.6 : 1,
            }}
          >
            <ThumbsDownIcon size={14} />
          </button>
        </div>

        {/* Comments Section */}
        <div
          style={{
            marginTop: 16,
            borderTop: `1px solid ${tokens.colors.border.secondary}`,
            paddingTop: 16,
          }}
        >
          <div style={{ fontWeight: tokens.typography.fontWeight.black, marginBottom: 12 }}>
            {t('comments')} ({post.comment_count})
          </div>

          {/* Comment input */}
          <div style={{ marginBottom: 16 }}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={auth.isLoggedIn ? t('writeComment') : t('loginBeforeComment')}
              aria-label={t('writeComment')}
              disabled={!auth.isLoggedIn || submittingComment}
              style={{
                width: '100%',
                minHeight: 80,
                padding: 12,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                resize: 'vertical',
                outline: 'none',
              }}
            />
            {auth.isLoggedIn && (
              <button
                onClick={handleSubmitComment}
                disabled={!newComment.trim() || submittingComment}
                style={{
                  marginTop: 8,
                  padding: '8px 16px',
                  background:
                    newComment.trim() && !submittingComment
                      ? ARENA_PURPLE
                      : 'var(--color-accent-primary-30)',
                  color: tokens.colors.white,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.bold,
                  cursor: newComment.trim() && !submittingComment ? 'pointer' : 'not-allowed',
                }}
              >
                {submittingComment ? t('submittingComment') : t('postComment')}
              </button>
            )}
          </div>

          {/* Comment list */}
          {pagination?.loading ? (
            <div
              style={{
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t('loadingComments')}
            </div>
          ) : comments.length === 0 ? (
            <div
              style={{
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t('noCommentsBeFirst')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {comments.filter(Boolean).map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    padding: 12,
                    background: tokens.colors.bg.primary,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    {comment.author_handle ? (
                      <Link
                        href={`/u/${encodeURIComponent(comment.author_handle)}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          fontWeight: tokens.typography.fontWeight.bold,
                          color: tokens.colors.text.secondary,
                          textDecoration: 'none',
                        }}
                      >
                        {comment.author_handle}
                      </Link>
                    ) : (
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          fontWeight: tokens.typography.fontWeight.bold,
                          color: tokens.colors.text.tertiary,
                        }}
                      >
                        {'user'}
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: tokens.typography.fontSize.xs,
                        color: tokens.colors.text.tertiary,
                      }}
                    >
                      {formatTimeAgo(comment.created_at, language)}
                    </span>
                  </div>
                  <div
                    translate="no"
                    style={{
                      fontSize: tokens.typography.fontSize.sm,
                      color: tokens.colors.text.primary,
                      lineHeight: 1.6,
                    }}
                  >
                    {renderContentWithLinks(comment.content || '')}
                  </div>
                </div>
              ))}

              {/* Load more */}
              {pagination?.hasMore && (
                <button
                  onClick={handleLoadMore}
                  disabled={pagination?.loadingMore}
                  style={{
                    padding: '10px 16px',
                    background: 'transparent',
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: tokens.radius.md,
                    color: tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    cursor: pagination?.loadingMore ? 'not-allowed' : 'pointer',
                    opacity: pagination?.loadingMore ? 0.6 : 1,
                    width: '100%',
                    marginTop: 4,
                  }}
                >
                  {pagination?.loadingMore ? t('loading') : t('loadMoreComments')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
