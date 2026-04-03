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
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { formatTimeAgo } from '@/lib/utils/date'
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'
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
  const auth = useUnifiedAuth({
    onUnauthenticated: () => showToast(t('pleaseLogin'), 'warning'),
  })

  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [reacting, setReacting] = useState(false)

  // Prevent duplicate submissions
  const commentPendingRef = useRef(false)
  const reactionPendingRef = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  // Focus management: trap focus, handle Escape, restore focus on close
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const timer = setTimeout(() => {
      if (dialogRef.current) {
        const firstFocusable = dialogRef.current.querySelector<HTMLElement>(
          'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])'
        )
        firstFocusable?.focus()
      }
    }, 50)

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [onClose])

  // Read from canonical store
  const post = usePostStore(s => s.posts[postId])
  const comments = usePostStore(s => s.comments[postId] || [])
  const pagination = usePostStore(s => s.commentsPagination[postId])

  // Load comments on mount
  useEffect(() => {
    loadPostComments(postId)
  }, [postId])

  const handleSubmitComment = useCallback(async () => {
    // Prevent duplicate submissions
    if (commentPendingRef.current) return

    const token = auth.requireAuth()
    if (!token) return
    if (!newComment.trim()) return

    commentPendingRef.current = true
    setSubmittingComment(true)
    try {
      const result = await submitPostComment(postId, newComment.trim(), token)
      if ('error' in result) {
        showToast(result.error, 'error')
      } else {
        setNewComment('')
      }
    } catch {
      showToast(t('commentFailedRetry'), 'error')
    } finally {
      setSubmittingComment(false)
      commentPendingRef.current = false
    }
  }, [postId, newComment, auth, showToast, t])

  const handleReaction = useCallback(async (reactionType: 'up' | 'down') => {
    // Prevent duplicate reactions
    if (reactionPendingRef.current || reacting) return

    const token = auth.requireAuth()
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
  }, [postId, auth, showToast, reacting, t])

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
              fontSize: 20,
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
            style={{ fontSize: 12, color: ARENA_PURPLE, textDecoration: 'none' }}
          >
            {post.group_name || t('generalDiscussion')}
          </Link>
        ) : (
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{t('generalDiscussion')}</div>
        )}

        {/* Title */}
        <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.25, marginTop: 8 }}>
          {post.title}
        </div>

        {/* Meta: author (clickable) + time + comments */}
        <div style={{
          marginTop: 8,
          fontSize: 12,
          color: tokens.colors.text.tertiary,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <Link
            href={`/u/${encodeURIComponent(post.author_handle)}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: tokens.colors.text.secondary, textDecoration: 'none', fontWeight: 600 }}
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
            fontSize: 14,
            color: tokens.colors.text.primary,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
          }}
        >
          {renderContentWithLinks(post.content || '')}
        </div>

        {/* Reactions */}
        <div style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: `1px solid ${tokens.colors.border.secondary}`,
          display: 'flex',
          gap: 14,
          flexWrap: 'wrap',
        }}>
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
              background: post.user_reaction === 'up' ? `${tokens.colors.accent.success}20` : tokens.colors.bg.tertiary,
              color: post.user_reaction === 'up' ? tokens.colors.accent.success : tokens.colors.text.secondary,
              cursor: reacting ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
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
              background: post.user_reaction === 'down' ? `${tokens.colors.accent.error}20` : tokens.colors.bg.tertiary,
              color: post.user_reaction === 'down' ? tokens.colors.accent.error : tokens.colors.text.secondary,
              cursor: reacting ? 'not-allowed' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
              opacity: reacting ? 0.6 : 1,
            }}
          >
            <ThumbsDownIcon size={14} />
          </button>
        </div>

        {/* Comments Section */}
        <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.colors.border.secondary}`, paddingTop: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 12 }}>
            {t('comments')} ({post.comment_count})
          </div>

          {/* Comment input */}
          <div style={{ marginBottom: 16 }}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={auth.isAuthenticated ? t('writeComment') : t('loginBeforeComment')}
              aria-label={t('writeComment')}
              disabled={!auth.isAuthenticated || submittingComment}
              style={{
                width: '100%',
                minHeight: 80,
                padding: 12,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: 14,
                resize: 'vertical',
                outline: 'none',
              }}
            />
            {auth.isAuthenticated && (
              <button
                onClick={handleSubmitComment}
                disabled={!newComment.trim() || submittingComment}
                style={{
                  marginTop: 8,
                  padding: '8px 16px',
                  background: newComment.trim() && !submittingComment ? ARENA_PURPLE : 'var(--color-accent-primary-30)',
                  color: tokens.colors.white,
                  border: 'none',
                  borderRadius: tokens.radius.md,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: newComment.trim() && !submittingComment ? 'pointer' : 'not-allowed',
                }}
              >
                {submittingComment ? t('submittingComment') : t('postComment')}
              </button>
            )}
          </div>

          {/* Comment list */}
          {pagination?.loading ? (
            <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>{t('loadingComments')}</div>
          ) : comments.length === 0 ? (
            <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>{t('noCommentsBeFirst')}</div>
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
                        style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary, textDecoration: 'none' }}
                      >
                        {comment.author_handle}
                      </Link>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.tertiary }}>
                        {'user'}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                      {formatTimeAgo(comment.created_at, language)}
                    </span>
                  </div>
                  <div translate="no" style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
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
                    fontSize: 13,
                    fontWeight: 600,
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
