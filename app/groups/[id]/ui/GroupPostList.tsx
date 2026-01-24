'use client'

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { ThumbsUpIcon, CommentIcon } from '@/app/components/icons'
import MasonryGrid from '@/app/components/ui/MasonryGrid'
import MasonryPostCard from '@/app/components/post/MasonryPostCard'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { getAvatarGradient } from '@/lib/utils/avatar'
import type { Post, CommentWithAuthor } from '../hooks/useGroupPosts'

interface GroupPostListProps {
  groupId: string
  language: string
  userId: string | null
  accessToken: string | null
  userRole: 'owner' | 'admin' | 'member' | null
  isMember: boolean
  joining: boolean
  onJoin: () => void

  // Posts data
  sortedPosts: Post[]
  sortMode: 'latest' | 'hot'
  setSortMode: (mode: 'latest' | 'hot') => void
  viewMode: 'list' | 'masonry'
  setViewMode: (mode: 'list' | 'masonry') => void
  hasMorePosts: boolean
  loadingMore: boolean
  sentinelRef: React.RefObject<HTMLDivElement | null>

  // Post editing
  editingPost: string | null
  setEditingPost: (id: string | null) => void
  editTitle: string
  setEditTitle: (v: string) => void
  editContent: string
  setEditContent: (v: string) => void
  savingEdit: boolean
  deletingPost: string | null

  // Interactions
  likeLoading: Record<string, boolean>
  bookmarkLoading: Record<string, boolean>
  repostLoading: Record<string, boolean>
  showRepostModal: string | null
  setShowRepostModal: (id: string | null) => void
  repostComment: string
  setRepostComment: (v: string) => void

  // Comments
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

  // Content
  expandedPosts: Record<string, boolean>
  setExpandedPosts: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  translatedPosts: Record<string, { title?: string; content?: string }>

  // Actions
  handleLike: (id: string) => void
  handleBookmark: (id: string) => void
  handleRepost: (id: string, comment?: string) => void
  handleDeletePost: (id: string) => void
  handleSaveEdit: (id: string) => void
  handlePinPost: (id: string) => void
  toggleComments: (id: string) => void
  submitComment: (id: string) => void
  submitReply: (postId: string, commentId: string) => void
  getHeatColor: (count: number) => string
}

