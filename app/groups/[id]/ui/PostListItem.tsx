'use client'

import Link from 'next/link'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { ThumbsUpIcon, CommentIcon } from '@/app/components/ui/icons'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { getAvatarGradient } from '@/lib/utils/avatar'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import CommentsSection from './CommentsSection'
import type { Post, CommentWithAuthor } from '../hooks/useGroupPosts'

export interface PostListItemProps {
  post: Post
  groupId: string
  language: string
  userId: string | null
  accessToken: string | null
  userRole: 'owner' | 'admin' | 'member' | null
  editingPost: string | null
  setEditingPost: (id: string | null) => void
  editTitle: string
  setEditTitle: (v: string) => void
  editContent: string
  setEditContent: (v: string) => void
  savingEdit: boolean
  deletingPost: string | null
  likeLoading: Record<string, boolean>
  bookmarkLoading: Record<string, boolean>
  repostLoading: Record<string, boolean>
  expandedComments: Record<string, boolean>
  comments: Record<string, CommentWithAuthor[]>
  newComment: Record<string, string>
  setNewComment: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  commentLoading: Record<string, boolean>
  replyingTo: Record<string, string | null>
  setReplyingTo: (fn: (prev: Record<string, string | null>) => Record<string, string | null>) => void
  replyContent: Record<string, string>
  setReplyContent: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  expandedPosts: Record<string, boolean>
  setExpandedPosts: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  translatedPosts: Record<string, { title?: string; content?: string }>
  handleLike: (id: string) => void
  handleBookmark: (id: string) => void
  handleDeletePost: (id: string) => void
  handleSaveEdit: (id: string) => void
  handlePinPost: (id: string) => void
  toggleComments: (id: string) => void
  submitComment: (id: string) => void
  submitReply: (postId: string, commentId: string) => void
  getHeatColor: (count: number) => string
  setShowRepostModal: (id: string | null) => void
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  onReport?: (postId: string, postTitle: string) => void
  isMember?: boolean
}

