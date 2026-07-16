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
  loadPostForViewer,
  loadPostComments,
  loadMorePostComments,
  submitPostComment,
  togglePostReaction,
  type CommentData,
} from '@/lib/stores/postStore'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { useCommentDraftPersistence } from './hooks/useCommentDraftPersistence'

type PostDetailModalProps = {
  postId: string
  onClose: () => void
}

const EMPTY_COMMENTS: CommentData[] = []

export default function PostDetailModal({ postId, onClose }: PostDetailModalProps) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const auth = useAuthSession()

  const {
    draft: newComment,
    setDraft: setNewComment,
    captureDraftSnapshot,
    clearDraftIfUnchanged,
  } = useCommentDraftPersistence(postId, auth.viewerKey)
  const [submittingComment, setSubmittingComment] = useState(false)
  const [reacting, setReacting] = useState(false)

  // Prevent duplicate submissions
  const commentPendingRef = useRef<symbol | null>(null)
  const reactionPendingRef = useRef<symbol | null>(null)
  const authScopeRef = useRef({
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  })
  const loadedCommentScopeRef = useRef<string | null>(null)
  authScopeRef.current = {
    viewerKey: auth.viewerKey,
    sessionGeneration: auth.sessionGeneration,
    userId: auth.userId,
  }
  const dialogRef = useRef<HTMLDivElement>(null)

  useModalA11y({ open: true, onClose, modalRef: dialogRef })

  // Read from canonical store
  const post = usePostStore((s) =>
    s.viewerKey === auth.viewerKey && s.sessionGeneration === auth.sessionGeneration
      ? s.posts[postId]
      : undefined
  )
  const comments = usePostStore((s) =>
    s.viewerKey === auth.viewerKey && s.sessionGeneration === auth.sessionGeneration
      ? s.comments[postId] || EMPTY_COMMENTS
      : EMPTY_COMMENTS
  )
  const pagination = usePostStore((s) =>
    s.viewerKey === auth.viewerKey && s.sessionGeneration === auth.sessionGeneration
      ? s.commentsPagination[postId]
      : undefined
  )

  // Load comments on mount
  useEffect(() => {
    const scope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    usePostStore.getState().setViewerScope(scope.viewerKey, scope.sessionGeneration)
    if (!auth.authChecked) {
      loadedCommentScopeRef.current = null
      commentPendingRef.current = null
      reactionPendingRef.current = null
      setSubmittingComment(false)
      setReacting(false)
      return
    }
    const resourceScopeKey = `${auth.viewerKey}\u0000${auth.sessionGeneration}\u0000${postId}`
    if (loadedCommentScopeRef.current === resourceScopeKey) return
    loadedCommentScopeRef.current = resourceScopeKey
    commentPendingRef.current = null
    reactionPendingRef.current = null
    setSubmittingComment(false)
    setReacting(false)
    void loadPostForViewer(postId, auth.accessToken, scope)
    void loadPostComments(postId, auth.accessToken, scope)
  }, [
    postId,
    auth.authChecked,
    auth.accessToken,
    auth.userId,
    auth.viewerKey,
    auth.sessionGeneration,
  ])

  const handleSubmitComment = useCallback(async () => {
    // Prevent duplicate submissions
    if (commentPendingRef.current || !auth.authChecked) return

    const token = auth.isLoggedIn ? auth.accessToken : null
    if (!token) return
    if (!newComment.trim()) return

    const scope = {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    }
    const operation = Symbol('modal-comment')
    const draftSnapshot = captureDraftSnapshot(postId)
    commentPendingRef.current = operation
    setSubmittingComment(true)
    try {
      const result = await submitPostComment(postId, newComment.trim(), token, scope)
      const current = authScopeRef.current
      if (
        current.viewerKey !== scope.viewerKey ||
        current.sessionGeneration !== scope.sessionGeneration ||
        current.userId !== scope.userId
      ) {
        return
      }
      if ('error' in result) {
        if (result.error !== 'STALE_AUTH_SCOPE') showToast(result.error, 'error')
      } else {
        clearDraftIfUnchanged(draftSnapshot)
      }
    } catch {
      const current = authScopeRef.current
      if (
        current.viewerKey === scope.viewerKey &&
        current.sessionGeneration === scope.sessionGeneration &&
        current.userId === scope.userId
      ) {
        showToast(t('commentFailedRetry'), 'error')
      }
    } finally {
      if (commentPendingRef.current === operation) {
        commentPendingRef.current = null
        setSubmittingComment(false)
      }
    }
  }, [postId, newComment, auth, showToast, t, captureDraftSnapshot, clearDraftIfUnchanged])

  const handleReaction = useCallback(
    async (reactionType: 'up' | 'down') => {
      // Prevent duplicate reactions
      if (reactionPendingRef.current || reacting || !auth.authChecked) return

      const token = auth.isLoggedIn ? auth.accessToken : null
      if (!token) return

      const scope = {
        viewerKey: auth.viewerKey,
        sessionGeneration: auth.sessionGeneration,
        userId: auth.userId,
      }
      const operation = Symbol('modal-reaction')
      reactionPendingRef.current = operation
      setReacting(true)
      try {
        const result = await togglePostReaction(postId, reactionType, token, scope)
        const current = authScopeRef.current
        if (
          current.viewerKey !== scope.viewerKey ||
          current.sessionGeneration !== scope.sessionGeneration ||
          current.userId !== scope.userId
        ) {
          return
        }
        if (!result.success) {
          if (result.error !== 'STALE_AUTH_SCOPE') {
            showToast(result.error || t('operationFailed'), 'error')
          }
        }
      } catch {
        const current = authScopeRef.current
        if (
          current.viewerKey === scope.viewerKey &&
          current.sessionGeneration === scope.sessionGeneration &&
          current.userId === scope.userId
        ) {
          showToast(t('operationFailedRetry'), 'error')
        }
      } finally {
        if (reactionPendingRef.current === operation) {
          reactionPendingRef.current = null
          setReacting(false)
        }
      }
    },
    [postId, auth, showToast, reacting, t]
  )

  const handleLoadMore = useCallback(() => {
    if (!auth.authChecked) return
    void loadMorePostComments(postId, auth.accessToken, {
      viewerKey: auth.viewerKey,
      sessionGeneration: auth.sessionGeneration,
      userId: auth.userId,
    })
  }, [
    postId,
    auth.accessToken,
    auth.authChecked,
    auth.sessionGeneration,
    auth.userId,
    auth.viewerKey,
  ])

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
        aria-label={t('postDetail')}
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