export default function GroupPostList(props: GroupPostListProps) {
  const {
    groupId, language, userId, accessToken, userRole,
    isMember, joining, onJoin,
    sortedPosts, sortMode, setSortMode, viewMode, setViewMode,
    hasMorePosts, loadingMore, sentinelRef,
    editingPost, setEditingPost, editTitle, setEditTitle, editContent, setEditContent,
    savingEdit, deletingPost,
    likeLoading, bookmarkLoading, repostLoading,
    showRepostModal, setShowRepostModal, repostComment, setRepostComment,
    expandedComments, comments, newComment, setNewComment, commentLoading,
    replyingTo, setReplyingTo, replyContent, setReplyContent,
    expandedReplies, setExpandedReplies,
    expandedPosts, setExpandedPosts, translatedPosts,
    handleLike, handleBookmark, handleRepost, handleDeletePost,
    handleSaveEdit, handlePinPost, toggleComments, submitComment, submitReply,
    getHeatColor,
  } = props

  // Non-member gate
  if (!isMember) {
    return (
      <Box style={{
        padding: `${tokens.spacing[10]} ${tokens.spacing[5]}`,
        textAlign: 'center',
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
          {language === 'zh' ? '加入小组查看帖子' : 'Join to view posts'}
        </Text>
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
          {language === 'zh' ? '加入小组后可以查看帖子、评论和参与讨论' : 'Join the group to view posts, comments, and participate in discussions'}
        </Text>
        {userId ? (
          <Button variant="primary" onClick={onJoin} disabled={joining}>
            {joining ? (language === 'zh' ? '加入中...' : 'Joining...') : (language === 'zh' ? '加入小组' : 'Join Group')}
          </Button>
        ) : (
          <Link href="/login">
            <Button variant="primary">{language === 'zh' ? '登录后加入' : 'Login to join'}</Button>
          </Link>
        )}
      </Box>
    )
  }

  return (
    <Box style={{ position: 'relative' }}>
      {/* Sort Tabs + View Toggle */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <Button variant={sortMode === 'latest' ? 'primary' : 'secondary'} size="sm" onClick={() => setSortMode('latest')}>
            最新
          </Button>
          <Button variant={sortMode === 'hot' ? 'primary' : 'secondary'} size="sm" onClick={() => setSortMode('hot')}>
            热门
          </Button>
        </Box>
        <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
          <button
            onClick={() => setViewMode('list')}
            title="列表视图"
            style={{
              padding: tokens.spacing[2],
              borderRadius: tokens.radius.md,
              border: 'none',
              background: viewMode === 'list' ? `${tokens.colors.accent.primary}20` : 'transparent',
              color: viewMode === 'list' ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
          <button
            onClick={() => setViewMode('masonry')}
            title="瀑布流视图"
            style={{
              padding: tokens.spacing[2],
              borderRadius: tokens.radius.md,
              border: 'none',
              background: viewMode === 'masonry' ? `${tokens.colors.accent.primary}20` : 'transparent',
              color: viewMode === 'masonry' ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" />
              <rect x="3" y="15" width="7" height="6" rx="1" /><rect x="14" y="11" width="7" height="10" rx="1" />
            </svg>
          </button>
        </Box>
      </Box>

      {/* Masonry View */}
      {viewMode === 'masonry' && sortedPosts.length > 0 && (
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
            {language === 'zh' ? `帖子 (${sortedPosts.length})` : `Posts (${sortedPosts.length})`}
          </Text>
          <MasonryGrid columns={{ mobile: 2, desktop: 3 }} gap="12px">
            {sortedPosts.map((post) => (
              <MasonryPostCard
                key={post.id}
                post={{ ...post, group_id: groupId }}
                language={language}
                onLike={(id) => handleLike(id)}
                onComment={(id) => toggleComments(id)}
              />
            ))}
          </MasonryGrid>
        </Box>
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <Card title={language === 'zh' ? `帖子 (${sortedPosts.length})` : `Posts (${sortedPosts.length})`}>
          {sortedPosts.length === 0 ? (
            <Box style={{ color: tokens.colors.text.tertiary, padding: `${tokens.spacing[10]} ${tokens.spacing[5]}`, textAlign: 'center' }}>
              <Text size="sm" color="tertiary">还没有帖子，成为第一个发帖的人吧！</Text>
            </Box>
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
              {sortedPosts.map((post) => (
                <PostListItem
                  key={post.id}
                  post={post}
                  groupId={groupId}
                  language={language}
                  userId={userId}
                  accessToken={accessToken}
                  userRole={userRole}
                  editingPost={editingPost}
                  setEditingPost={setEditingPost}
                  editTitle={editTitle}
                  setEditTitle={setEditTitle}
                  editContent={editContent}
                  setEditContent={setEditContent}
                  savingEdit={savingEdit}
                  deletingPost={deletingPost}
                  likeLoading={likeLoading}
                  bookmarkLoading={bookmarkLoading}
                  repostLoading={repostLoading}
                  expandedComments={expandedComments}
                  comments={comments}
                  newComment={newComment}
                  setNewComment={setNewComment}
                  commentLoading={commentLoading}
                  replyingTo={replyingTo}
                  setReplyingTo={setReplyingTo}
                  replyContent={replyContent}
                  setReplyContent={setReplyContent}
                  expandedReplies={expandedReplies}
                  setExpandedReplies={setExpandedReplies}
                  expandedPosts={expandedPosts}
                  setExpandedPosts={setExpandedPosts}
                  translatedPosts={translatedPosts}
                  handleLike={handleLike}
                  handleBookmark={handleBookmark}
                  handleDeletePost={handleDeletePost}
                  handleSaveEdit={handleSaveEdit}
                  handlePinPost={handlePinPost}
                  toggleComments={toggleComments}
                  submitComment={submitComment}
                  submitReply={submitReply}
                  getHeatColor={getHeatColor}
                  setShowRepostModal={setShowRepostModal}
                  showToast={() => {}} // handled by repost modal
                />
              ))}
            </Box>
          )}
        </Card>
      )}

      {/* Empty masonry state */}
      {viewMode === 'masonry' && sortedPosts.length === 0 && (
        <Box style={{ color: tokens.colors.text.tertiary, padding: `${tokens.spacing[10]} ${tokens.spacing[5]}`, textAlign: 'center' }}>
          <Text size="sm" color="tertiary">还没有帖子，成为第一个发帖的人吧！</Text>
        </Box>
      )}

      {/* Infinite scroll sentinel */}
      {hasMorePosts && sortedPosts.length > 0 && (
        <div ref={sentinelRef} style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          {loadingMore && (
            <Text size="sm" color="tertiary">
              {language === 'zh' ? '加载更多...' : 'Loading more...'}
            </Text>
          )}
        </div>
      )}

      {/* Repost Modal */}
      {showRepostModal && (
        <Box
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: tokens.zIndex.modal,
          }}
          onClick={() => { setShowRepostModal(null); setRepostComment('') }}
        >
          <Box
            style={{
              background: tokens.colors.bg.primary,
              borderRadius: tokens.radius.xl,
              padding: tokens.spacing[6],
              width: '90%',
              maxWidth: 400,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
              {language === 'zh' ? '转发到主页' : 'Repost to Profile'}
            </Text>
            <textarea
              value={repostComment}
              onChange={(e) => setRepostComment(e.target.value)}
              placeholder={language === 'zh' ? '添加评论（可选）...' : 'Add a comment (optional)...'}
              style={{
                width: '100%',
                minHeight: 80,
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.lg,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                resize: 'vertical',
                marginBottom: tokens.spacing[4],
              }}
              maxLength={280}
            />
            <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => { setShowRepostModal(null); setRepostComment('') }}>
                {language === 'zh' ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleRepost(showRepostModal, repostComment)}
                disabled={repostLoading[showRepostModal]}
              >
                {repostLoading[showRepostModal]
                  ? (language === 'zh' ? '转发中...' : 'Reposting...')
                  : (language === 'zh' ? '转发' : 'Repost')}
              </Button>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────
// Post List Item (extracted for readability)
// ─────────────────────────────────────────────

interface PostListItemProps {
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
}

function PostListItem(props: PostListItemProps) {
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
    getHeatColor, setShowRepostModal,
  } = props

  const displayContent = translatedPosts[post.id]?.content || post.content || ''
  const isLongContent = displayContent.length > 150
  const isExpanded = expandedPosts[post.id]
  const contentToShow = isExpanded || !isLongContent
    ? displayContent
    : displayContent.slice(0, 150) + '...'

  return (
    <Box
      style={{
        display: 'flex',
        borderRadius: tokens.radius.xl,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        transition: `all ${tokens.transition.base}`,
        overflow: 'hidden',
      }}
    >
      {/* Heat bar */}
      <Box
        style={{
          width: 4,
          minHeight: '100%',
          background: getHeatColor(post.comment_count || 0),
          flexShrink: 0,
        }}
        title={`${post.comment_count || 0} ${language === 'zh' ? '条评论' : 'comments'}`}
      />

      <Box style={{ flex: 1, padding: tokens.spacing[4] }}>
        {/* Header: title + actions */}
        <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flex: 1 }}>
            {post.is_pinned && (
              <span title={language === 'zh' ? '置顶' : 'Pinned'} style={{ fontSize: 14, color: tokens.colors.accent?.primary || ARENA_PURPLE }}>📌</span>
            )}
            {editingPost === post.id ? (
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                style={{
                  flex: 1,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.lg,
                  fontWeight: tokens.typography.fontWeight.bold,
                }}
              />
            ) : (
              <Text size="lg" weight="bold">
                {translatedPosts[post.id]?.title || post.title}
              </Text>
            )}
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
            <Text size="xs" color="tertiary">
              {new Date(post.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
            </Text>
            {(post.author_id === userId || userRole === 'owner' || userRole === 'admin') && (
              <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
                {post.author_id === userId && editingPost !== post.id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditingPost(post.id); setEditTitle(post.title); setEditContent(post.content || '') }}
                    title={language === 'zh' ? '编辑' : 'Edit'}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, fontSize: 13, color: tokens.colors.text.tertiary }}
                  >✏️</button>
                )}
                {(userRole === 'owner' || userRole === 'admin') && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePinPost(post.id) }}
                    title={post.is_pinned ? (language === 'zh' ? '取消置顶' : 'Unpin') : (language === 'zh' ? '置顶' : 'Pin')}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, fontSize: 13, color: post.is_pinned ? (tokens.colors.accent?.primary || ARENA_PURPLE) : tokens.colors.text.tertiary }}
                  >📌</button>
                )}
                {post.author_id === userId && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeletePost(post.id) }}
                    title={language === 'zh' ? '删除' : 'Delete'}
                    disabled={deletingPost === post.id}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, fontSize: 13, color: '#ff6b6b', opacity: deletingPost === post.id ? 0.5 : 1 }}
                  >🗑️</button>
                )}
              </Box>
            )}
          </Box>
        </Box>

        {/* Author */}
        <Box style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2], display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {post.author_handle && !post.author_handle.startsWith('deleted_') ? (
            <Link
              href={`/u/${encodeURIComponent(post.author_handle)}`}
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: tokens.colors.accent?.primary || '#8b6fa8',
                textDecoration: 'none',
                fontWeight: tokens.typography.fontWeight.bold,
                fontSize: tokens.typography.fontSize.xs,
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                borderRadius: tokens.radius.md,
                background: 'rgba(139, 111, 168, 0.1)',
                transition: `all ${tokens.transition.base}`,
              }}
            >
              <span style={{
                width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                background: post.author_avatar_url ? undefined : getAvatarGradient(post.author_id || post.author_handle),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden', position: 'relative',
              }}>
                {post.author_avatar_url ? (
                  <img src={post.author_avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" />
                ) : (
                  <span style={{ color: '#fff', fontSize: 10, fontWeight: 700 }}>
                    {(post.author_handle || 'U').charAt(0).toUpperCase()}
                  </span>
                )}
              </span>
              @{post.author_handle}
            </Link>
          ) : (
            <Text size="xs" color="tertiary" style={{ fontStyle: 'italic' }}>
              {language === 'zh' ? '已注销用户' : 'Deleted user'}
            </Text>
          )}
        </Box>

        {/* Edit mode or content */}
        {editingPost === post.id ? (
          <Box style={{ marginTop: tokens.spacing[2] }}>
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
                {savingEdit ? (language === 'zh' ? '保存中...' : 'Saving...') : (language === 'zh' ? '保存' : 'Save')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditingPost(null)}>
                {language === 'zh' ? '取消' : 'Cancel'}
              </Button>
            </Box>
          </Box>
        ) : post.content ? (
          <Box style={{ marginTop: tokens.spacing[3] }}>
            <Text size="sm" color="secondary" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
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
                {isExpanded
                  ? (language === 'zh' ? '收起' : 'Show less')
                  : (language === 'zh' ? '展开查看' : 'Show more')}
              </button>
            )}
          </Box>
        ) : null}

        {/* Actions bar */}
        <Box style={{
          marginTop: tokens.spacing[3],
          display: 'flex',
          gap: tokens.spacing[4],
          paddingTop: tokens.spacing[3],
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
            style={{ padding: 0, minWidth: 'auto', color: post.user_bookmarked ? '#FFB020' : undefined }}
            title={language === 'zh' ? (post.user_bookmarked ? '取消收藏' : '收藏') : (post.user_bookmarked ? 'Remove bookmark' : 'Bookmark')}
          >
            <span style={{ fontSize: 14 }}>{post.user_bookmarked ? '★' : '☆'}</span>
            <Text size="xs" style={{ marginLeft: tokens.spacing[1], color: post.user_bookmarked ? '#FFB020' : tokens.colors.text.secondary }}>
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
            title={language === 'zh' ? (post.user_reposted ? '已转发' : '转发') : (post.user_reposted ? 'Reposted' : 'Repost')}
          >
            <span style={{ fontSize: 14 }}>↗</span>
            <Text size="xs" style={{ marginLeft: tokens.spacing[1], color: post.user_reposted ? tokens.colors.accent?.primary : tokens.colors.text.secondary }}>
              {post.repost_count || 0}
            </Text>
          </Button>
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
          />
        )}
      </Box>
    </Box>
  )
}

