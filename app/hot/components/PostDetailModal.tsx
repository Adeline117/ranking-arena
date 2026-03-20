'use client'

import { createPortal } from 'react-dom'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { CommentIcon, ThumbsUpIcon, ThumbsDownIcon } from '@/app/components/ui/icons'
import { renderContentWithLinks } from '@/lib/utils/content'
import { formatTimeAgo } from '@/lib/utils/date'
import type { Post, Comment } from '../types'

const ARENA_PURPLE = tokens.colors.accent.brand

interface PostDetailModalProps {
  post: Post
  comments: Comment[]
  loadingComments: boolean
  hasMoreComments: boolean
  loadingMoreComments: boolean
  newComment: string
  setNewComment: (v: string) => void
  submittingComment: boolean
  translatedContent: string | null
  showingOriginal: boolean
  translating: boolean
  accessToken: string | null
  onClose: () => void
  onSubmitComment: (postId: string) => void
  onToggleReaction: (postId: string, type: 'up' | 'down') => void
  onToggleOriginal: () => void
  onLoadMoreComments: () => void
  localizedName: (zh: string, en?: string | null) => string
  t: (key: string) => string
}

export function PostDetailModal({
  post, comments, loadingComments, hasMoreComments, loadingMoreComments,
  newComment, setNewComment, submittingComment,
  translatedContent, showingOriginal, translating,
  accessToken, onClose, onSubmitComment, onToggleReaction,
  onToggleOriginal, onLoadMoreComments, localizedName, t,
}: PostDetailModalProps) {
  return createPortal(
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={post.title}
      className="post-modal-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--color-blur-overlay)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: tokens.zIndex.modal,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="post-modal-content"
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid var(--color-border-primary)`,
          borderRadius: tokens.radius.xl,
          background: 'var(--color-bg-secondary)',
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
              color: 'var(--color-text-secondary)',
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
            ×
          </button>
        </div>

        {/* Group name */}
        {post.group_id ? (
          <Link
            href={`/groups/${post.group_id}`}
            style={{
              fontSize: 12,
              color: ARENA_PURPLE,
              textDecoration: 'none',
              fontWeight: 600,
              padding: '2px 8px',
              background: `${ARENA_PURPLE}20`,
              borderRadius: tokens.radius.sm,
              display: 'inline-block',
            }}
          >
            {localizedName(post.group, post.group_en)}
          </Link>
        ) : (
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
            {localizedName(post.group, post.group_en)}
          </div>
        )}

        {/* Title */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.25 }}>{post.title}</div>
        </div>

        {/* Author */}
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          {post.author_handle ? (
            <Link
              href={`/u/${encodeURIComponent(post.author_handle)}`}
              style={{
                color: 'var(--color-text-secondary)',
                textDecoration: 'none',
                fontWeight: 700,
              }}
            >
              @{post.author}
            </Link>
          ) : (
            <span>{post.author}</span>
          )}
          <span>·</span>
          <span>{post.time}</span>
          <span>·</span>
          <CommentIcon size={12} />
          <span>{post.comments}</span>
        </div>

        {/* Body */}
        <div translate="no" style={{ marginTop: 12, fontSize: 14, color: 'var(--color-text-primary)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {showingOriginal
            ? renderContentWithLinks(post.body || '')
            : renderContentWithLinks(translatedContent || post.body || '')
          }
        </div>

        {/* Translation toggle */}
        {(translatedContent || translating) && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={onToggleOriginal}
              disabled={translating}
              style={{
                padding: '4px 10px',
                fontSize: 12,
                fontWeight: 600,
                border: `1px solid var(--color-border-primary)`,
                borderRadius: 6,
                background: 'var(--color-bg-tertiary)',
                color: 'var(--color-text-secondary)',
                cursor: translating ? 'wait' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {translating ? (
                <>{t('translating')}</>
              ) : showingOriginal ? (
                <>{t('viewTranslation')}</>
              ) : (
                <>{t('viewOriginal')}</>
              )}
            </button>
            {!showingOriginal && (
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {t('translatedByAI')}
              </span>
            )}
          </div>
        )}

        {/* Reaction buttons */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid var(--color-border-secondary)`, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <button
            onClick={() => onToggleReaction(post.id, 'up')}
            aria-label={`Like (${post.likes})`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              border: 'none',
              borderRadius: tokens.radius.md,
              background: post.user_reaction === 'up' ? `var(--color-accent-success-20)` : 'var(--color-bg-tertiary)',
              color: post.user_reaction === 'up' ? 'var(--color-accent-success)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <ThumbsUpIcon size={14} /> {post.likes}
          </button>
          <button
            onClick={() => onToggleReaction(post.id, 'down')}
            aria-label={`Dislike${(post.dislikes ?? 0) > 0 ? ` (${post.dislikes})` : ''}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              border: 'none',
              borderRadius: tokens.radius.md,
              background: post.user_reaction === 'down' ? `var(--color-accent-error-20)` : 'var(--color-bg-tertiary)',
              color: post.user_reaction === 'down' ? 'var(--color-accent-error)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <ThumbsDownIcon size={14} /> {(post.dislikes ?? 0) > 0 ? post.dislikes : ''}
          </button>
        </div>

        {/* Comments section */}
        <div style={{ marginTop: 16, borderTop: `1px solid var(--color-border-secondary)`, paddingTop: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 12 }}>
            {t('comments')} ({post.comments})
          </div>

          {/* Comment input */}
          <div style={{ marginBottom: 16 }}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={accessToken ? t('writeComment') : t('loginToComment')}
              disabled={!accessToken || submittingComment}
              style={{
                width: '100%',
                minHeight: 80,
                padding: 12,
                borderRadius: tokens.radius.md,
                border: `1px solid var(--color-border-primary)`,
                background: 'var(--color-bg-primary)',
                color: 'var(--color-text-primary)',
                fontSize: 14,
                resize: 'vertical',
                outline: 'none',
              }}
            />
            {accessToken && (
              <button
                onClick={() => onSubmitComment(post.id)}
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
                {submittingComment ? t('sending') : t('postComment')}
              </button>
            )}
          </div>

          {/* Comments list */}
          {loadingComments ? (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>{t('loadingComments')}</div>
          ) : comments.length === 0 ? (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13 }}>{t('noCommentsYet')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {comments.filter(Boolean).map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    padding: 12,
                    background: 'var(--color-bg-primary)',
                    borderRadius: tokens.radius.md,
                    border: `1px solid var(--color-border-primary)`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    {comment.author_handle ? (
                      <Link
                        href={`/u/${encodeURIComponent(comment.author_handle)}`}
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: 'var(--color-text-secondary)',
                          textDecoration: 'none',
                        }}
                      >
                        @{comment.author_handle}
                      </Link>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
                        {'user'}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {formatTimeAgo(comment.created_at)}
                    </span>
                  </div>
                  <div translate="no" style={{ fontSize: 13, color: 'var(--color-text-primary)', lineHeight: 1.6 }}>
                    {renderContentWithLinks(comment.content || '')}
                  </div>
                </div>
              ))}

              {/* Load more comments */}
              {hasMoreComments && (
                <button
                  onClick={onLoadMoreComments}
                  disabled={loadingMoreComments}
                  style={{
                    padding: '10px 16px',
                    background: 'transparent',
                    border: `1px solid var(--color-border-primary)`,
                    borderRadius: tokens.radius.md,
                    color: 'var(--color-text-secondary)',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: loadingMoreComments ? 'not-allowed' : 'pointer',
                    opacity: loadingMoreComments ? 0.6 : 1,
                    transition: `all ${tokens.transition.base}`,
                    width: '100%',
                    marginTop: 4,
                  }}
                  onMouseEnter={(e) => {
                    if (!loadingMoreComments) {
                      e.currentTarget.style.borderColor = 'var(--color-accent-primary)'
                      e.currentTarget.style.color = 'var(--color-accent-primary)'
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border-primary)'
                    e.currentTarget.style.color = 'var(--color-text-secondary)'
                  }}
                >
                  {loadingMoreComments ? t('loading') : t('loadMoreComments')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
