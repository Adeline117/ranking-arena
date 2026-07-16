'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon } from '../../ui/icons'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import { renderWithStickers, hasStickers } from '../../ui/StickerRenderer'
import { commentStyles, REPLIES_PREVIEW_COUNT, type Comment } from './comment-types'
import type { ReplyTarget, ReplyTargetSetter } from './reply-types'
import { ProBadge, CommentAvatar } from './CommentAvatar'
import { useCommentDraftPersistence } from '../hooks/useCommentDraftPersistence'
import { useEffect, useRef } from 'react'

// An "edited" badge should only appear on genuine edits. A bare
// `updated_at !== created_at` check is too strict: bulk data operations (e.g.
// backfills that touch updated_at) leave every row with a sub-second timestamp
// skew and light up the badge on comments no user ever edited. Require a real
// gap (>60s) before treating a comment as edited. (U8-8)
const EDIT_THRESHOLD_MS = 60_000
function isEdited(createdAt: string, updatedAt?: string | null): boolean {
  if (!updatedAt) return false
  const created = Date.parse(createdAt)
  const updated = Date.parse(updatedAt)
  if (Number.isNaN(created) || Number.isNaN(updated)) return false
  return updated - created > EDIT_THRESHOLD_MS
}

export interface CommentThreadProps {
  comment: Comment
  isReply?: boolean
  postId: string
  currentUserId: string | null
  language: string
  t: (key: string) => string
  // Reply
  viewerKey: string
  replyingTo: ReplyTarget | null
  setReplyingTo: ReplyTargetSetter
  submittingReply: boolean
  onSubmitReply: (postId: string, parentId: string, content: string) => Promise<boolean>
  // Like
  commentLikeLoading: Record<string, boolean>
  onToggleCommentLike: (postId: string, commentId: string) => void
  onToggleCommentDislike?: (postId: string, commentId: string) => void
  // Delete
  deletingCommentId: string | null
  onDeleteComment: (postId: string, commentId: string) => void
  // Edit
  editingComment?: { id: string; content: string } | null
  submittingEdit?: boolean
  onStartEdit?: (comment: Comment) => void
  onCancelEdit?: (commentId?: string) => void
  onSubmitEdit?: (postId: string, commentId: string, content: string) => Promise<boolean>
  // Expand replies
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (updater: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  // Translation
  translatedComments?: Record<string, string>
}

interface ReplyComposerProps {
  postId: string
  parentId: string
  handle: string
  viewerKey: string
  submittingReply: boolean
  setReplyingTo: ReplyTargetSetter
  onSubmitReply: (postId: string, parentId: string, content: string) => Promise<boolean>
  t: (key: string) => string
}

function ReplyComposer({
  postId,
  parentId,
  handle,
  viewerKey,
  submittingReply,
  setReplyingTo,
  onSubmitReply,
  t,
}: ReplyComposerProps): React.ReactNode {
  const draftId = `reply:${postId}:${parentId}`
  const {
    draft: replyContent,
    setDraft: setReplyContent,
    captureDraftSnapshot,
    clearDraftIfUnchanged,
  } = useCommentDraftPersistence(draftId, viewerKey)

  const submitCurrentReply = async (): Promise<void> => {
    const content = replyContent.trim()
    if (submittingReply || !content) return

    const draftSnapshot = captureDraftSnapshot(draftId)
    if ((await onSubmitReply(postId, parentId, content)) && clearDraftIfUnchanged(draftSnapshot)) {
      setReplyingTo((currentTarget) =>
        currentTarget?.commentId === parentId ? null : currentTarget
      )
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submitCurrentReply()
    }
  }

  return (
    <div style={{ marginTop: 8, position: 'relative' }}>
      <textarea
        value={replyContent}
        maxLength={2000}
        onChange={(event) => {
          setReplyContent(event.target.value)
          const textarea = event.target
          textarea.style.height = 'auto'
          textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px'
        }}
        placeholder={`${t('reply')} @${handle}`}
        aria-label={`${t('reply')} @${handle}`}
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
        onClick={() => void submitCurrentReply()}
        disabled={submittingReply || !replyContent.trim()}
        style={{
          position: 'absolute',
          right: 6,
          bottom: 6,
          padding: '6px 14px',
          borderRadius: tokens.radius.sm,
          border: 'none',
          background: replyContent.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
          color: tokens.colors.white,
          fontSize: 12,
          fontWeight: 700,
          cursor: submittingReply || !replyContent.trim() ? 'default' : 'pointer',
          minHeight: 36,
        }}
      >
        {submittingReply ? '...' : t('send')}
      </button>
    </div>
  )
}

interface EditComposerProps {
  postId: string
  commentId: string
  initialContent: string
  viewerKey: string
  submittingEdit: boolean
  onCancelEdit: (commentId?: string) => void
  onSubmitEdit: (postId: string, commentId: string, content: string) => Promise<boolean>
  t: (key: string) => string
}

function EditComposer({
  postId,
  commentId,
  initialContent,
  viewerKey,
  submittingEdit,
  onCancelEdit,
  onSubmitEdit,
  t,
}: EditComposerProps): React.ReactNode {
  const draftId = `edit:${postId}:${commentId}`
  const {
    draft: editContent,
    setDraft: setEditContent,
    clearDraft,
    captureDraftSnapshot,
    clearDraftIfUnchanged,
  } = useCommentDraftPersistence(draftId, viewerKey, initialContent)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const cancelCurrentEdit = (): void => {
    clearDraft(draftId)
    onCancelEdit(commentId)
  }

  const submitCurrentEdit = async (): Promise<void> => {
    const content = editContent.trim()
    if (submittingEdit || !content) return

    const draftSnapshot = captureDraftSnapshot(draftId)
    const acknowledged = await onSubmitEdit(postId, commentId, content)
    if (acknowledged && mountedRef.current && clearDraftIfUnchanged(draftSnapshot)) {
      onCancelEdit(commentId)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submitCurrentEdit()
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) cancelCurrentEdit()
  }

  return (
    <div style={{ marginTop: 8, position: 'relative' }}>
      <textarea
        value={editContent}
        maxLength={2000}
        onChange={(e) => {
          setEditContent(e.target.value)
          const ta = e.target
          ta.style.height = 'auto'
          ta.style.height = Math.min(ta.scrollHeight, 100) + 'px'
        }}
        onKeyDown={handleKeyDown}
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
          onClick={cancelCurrentEdit}
          style={{
            padding: '6px 12px',
            borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: 'transparent',
            color: tokens.colors.text.tertiary,
            fontSize: 12,
            cursor: 'pointer',
            minHeight: 36,
          }}
        >
          {t('cancel')}
        </button>
        <button
          onClick={() => void submitCurrentEdit()}
          disabled={submittingEdit || !editContent.trim()}
          style={{
            padding: '6px 14px',
            borderRadius: tokens.radius.sm,
            border: 'none',
            background: editContent.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
            color: tokens.colors.white,
            fontSize: 12,
            fontWeight: 700,
            cursor: submittingEdit || !editContent.trim() ? 'default' : 'pointer',
            minHeight: 36,
          }}
        >
          {submittingEdit ? '...' : t('save')}
        </button>
      </div>
    </div>
  )
}

export function CommentThread({
  comment,
  isReply = false,
  postId,
  currentUserId,
  language,
  t,
  viewerKey,
  replyingTo,
  setReplyingTo,
  submittingReply,
  onSubmitReply,
  commentLikeLoading,
  onToggleCommentLike,
  onToggleCommentDislike,
  deletingCommentId,
  onDeleteComment,
  editingComment,
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
        borderLeft: isReply
          ? `2px solid var(--color-accent-primary-20, ${tokens.colors.border.primary})`
          : 'none',
        paddingLeft: isReply ? 12 : 0,
        opacity: isDeleting ? 0.5 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <div style={{ display: 'flex', gap: 10 }}>
        <CommentAvatar
          handle={comment.author_handle}
          avatarUrl={comment.author_avatar_url}
          isReply={isReply}
          isPro={comment.author_is_pro}
          showProBadge={comment.author_show_pro_badge}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Author info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <Link
              href={authorHref}
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                textDecoration: 'none',
              }}
            >
              {comment.author_handle || 'user'}
            </Link>
            {showProBadge && <ProBadge />}
            <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
              {formatTimeAgo(comment.created_at, language as Locale)}
              {comment.updated_at && isEdited(comment.created_at, comment.updated_at) && (
                <span
                  title={new Date(comment.updated_at).toLocaleString()}
                  style={{ marginLeft: 4, fontStyle: 'italic' }}
                >
                  ({t('edited')})
                </span>
              )}
            </span>
          </div>