// ─────────────────────────────────────────────
// Comments Section
// ─────────────────────────────────────────────

interface CommentsSectionProps {
  postId: string
  language: string
  accessToken: string | null
  comments: CommentWithAuthor[]
  newComment: string
  setNewComment: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  commentLoading: boolean
  replyingTo: string | null
  setReplyingTo: (fn: (prev: Record<string, string | null>) => Record<string, string | null>) => void
  replyContent: Record<string, string>
  setReplyContent: (fn: (prev: Record<string, string>) => Record<string, string>) => void
  expandedReplies: Record<string, boolean>
  setExpandedReplies: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void
  submitComment: (postId: string) => void
  submitReply: (postId: string, commentId: string) => void
}

function CommentsSection(props: CommentsSectionProps) {
  const {
    postId, language, accessToken,
    comments, newComment, setNewComment, commentLoading,
    replyingTo, setReplyingTo, replyContent, setReplyContent,
    expandedReplies, setExpandedReplies,
    submitComment, submitReply,
  } = props

  return (
    <Box style={{
      marginTop: tokens.spacing[3],
      paddingTop: tokens.spacing[3],
      borderTop: `1px solid ${tokens.colors.border.primary}`,
    }}>
      {/* Comment input */}
      {accessToken && (
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
          <input
            type="text"
            placeholder="写评论..."
            value={newComment}
            onChange={(e) => setNewComment(prev => ({ ...prev, [postId]: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && submitComment(postId)}
            style={{
              flex: 1,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          />
          <Button variant="primary" size="sm" onClick={() => submitComment(postId)} disabled={commentLoading || !newComment.trim()}>
            发送
          </Button>
        </Box>
      )}

      {/* Comment list */}
      {commentLoading ? (
        <Text size="xs" color="tertiary">{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
      ) : comments.length > 0 ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
          {comments.map((comment) => (
            <Box key={comment.id}>
              <Box style={{ padding: tokens.spacing[2], background: tokens.colors.bg.primary, borderRadius: tokens.radius.md }}>
                <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[1] }}>
                  {comment.author_handle ? (
                    <Link
                      href={`/u/${encodeURIComponent(comment.author_handle)}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.accent?.primary || '#8b6fa8', textDecoration: 'none' }}
                    >
                      <span style={{
                        width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                        background: comment.author_avatar_url ? undefined : getAvatarGradient(comment.user_id || comment.author_handle),
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        overflow: 'hidden',
                      }}>
                        {comment.author_avatar_url ? (
                          <img src={comment.author_avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" />
                        ) : (
                          <span style={{ color: '#fff', fontSize: 9, fontWeight: 700 }}>
                            {(comment.author_handle || 'U').charAt(0).toUpperCase()}
                          </span>
                        )}
                      </span>
                      @{comment.author_handle}
                    </Link>
                  ) : (
                    <Text size="xs" weight="bold" color="secondary">
                      @{language === 'zh' ? '匿名' : 'Anonymous'}
                    </Text>
                  )}
                  <Text size="xs" color="tertiary">
                    {new Date(comment.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                  </Text>
                </Box>
                <Text size="sm">{renderContentWithLinks(comment.content)}</Text>
                {accessToken && !comment.parent_id && (
                  <button
                    onClick={() => setReplyingTo(prev => ({
                      ...prev,
                      [postId]: prev[postId] === comment.id ? null : comment.id
                    }))}
                    style={{ background: 'transparent', border: 'none', color: tokens.colors.text.tertiary, cursor: 'pointer', fontSize: 11, marginTop: tokens.spacing[1], padding: 0 }}
                  >
                    {language === 'zh' ? '回复' : 'Reply'}
                  </button>
                )}
              </Box>

              {/* Reply input */}
              {replyingTo === comment.id && (
                <Box style={{ marginLeft: tokens.spacing[4], marginTop: tokens.spacing[1], display: 'flex', gap: tokens.spacing[2] }}>
                  <input
                    type="text"
                    placeholder={language === 'zh' ? `回复 @${comment.author_handle || '匿名'}...` : `Reply to @${comment.author_handle || 'Anonymous'}...`}
                    value={replyContent[comment.id] || ''}
                    onChange={(e) => setReplyContent(prev => ({ ...prev, [comment.id]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && replyContent[comment.id]?.trim()) submitReply(postId, comment.id) }}
                    style={{
                      flex: 1,
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: tokens.colors.bg.primary,
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.xs,
                    }}
                  />
                  <Button
                    variant="primary" size="sm"
                    onClick={() => submitReply(postId, comment.id)}
                    style={{ fontSize: 11, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}` }}
                  >
                    {language === 'zh' ? '发送' : 'Send'}
                  </Button>
                </Box>
              )}

              {/* Nested replies */}
              {comment.replies && comment.replies.length > 0 && (
                <Box style={{ marginLeft: tokens.spacing[4], borderLeft: `2px solid ${tokens.colors.border.primary}`, paddingLeft: tokens.spacing[2], marginTop: tokens.spacing[1] }}>
                  {(expandedReplies[comment.id] ? comment.replies : comment.replies.slice(0, 3)).map((reply) => (
                    <Box key={reply.id} style={{ padding: `${tokens.spacing[1]} 0` }}>
                      <Box style={{ display: 'flex', gap: tokens.spacing[1], alignItems: 'center' }}>
                        {reply.author_handle ? (
                          <Link
                            href={`/u/${encodeURIComponent(reply.author_handle)}`}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.accent?.primary || '#8b6fa8', textDecoration: 'none' }}
                          >
                            <span style={{
                              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                              background: reply.author_avatar_url ? undefined : getAvatarGradient(reply.user_id || reply.author_handle),
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              overflow: 'hidden',
                            }}>
                              {reply.author_avatar_url ? (
                                <img src={reply.author_avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" />
                              ) : (
                                <span style={{ color: '#fff', fontSize: 8, fontWeight: 700 }}>
                                  {reply.author_handle.charAt(0).toUpperCase()}
                                </span>
                              )}
                            </span>
                            @{reply.author_handle}
                          </Link>
                        ) : (
                          <Text size="xs" weight="bold" color="secondary">
                            @{language === 'zh' ? '匿名' : 'Anonymous'}
                          </Text>
                        )}
                        <Text size="xs" color="tertiary">
                          {new Date(reply.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                        </Text>
                      </Box>
                      <Text size="xs" style={{ marginLeft: tokens.spacing[1] }}>{reply.content}</Text>
                    </Box>
                  ))}
                  {comment.replies.length > 3 && !expandedReplies[comment.id] && (
                    <button
                      onClick={() => setExpandedReplies(prev => ({ ...prev, [comment.id]: true }))}
                      style={{ background: 'transparent', border: 'none', color: ARENA_PURPLE, cursor: 'pointer', fontSize: 11, padding: 0 }}
                    >
                      {language === 'zh' ? `查看更多 (${comment.replies.length - 3})` : `Show more (${comment.replies.length - 3})`}
                    </button>
                  )}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      ) : (
        <Text size="xs" color="tertiary">{language === 'zh' ? '暂无评论' : 'No comments'}</Text>
      )}
    </Box>
  )
}