export default function PostListItem(props: PostListItemProps) {
  const { t } = useLanguage()
  const {
    post, language, userId, accessToken, userRole,
    editingPost, setEditingPost, editTitle, setEditTitle, editContent, setEditContent,
    savingEdit, deletingPost,
    likeLoading, bookmarkLoading, repostLoading,
    expandedComments, comments, newComment, setNewComment, commentLoading,
    replyingTo, setReplyingTo, replyContent, setReplyContent,
    expandedReplies, setExpandedReplies,
    expandedPosts, setExpandedPosts, translatedPosts,
    handleLike, handleBookmark, handleDeletePost,
    handleSaveEdit, handlePinPost, toggleComments, submitComment, submitReply,
    getHeatColor, setShowRepostModal, onReport, isMember,
  } = props

  const displayContent = translatedPosts[post.id]?.content || post.content || ''
  const isLongContent = displayContent.length > 150
  const isExpanded = expandedPosts[post.id]
  const contentToShow = isExpanded || !isLongContent
    ? displayContent
    : displayContent.slice(0, 150) + '...'

  return (
    <Box
      className="post-card"
      style={{
        display: 'flex',
        borderRadius: tokens.radius.lg,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}
    >
      {/* Heat bar */}
      <Box
        style={{
          width: 3,
          minHeight: '100%',
          background: getHeatColor(post.comment_count || 0),
          flexShrink: 0,
          borderRadius: '3px 0 0 3px',
        }}
        title={t('postCommentsCount').replace('{count}', String(post.comment_count || 0))}
      />

      <Box style={{ flex: 1, padding: `${tokens.spacing[2]} ${tokens.spacing[3]}` }}>
        {/* Row 1: Author avatar + handle + time */}
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            {post.author_handle && !post.author_handle.startsWith('deleted_') ? (
              <Link
                href={`/u/${encodeURIComponent(post.author_handle)}`}
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: tokens.colors.accent?.primary || tokens.colors.accent.brand,
                  textDecoration: 'none',
                  fontWeight: tokens.typography.fontWeight.bold,
                  fontSize: tokens.typography.fontSize.xs,
                }}
              >
                <span style={{
                  width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                  background: post.author_avatar_url ? undefined : getAvatarGradient(post.author_id || post.author_handle),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  overflow: 'hidden', position: 'relative',
                }}>
                  {post.author_avatar_url ? (
                    <Image src={post.author_avatar_url} alt={post.author_handle || 'User avatar'} fill sizes="28px" style={{ objectFit: 'cover' }} />
                  ) : (
                    <span style={{ color: tokens.colors.white, fontSize: 12, fontWeight: 700 }}>
                      {(post.author_handle || 'U').charAt(0).toUpperCase()}
                    </span>
                  )}
                </span>
                @{post.author_handle}
              </Link>
            ) : (
              <Text size="xs" color="tertiary" style={{ fontStyle: 'italic' }}>
                {t('deletedUser')}
              </Text>
            )}
            <Text size="xs" color="tertiary" style={{ marginLeft: tokens.spacing[1] }}>
              · {new Date(post.created_at).toLocaleString(({ zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' } as Record<string, string>)[language] || 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </Text>
          </Box>

          {/* Admin actions */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
            {post.is_pinned && (
              <span style={{ fontSize: 11, fontWeight: 700, color: tokens.colors.accent?.primary || ARENA_PURPLE, background: 'var(--color-accent-primary-10)', padding: '1px 6px', borderRadius: tokens.radius.sm }}>PIN</span>
            )}
            {(post.author_id === userId || userRole === 'owner' || userRole === 'admin') && (
              <>
                {post.author_id === userId && editingPost !== post.id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingPost(post.id); setEditTitle(post.title); setEditContent(post.content || '') }}
                    title={t('postEdit')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: 12, color: tokens.colors.text.tertiary, borderRadius: tokens.radius.sm, transition: 'color 0.15s' }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                  </button>
                )}
                {(userRole === 'owner' || userRole === 'admin') && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePinPost(post.id) }}
                    title={post.is_pinned ? t('postUnpin') : t('postPin')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: 12, color: post.is_pinned ? (tokens.colors.accent?.primary || ARENA_PURPLE) : tokens.colors.text.tertiary, borderRadius: tokens.radius.sm }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.76z" /></svg>
                  </button>
                )}
                {post.author_id === userId && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeletePost(post.id) }}
                    title={t('postDelete')}
                    disabled={deletingPost === post.id}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', fontSize: 12, color: tokens.colors.accent.error, opacity: deletingPost === post.id ? 0.5 : 1, borderRadius: tokens.radius.sm }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                  </button>
                )}
              </>
            )}
          </Box>
        </Box>

        {/* Row 2: Title */}
        <Box style={{ marginBottom: tokens.spacing[1] }}>
          {editingPost === post.id ? (
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="post-editor-input"
              style={{
                width: '100%',
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.lg,
                fontWeight: tokens.typography.fontWeight.bold,
                outline: 'none',
              }}
            />
          ) : (
            <Text size="lg" weight="bold" style={{ lineHeight: 1.4 }}>
              {translatedPosts[post.id]?.title || post.title}
            </Text>
          )}
        </Box>

        {editingPost === post.id ? (
          <Box style={{ marginTop: tokens.spacing[1] }}>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              style={{
                width: '100%',
                minHeight: 80,
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                resize: 'vertical',
              }}
            />
            <Box style={{ display: 'flex', gap: tokens.spacing[2], marginTop: tokens.spacing[2] }}>
              <Button variant="primary" size="sm" onClick={() => handleSaveEdit(post.id)} disabled={savingEdit}>
                {savingEdit ? t('saving') : t('save')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditingPost(null)}>
                {t('cancel')}
              </Button>
            </Box>
          </Box>
        ) : post.content ? (
          <Box style={{ marginTop: tokens.spacing[1] }}>
            <Text size="sm" color="secondary" style={{ lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
              {renderContentWithLinks(contentToShow)}
            </Text>
            {isLongContent && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setExpandedPosts(prev => ({ ...prev, [post.id]: !prev[post.id] }))
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: ARENA_PURPLE,
                  cursor: 'pointer',
                  fontSize: 12,
                  marginTop: tokens.spacing[2],
                  padding: 0,
                }}
              >
                {isExpanded ? t('collapse') : t('showMore')}
              </button>
            )}
          </Box>
        ) : null}

        {/* Actions bar */}
        <Box style={{
          marginTop: tokens.spacing[2],
          display: 'flex',
          gap: tokens.spacing[3],
          paddingTop: tokens.spacing[2],
          borderTop: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Button
            variant="text" size="sm"
            onClick={() => handleLike(post.id)}
            disabled={likeLoading[post.id]}
            style={{ padding: 0, minWidth: 'auto', color: post.user_liked ? tokens.colors.accent?.success : undefined }}
          >
            <ThumbsUpIcon size={14} />
            <Text size="xs" style={{ marginLeft: tokens.spacing[1], color: post.user_liked ? tokens.colors.accent?.success : tokens.colors.text.secondary }}>
              {post.like_count || 0}
            </Text>
          </Button>

          <Button variant="text" size="sm" onClick={() => toggleComments(post.id)} style={{ padding: 0, minWidth: 'auto' }}>
            <CommentIcon size={14} />
            <Text size="xs" color="secondary" style={{ marginLeft: tokens.spacing[1] }}>{post.comment_count || 0}</Text>
          </Button>

          <Button
            variant="text" size="sm"
            onClick={() => handleBookmark(post.id)}
            disabled={bookmarkLoading[post.id]}
            style={{ padding: 0, minWidth: 'auto', color: post.user_bookmarked ? 'var(--color-accent-warning)' : undefined }}
            title={post.user_bookmarked ? t('postRemoveBookmark') : t('postBookmark')}
          >
            <span style={{ fontSize: 14 }}>{post.user_bookmarked ? '[S]' : '[+]'}</span>
            <Text size="xs" style={{ marginLeft: tokens.spacing[1], color: post.user_bookmarked ? 'var(--color-accent-warning)' : tokens.colors.text.secondary }}>
              {post.bookmark_count || 0}
            </Text>
          </Button>

          <Button
            variant="text" size="sm"
            onClick={() => {
              if (post.author_id === userId || post.user_reposted) return
              setShowRepostModal(post.id)
            }}
            disabled={repostLoading[post.id] || !!post.user_reposted}
            style={{ padding: 0, minWidth: 'auto', color: post.user_reposted ? tokens.colors.accent?.primary : undefined }}
            title={post.user_reposted ? t('reposted') : t('repost')}
          >
            <span style={{ fontSize: 14 }}>&#x2197;</span>
            <Text size="xs" style={{ marginLeft: tokens.spacing[1], color: post.user_reposted ? tokens.colors.accent?.primary : tokens.colors.text.secondary }}>
              {post.repost_count || 0}
            </Text>
          </Button>

          {/* Report button - only show if user is logged in and not the author */}
          {onReport && post.author_id !== userId && (
            <Button
              variant="text" size="sm"
              onClick={() => onReport(post.id, post.title)}
              style={{ padding: 0, minWidth: 'auto', marginLeft: 'auto' }}
              title={t('report')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
            </Button>
          )}
        </Box>

        {/* Comments section */}
        {expandedComments[post.id] && (
          <CommentsSection
            postId={post.id}
            language={language}
            accessToken={accessToken}
            comments={comments[post.id] || []}
            newComment={newComment[post.id] || ''}
            setNewComment={setNewComment}
            commentLoading={commentLoading[post.id]}
            replyingTo={replyingTo[post.id] || null}
            setReplyingTo={setReplyingTo}
            replyContent={replyContent}
            setReplyContent={setReplyContent}
            expandedReplies={expandedReplies}
            setExpandedReplies={setExpandedReplies}
            submitComment={submitComment}
            submitReply={submitReply}
            readOnly={!isMember}
          />
        )}
      </Box>
    </Box>
  )
}
