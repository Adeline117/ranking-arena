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

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../icons'
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

const ARENA_PURPLE = '#8b6fa8'

function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: ARENA_PURPLE,
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part}
        </a>
      )
    }
    return part
  })
}

type PostDetailModalProps = {
  postId: string
  onClose: () => void
}

export default function PostDetailModal({ postId, onClose }: PostDetailModalProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const auth = useUnifiedAuth({
    onUnauthenticated: () => showToast('请先登录', 'warning'),
  })

  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)

  // Read from canonical store
  const post = usePostStore(s => s.posts[postId])
  const comments = usePostStore(s => s.comments[postId] || [])
  const pagination = usePostStore(s => s.commentsPagination[postId])

  // Load comments on mount
  useEffect(() => {
    loadPostComments(postId)
  }, [postId])

  const handleSubmitComment = useCallback(async () => {
    const token = auth.requireAuth()
    if (!token) return
    if (!newComment.trim()) return

    setSubmittingComment(true)
    const result = await submitPostComment(postId, newComment.trim(), token)
    setSubmittingComment(false)

    if ('error' in result) {
      showToast(result.error, 'error')
    } else {
      setNewComment('')
    }
  }, [postId, newComment, auth, showToast])

  const handleReaction = useCallback(async (reactionType: 'up' | 'down') => {
    const token = auth.requireAuth()
    if (!token) return

    const result = await togglePostReaction(postId, reactionType, token)
    if (!result.success) {
      showToast(result.error || '操作失败', 'error')
    }
  }, [postId, auth, showToast])

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
            borderRadius: 16,
            color: tokens.colors.text.secondary,
          }}
        >
          加载中...
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
        padding: 20,
        zIndex: tokens.zIndex.modal,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
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
              borderRadius: 8,
            }}
          >
            &times;
          </button>
        </div>

        {/* Group link */}
        {post.group_id ? (
          <Link
            href={`/groups/${post.group_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 12, color: ARENA_PURPLE, textDecoration: 'none' }}
          >
            {post.group_name || '综合讨论'}
          </Link>
        ) : (
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>综合讨论</div>
        )}

        {/* Title */}
        <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.25, marginTop: 8 }}>
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
            href={`/u/${post.author_handle}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: tokens.colors.text.secondary, textDecoration: 'none', fontWeight: 600 }}
          >
            {post.author_handle || '匿名'}
          </Link>
          <span>&middot;</span>
          <span>{formatTimeAgo(post.created_at)}</span>
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
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              border: 'none',
              borderRadius: 8,
              background: post.user_reaction === 'up' ? `${tokens.colors.accent.success}20` : tokens.colors.bg.tertiary,
              color: post.user_reaction === 'up' ? tokens.colors.accent.success : tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <ThumbsUpIcon size={14} /> {post.like_count}
          </button>
          <button
            onClick={() => handleReaction('down')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              border: 'none',
              borderRadius: 8,
              background: post.user_reaction === 'down' ? `${tokens.colors.accent.error}20` : tokens.colors.bg.tertiary,
              color: post.user_reaction === 'down' ? tokens.colors.accent.error : tokens.colors.text.secondary,
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <ThumbsDownIcon size={14} />
          </button>
        </div>

        {/* Comments Section */}
        <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.colors.border.secondary}`, paddingTop: 16 }}>
          <div style={{ fontWeight: 950, marginBottom: 12 }}>
            {t('comments')} ({post.comment_count})
          </div>

          {/* Comment input */}
          <div style={{ marginBottom: 16 }}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder={auth.isAuthenticated ? t('writeComment') : '请先登录后发表评论'}
              disabled={!auth.isAuthenticated || submittingComment}
              style={{
                width: '100%',
                minHeight: 80,
                padding: 12,
                borderRadius: 8,
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
                  background: newComment.trim() && !submittingComment ? ARENA_PURPLE : 'rgba(139, 111, 168, 0.3)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: newComment.trim() && !submittingComment ? 'pointer' : 'not-allowed',
                }}
              >
                {submittingComment ? '发送中...' : '发表评论'}
              </button>
            )}
          </div>

          {/* Comment list */}
          {pagination?.loading ? (
            <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>加载评论中...</div>
          ) : comments.length === 0 ? (
            <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>暂无评论，来发表第一条评论吧</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {comments.filter(Boolean).map((comment) => (
                <div
                  key={comment.id}
                  style={{
                    padding: 12,
                    background: tokens.colors.bg.primary,
                    borderRadius: 8,
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <Link
                      href={`/u/${comment.author_handle || ''}`}
                      onClick={(e) => e.stopPropagation()}
                      style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary, textDecoration: 'none' }}
                    >
                      {comment.author_handle || '匿名'}
                    </Link>
                    <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                      {formatTimeAgo(comment.created_at)}
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
                    borderRadius: 8,
                    color: tokens.colors.text.secondary,
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: pagination?.loadingMore ? 'not-allowed' : 'pointer',
                    opacity: pagination?.loadingMore ? 0.6 : 1,
                    width: '100%',
                    marginTop: 4,
                  }}
                >
                  {pagination?.loadingMore ? '加载中...' : '加载更多评论'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
