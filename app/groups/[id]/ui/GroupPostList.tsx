'use client'

import Link from 'next/link'
import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import MasonryGrid from '@/app/components/ui/MasonryGrid'
import MasonryPostCard from '@/app/components/post/MasonryPostCard'
import dynamic from 'next/dynamic'
const ReportModal = dynamic(() => import('@/app/components/ui/ReportModal'), { ssr: false })
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import PostListItem from './PostListItem'
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
  const { t } = useLanguage()
  const {
    groupId, language, userId, accessToken, userRole,
    isMember, joining: _joining, onJoin: _onJoin,
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

  // Report modal state
  const [reportingPost, setReportingPost] = useState<{ id: string; title: string } | null>(null)

  // Non-member banner removed per Adeline's request
  const nonMemberBanner = null;

  return (
    <Box style={{ position: 'relative' }}>
      {nonMemberBanner}
      {/* Sort Tabs + View Toggle */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
          <Button variant={sortMode === 'latest' ? 'primary' : 'secondary'} size="sm" onClick={() => setSortMode('latest')}>
            {t('latest')}
          </Button>
          <Button variant={sortMode === 'hot' ? 'primary' : 'secondary'} size="sm" onClick={() => setSortMode('hot')}>
            {t('hot')}
          </Button>
        </Box>
        <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
          <button
            onClick={() => setViewMode('list')}
            title={t('listView')}
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
            title={t('masonryView')}
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
            {t('posts')} ({sortedPosts.length})
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
        <Card title={`${t('posts')} (${sortedPosts.length})`}>
          {sortedPosts.length === 0 ? (
            <EmptyPostsState groupId={groupId} language={language} isMember={isMember} />
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
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
                  onReport={accessToken ? (id, title) => setReportingPost({ id, title }) : undefined}
                  isMember={isMember}
                />
              ))}
            </Box>
          )}
        </Card>
      )}

      {/* Empty masonry state */}
      {viewMode === 'masonry' && sortedPosts.length === 0 && (
        <Box style={{
          padding: `${tokens.spacing[12]} ${tokens.spacing[6]}`,
          textAlign: 'center',
          background: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <EmptyPostsState groupId={groupId} language={language} isMember={isMember} />
        </Box>
      )}

      {/* Infinite scroll sentinel */}
      {hasMorePosts && sortedPosts.length > 0 && (
        <div ref={sentinelRef} style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          {loadingMore && (
            <Text size="sm" color="tertiary">
              {t('loadingMore')}
            </Text>
          )}
        </div>
      )}

      {/* Repost Modal */}
      {showRepostModal && (
        <RepostModal
          showRepostModal={showRepostModal}
          repostComment={repostComment}
          setRepostComment={setRepostComment}
          setShowRepostModal={setShowRepostModal}
          repostLoading={repostLoading}
          handleRepost={handleRepost}
        />
      )}

      {/* Report Modal */}
      {reportingPost && accessToken && (
        <ReportModal
          isOpen={true}
          onClose={() => setReportingPost(null)}
          contentType="post"
          contentId={reportingPost.id}
          accessToken={accessToken}
          targetName={reportingPost.title}
        />
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────
// Empty State (shared between list and masonry)
// ─────────────────────────────────────────────

function EmptyPostsState({ groupId, language: _language, isMember }: { groupId: string; language: string; isMember: boolean }) {
  const { t } = useLanguage()

  return (
    <Box style={{ padding: `${tokens.spacing[12]} ${tokens.spacing[6]}`, textAlign: 'center' }}>
      <Box className="empty-state-icon" style={{ marginBottom: tokens.spacing[4], display: 'inline-block' }}>
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: tokens.colors.accent?.primary || tokens.colors.accent.brand, opacity: 0.5 }}>
          <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </Box>
      <Text size="md" weight="bold" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
        {t('noPostsYet')}
      </Text>
      <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[5], lineHeight: 1.6, maxWidth: 280, margin: '0 auto', marginTop: 4 }}>
        {t('beFirstToPost')}
      </Text>
      {isMember && (
        <Link href={`/groups/${groupId}/new`} style={{ textDecoration: 'none' }}>
          <Button variant="primary" size="sm" style={{ marginTop: tokens.spacing[4] }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              {t('writeFirstPostButton')}
            </span>
          </Button>
        </Link>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────
// Repost Modal
// ─────────────────────────────────────────────

function RepostModal({
  showRepostModal,
  repostComment,
  setRepostComment,
  setShowRepostModal,
  repostLoading,
  handleRepost,
}: {
  showRepostModal: string
  repostComment: string
  setRepostComment: (v: string) => void
  setShowRepostModal: (id: string | null) => void
  repostLoading: Record<string, boolean>
  handleRepost: (id: string, comment?: string) => void
}) {
  const { t } = useLanguage()

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'var(--color-backdrop)',
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
          {t('repostToFeed')}
        </Text>
        <textarea
          value={repostComment}
          onChange={(e) => setRepostComment(e.target.value)}
          placeholder={t('addCommentOptional')}
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
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleRepost(showRepostModal, repostComment)}
            disabled={repostLoading[showRepostModal]}
          >
            {repostLoading[showRepostModal]
              ? t('reposting')
              : t('repost')}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