          {/* Content */}
          <div
            translate="no"
            style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}
          >
            {hasStickers(displayContent || '')
              ? renderWithStickers(displayContent || '', 64)
              : renderContentWithLinks(displayContent || '')}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6 }}>
            <button
              className="interactive-scale"
              aria-label={t('upvote')}
              onClick={(e) => {
                e.stopPropagation()
                onToggleCommentLike(postId, comment.id)
              }}
              disabled={commentLikeLoading[comment.id]}
              style={{
                ...commentStyles.actionButton,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: comment.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
                background: comment.user_liked ? 'var(--color-accent-primary-12)' : 'transparent',
              }}
            >
              <ThumbsUpIcon size={14} />
              {(comment.like_count || 0) > 0 && (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{comment.like_count}</span>
              )}
            </button>

            <button
              className="interactive-scale"
              aria-label={t('downvote')}
              onClick={(e) => {
                e.stopPropagation()
                onToggleCommentDislike?.(postId, comment.id)
              }}
              disabled={commentLikeLoading[comment.id]}
              style={{
                ...commentStyles.actionButton,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: comment.user_disliked
                  ? tokens.colors.accent.error
                  : tokens.colors.text.tertiary,
                background: comment.user_disliked ? 'var(--color-accent-error-12)' : 'transparent',
              }}
            >
              <ThumbsDownIcon size={14} />
              {(comment.dislike_count || 0) > 0 && (
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{comment.dislike_count}</span>
              )}
            </button>

            {!isReply && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setReplyingTo(
                    replyingTo?.commentId === comment.id
                      ? null
                      : { commentId: comment.id, handle: comment.author_handle || 'user' }
                  )
                }}
                style={commentStyles.actionButton}
              >
                {t('reply')}
              </button>
            )}

            {isOwn && onStartEdit && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onStartEdit(comment)
                }}
                style={commentStyles.actionButton}
              >
                {t('edit')}
              </button>
            )}

            {isOwn && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteComment(postId, comment.id)
                }}
                disabled={isDeleting}
                style={commentStyles.actionButton}
              >
                {t('delete')}
              </button>
            )}
          </div>

          {/* Edit input */}
          {editingComment?.id === comment.id && onSubmitEdit && onCancelEdit && (
            <EditComposer
              key={`${viewerKey}\u0000${postId}\u0000${comment.id}`}
              postId={postId}
              commentId={comment.id}
              initialContent={editingComment.content}
              viewerKey={viewerKey}
              submittingEdit={submittingEdit || false}
              onCancelEdit={onCancelEdit}
              onSubmitEdit={onSubmitEdit}
              t={t}
            />
          )}

          {/* Reply input */}
          {replyingTo?.commentId === comment.id && (
            <ReplyComposer
              postId={postId}
              parentId={comment.id}
              handle={replyingTo.handle}
              viewerKey={viewerKey}
              submittingReply={submittingReply}
              setReplyingTo={setReplyingTo}
              onSubmitReply={onSubmitReply}
              t={t}
            />
          )}

          {/* Replies */}
          {visibleReplies && visibleReplies.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {visibleReplies.map((reply) => (
                <CommentThread
                  key={reply.id}
                  comment={reply}
                  isReply
                  postId={postId}
                  currentUserId={currentUserId}
                  language={language}
                  t={t}
                  viewerKey={viewerKey}
                  replyingTo={replyingTo}
                  setReplyingTo={setReplyingTo}
                  submittingReply={submittingReply}
                  onSubmitReply={onSubmitReply}
                  commentLikeLoading={commentLikeLoading}
                  onToggleCommentLike={onToggleCommentLike}
                  onToggleCommentDislike={onToggleCommentDislike}
                  deletingCommentId={deletingCommentId}
                  onDeleteComment={onDeleteComment}
                  editingComment={editingComment}
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
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpandedReplies((prev) => ({ ...prev, [comment.id]: true }))
                  }}
                  style={{
                    ...commentStyles.actionButton,
                    color: ARENA_PURPLE,
                    padding: '4px 0',
                    marginTop: 4,
                  }}
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
