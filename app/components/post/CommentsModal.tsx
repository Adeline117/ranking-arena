'use client'

import { useState, useEffect, useRef, type CSSProperties } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon } from '../ui/icons'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { formatTimeAgo } from '@/lib/utils/date'
import { useLanguage } from '../Providers/LanguageProvider'
import { CompactErrorBoundary } from '../utils/ErrorBoundary'
import { useToast } from '../ui/Toast'
import type { Comment } from './hooks/usePostComments'
import { ProBadgeOverlay } from '../ui/ProBadge'

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
  onToggleCommentDislike?: (postId: string, commentId: string) => void
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

function EmptyComments({ t }: { t: (key: string) => string }): React.ReactNode {
  return (
    <div style={{ textAlign: 'center', padding: '32px 16px', color: tokens.colors.text.tertiary }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 8px' }}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{t('noCommentsYet')}</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>{t('beFirstToComment')}</div>
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
function CommentAvatar({ handle, avatarUrl, isReply, isPro, showProBadge }: { handle?: string | null; avatarUrl?: string | null; isReply: boolean; isPro?: boolean; showProBadge?: boolean }): React.ReactNode {
  const size = isReply ? 24 : 32
  const href = handle ? `/u/${encodeURIComponent(handle)}` : '#'

  return (
    <Link href={href} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none', flexShrink: 0, position: 'relative' }}>
      {avatarUrl ? (
        <Image src={avatarUrl} alt="" width={size} height={size} style={styles.avatar(size)} unoptimized />
      ) : (
        <div style={styles.avatarPlaceholder(size)}>
          {(handle?.[0] || 'A').toUpperCase()}
        </div>
      )}
      {isPro && showProBadge !== false && <ProBadgeOverlay position="bottom-right" />}
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
  onToggleCommentDislike,
  deletingCommentId,
  onDeleteComment,
  expandedReplies,
  setExpandedReplies,
  translatedComments = {},
}: CommentsModalProps) {
  const { language, t } = useLanguage()
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const { showToast } = useToast()

  // Close emoji picker on outside click
  useEffect(() => {
    if (!showEmojiPicker) return
    const handler = () => setShowEmojiPicker(false)
    const timer = setTimeout(() => document.addEventListener('click', handler), 0)
    return () => { clearTimeout(timer); document.removeEventListener('click', handler) }
  }, [showEmojiPicker])
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

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        // Prevent double-submission
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

              <button
                onClick={(e) => { e.stopPropagation(); onToggleCommentDislike?.(postId, comment.id) }}
                disabled={commentLikeLoading[comment.id]}
                style={{
                  ...styles.actionButton,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  borderRadius: 4,
                  color: comment.user_disliked ? '#ef4444' : tokens.colors.text.tertiary,
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
                  style={styles.actionButton}
                >
                  {t('reply')}
                </button>
              )}

              {isOwn && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteComment(postId, comment.id) }}
                  disabled={isDeleting}
                  style={styles.actionButton}
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
                  onKeyDown={handleKeyDown}
                  rows={1}
                  style={{
                    ...styles.input,
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
                    borderRadius: 6,
                    border: 'none',
                    background: replyContent.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
                    color: '#fff',
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
                {visibleReplies.map(reply => renderComment(reply, true))}
                {hiddenReplyCount > 0 && !expandedReplies[comment.id] && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedReplies(prev => ({ ...prev, [comment.id]: true })) }}
                    style={{ ...styles.actionButton, color: ARENA_PURPLE, padding: '4px 0', marginTop: 4 }}
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

  return (
    <div style={{ marginTop: 16 }}>
      {/* Comment input - auto-expanding with inline actions */}
      <div style={{ marginBottom: 16, position: 'relative' }}>
        <div
          style={{
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: 16,
            background: tokens.colors.bg.tertiary,
            padding: '10px 14px',
            paddingBottom: 38,
            transition: 'border-color 0.2s',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = ARENA_PURPLE }}
          onBlur={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary }}
        >
          <textarea
            ref={commentInputRef}
            value={newComment}
            onChange={(e) => {
              setNewComment(e.target.value)
              // Auto-expand
              const ta = e.target
              ta.style.height = 'auto'
              ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
            }}
            placeholder={t('writeComment')}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (submittingComment || !newComment.trim()) return
                onSubmitComment(postId)
              }
            }}
            style={{
              width: '100%',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: tokens.colors.text.primary,
              fontSize: 14,
              resize: 'none',
              outline: 'none',
              minHeight: 22,
              maxHeight: 160,
              lineHeight: '22px',
              fontFamily: 'inherit',
              overflow: 'hidden',
            }}
          />

          {/* Toolbar row - bottom of input box */}
          <div style={{
            position: 'absolute',
            bottom: 6,
            left: 10,
            right: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            {/* Left: action buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {/* Emoji picker */}
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setShowEmojiPicker(prev => !prev)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 4,
                    borderRadius: 6,
                    color: tokens.colors.text.tertiary,
                    fontSize: 18,
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  title={language === 'zh' ? '表情' : 'Emoji'}
                >
                  :)
                </button>
                {showEmojiPicker && (
                  <div style={{
                    position: 'absolute',
                    bottom: 32,
                    left: 0,
                    background: tokens.colors.bg.secondary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    borderRadius: 12,
                    padding: 8,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(8, 1fr)',
                    gap: 2,
                    zIndex: 100,
                    boxShadow: tokens.shadow.lg,
                    width: 280,
                  }}>
                    {[':)',':D','XD','<3',';)',':P','B)',':/',
                      '+1','-1','hot','100','go','$','up','dn',
                      'bull','bear','gem','hi','!?','$$','strong','luv',
                      'eye','aim','zap','moon','sun','deal','yay','rip'].map(emoji => (
                      <button
                        key={emoji}
                        onClick={() => {
                          setNewComment(newComment + emoji)
                          setShowEmojiPicker(false)
                          commentInputRef.current?.focus()
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          fontSize: 13,
                          cursor: 'pointer',
                          padding: 4,
                          borderRadius: 4,
                          lineHeight: 1,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* @ mention */}
              <button
                type="button"
                onClick={() => {
                  setNewComment(newComment + '@')
                  commentInputRef.current?.focus()
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 6,
                  color: tokens.colors.text.tertiary,
                  fontSize: 14,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
                title={language === 'zh' ? '@提及用户' : '@Mention'}
              >
                @
              </button>

              {/* Image (placeholder for future) */}
              <button
                type="button"
                onClick={() => {
                  // TODO: implement image upload in comments
                  if (typeof window !== 'undefined') {
                    const input = document.createElement('input')
                    input.type = 'file'
                    input.accept = 'image/*'
                    input.onchange = () => {
                      // Future: upload and attach image
                      showToast(language === 'zh' ? '评论图片功能即将上线' : 'Comment images coming soon', 'info' as 'success')
                    }
                    input.click()
                  }
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 6,
                  color: tokens.colors.text.tertiary,
                  fontSize: 15,
                  lineHeight: 1,
                  display: 'flex',
                  alignItems: 'center',
                }}
                title={language === 'zh' ? '图片' : 'Image'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
              </button>
            </div>

            {/* Right: send button */}
            <button
              onClick={() => onSubmitComment(postId)}
              disabled={submittingComment || !newComment.trim()}
              style={{
                padding: '4px 12px',
                borderRadius: 8,
                border: 'none',
                background: newComment.trim() ? ARENA_PURPLE : `${ARENA_PURPLE}40`,
                color: '#fff',
                fontSize: 13,
                fontWeight: 700,
                cursor: submittingComment || !newComment.trim() ? 'default' : 'pointer',
                opacity: submittingComment ? 0.6 : 1,
                transition: 'all 0.2s',
                lineHeight: '22px',
              }}
            >
              {submittingComment ? '...' : t('send')}
            </button>
          </div>
        </div>
      </div>

      {/* Comments list */}
      <CompactErrorBoundary>
        {loadingComments ? (
          <CommentSkeleton />
        ) : comments.length === 0 ? (
          <EmptyComments t={t} />
        ) : (
          <div>
            {comments.map(comment => renderComment(comment))}
          </div>
        )}
      </CompactErrorBoundary>
    </div>
  )
}
