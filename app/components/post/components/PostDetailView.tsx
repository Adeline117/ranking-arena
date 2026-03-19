'use client'

import { localizedLabel } from '@/lib/utils/format'
import Image from 'next/image'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { CommentIcon } from '../../ui/icons'
import { formatTimeAgo } from '@/lib/utils/date'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { DynamicCommentsModal as CommentsModal } from '../../ui/Dynamic'
import { AvatarLink, PostModal, CustomPollCard, PostDetailActions } from '.'
import LevelBadge from '@/app/components/user/LevelBadge'
import type { PostWithUserState } from '@/lib/types'
import type { Comment } from '../hooks/usePostComments'

type Post = PostWithUserState

interface PostDetailViewProps {
  openPost: Post
  onClose: () => void
  language: string
  currentUserId: string | null
  accessToken: string | null
  // Translation
  showingOriginal: boolean
  setShowingOriginal: (v: boolean) => void
  translatedContent: string | null
  translating: boolean
  translatedListPosts: Record<string, { title?: string; body?: string }>
  removeImagesFromContent: (content: string) => string
  // Custom poll
  customPoll: {
    id: string; question: string
    options: { text: string; votes: number | null }[]
    type: 'single' | 'multiple'; endAt: string | null
    isExpired: boolean; showResults: boolean; totalVotes: number | null
  } | null
  loadingCustomPoll: boolean
  customPollUserVotes: number[]
  selectedPollOptions: number[]
  setSelectedPollOptions: React.Dispatch<React.SetStateAction<number[]>>
  votingCustomPoll: boolean
  submitCustomPollVote: (postId: string) => Promise<void>
  // Actions
  userReaction: string | null | undefined
  userBookmarks: Record<string, boolean>
  bookmarkCounts: Record<string, number>
  onToggleReaction: (postId: string, type: 'up' | 'down') => Promise<void>
  onBookmark: (postId: string) => Promise<void>
  onOpenBookmarkFolder: (postId: string) => void
  onRepost: (id: string) => void
  showToast: (msg: string, type: 'error' | 'success' | 'warning' | 'info') => void
  // Comments
  comments: Comment[]
  loadingComments: boolean
  newComment: string; setNewComment: (v: string) => void
  submittingComment: boolean
  onSubmitComment: (postId: string) => Promise<void>
  replyingTo: { commentId: string; handle: string } | null; setReplyingTo: (v: { commentId: string; handle: string } | null) => void
  replyContent: string; setReplyContent: (v: string) => void
  submittingReply: boolean
  onSubmitReply: (postId: string, parentId: string) => Promise<void>
  commentLikeLoading: Record<string, boolean>
  onToggleCommentLike: (postId: string, commentId: string) => Promise<void>
  onToggleCommentDislike: (postId: string, commentId: string) => Promise<void>
  deletingCommentId: string | null
  onDeleteComment: (postId: string, commentId: string) => Promise<void>
  // Edit comment
  editingComment?: { id: string; content: string } | null
  editContent?: string
  setEditContent?: (val: string) => void
  submittingEdit?: boolean
  onStartEdit?: (comment: Comment) => void
  onCancelEdit?: () => void
  onSubmitEdit?: (postId: string) => void
  expandedReplies: Record<string, boolean>
  setExpandedReplies: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  translatedComments: Record<string, string>
  t: (key: string) => string
}

export default function PostDetailView({
  openPost, onClose, language, currentUserId, accessToken,
  showingOriginal, setShowingOriginal, translatedContent, translating, translatedListPosts,
  removeImagesFromContent,
  customPoll, loadingCustomPoll, customPollUserVotes, selectedPollOptions, setSelectedPollOptions,
  votingCustomPoll, submitCustomPollVote,
  userBookmarks, bookmarkCounts, onToggleReaction, onBookmark, onOpenBookmarkFolder, onRepost, showToast,
  comments, loadingComments, newComment, setNewComment, submittingComment, onSubmitComment,
  replyingTo, setReplyingTo, replyContent, setReplyContent, submittingReply, onSubmitReply,
  commentLikeLoading, onToggleCommentLike, onToggleCommentDislike,
  deletingCommentId, onDeleteComment,
  editingComment, editContent, setEditContent, submittingEdit, onStartEdit, onCancelEdit, onSubmitEdit,
  expandedReplies, setExpandedReplies, translatedComments, t,
}: PostDetailViewProps) {
  return (
    <PostModal onClose={onClose}>
      {openPost.group_name && (
        openPost.group_id ? (
          <Link href={`/groups/${openPost.group_id}`} style={{ fontSize: 12, color: ARENA_PURPLE, textDecoration: 'none', fontWeight: 600, padding: '2px 8px', background: `${ARENA_PURPLE}20`, borderRadius: tokens.radius.sm, display: 'inline-block' }}>
            {localizedLabel(openPost.group_name, openPost.group_name_en, language)}
          </Link>
        ) : (
          <div style={{ fontSize: 12, color: ARENA_PURPLE }}>{localizedLabel(openPost.group_name, openPost.group_name_en, language)}</div>
        )
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
        <div style={{ fontSize: 20, fontWeight: 900, lineHeight: 1.25, color: !showingOriginal && translatedListPosts[openPost.id]?.title ? tokens.colors.accent.translated : tokens.colors.text.primary }}>
          {showingOriginal ? openPost.title : (translatedListPosts[openPost.id]?.title || openPost.title)}
        </div>
        <AvatarLink handle={openPost.author_handle} avatarUrl={openPost.author_avatar_url} isPro={openPost.author_is_pro} showProBadge={openPost.author_show_pro_badge} />
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 6 }}>
        {openPost.author_handle ? (
          <Link href={`/u/${encodeURIComponent(openPost.author_handle)}`} style={{ color: tokens.colors.text.secondary, textDecoration: 'none', fontWeight: 700 }}>@{openPost.author_handle}</Link>
        ) : (<span>user</span>)}
        <LevelBadge exp={openPost.author_exp || 0} size="sm" />
        <span>·</span>
        <span>{formatTimeAgo(openPost.created_at, language as 'zh' | 'en')}</span>
        <span>·</span>
        <CommentIcon size={12} />
        <span>{openPost.comment_count}</span>
      </div>

      <div translate="no" style={{ marginTop: 12, fontSize: 14, color: !showingOriginal && translatedContent ? tokens.colors.accent.translated : tokens.colors.text.primary, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
        {showingOriginal ? renderContentWithLinks(openPost.content || '') : renderContentWithLinks(translatedContent || openPost.content || '')}
      </div>

      {/* Original post quote card (repost) */}
      {openPost.original_post && (
        <div style={{ marginTop: 12, padding: 12, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.secondary}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>{t('repostedFrom')}</span>
            <AvatarLink handle={openPost.original_post.author_handle} avatarUrl={openPost.original_post.author_avatar_url} isPro={openPost.original_post.author_is_pro} showProBadge={openPost.original_post.author_show_pro_badge} />
          </div>
          {openPost.original_post.title && <div style={{ fontSize: 14, color: tokens.colors.text.primary, fontWeight: 600, marginBottom: 6 }}>{openPost.original_post.title}</div>}
          <div style={{ fontSize: 13, color: tokens.colors.text.secondary, lineHeight: 1.5 }}>
            {removeImagesFromContent(openPost.original_post.content).slice(0, 200)}{openPost.original_post.content.length > 200 && '...'}
          </div>
          {openPost.original_post.images && openPost.original_post.images.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {openPost.original_post.images.slice(0, 4).map((imgUrl, idx) => (
                <div key={idx} style={{ width: 80, height: 80, borderRadius: tokens.radius.md, overflow: 'hidden', flexShrink: 0 }}>
                  <Image src={imgUrl} alt="Post image" width={80} height={80} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                </div>
              ))}
              {openPost.original_post.images.length > 4 && <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, alignSelf: 'center' }}>+{openPost.original_post.images.length - 4}</span>}
            </div>
          )}
        </div>
      )}

      {/* Translation toggle */}
      {(translatedContent || translatedListPosts[openPost.id]?.title || translating) && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setShowingOriginal(!showingOriginal)} disabled={translating} style={{ padding: '4px 10px', fontSize: 12, fontWeight: 600, border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.sm, background: tokens.colors.bg.tertiary, color: tokens.colors.text.secondary, cursor: translating ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            {translating ? t('translating') : showingOriginal ? t('viewTranslation') : t('viewOriginal')}
          </button>
          {!showingOriginal && <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>{t('translatedByAI')}</span>}
        </div>
      )}

      {/* Custom poll */}
      {openPost.poll_id && (
        <CustomPollCard poll={customPoll} loading={loadingCustomPoll} userVotes={customPollUserVotes}
          selectedOptions={selectedPollOptions}
          onSelectOption={(index) => { if (customPoll?.type === 'single') setSelectedPollOptions([index]); else setSelectedPollOptions(prev => prev.includes(index) ? prev.filter(i => i !== index) : [...prev, index]) }}
          onSubmitVote={() => submitCustomPollVote(openPost.id)}
          votingInProgress={votingCustomPoll} language={language} t={t} />
      )}

      <PostDetailActions postId={openPost.id} postTitle={openPost.title} authorId={openPost.author_id}
        currentUserId={currentUserId} userReaction={openPost.user_reaction}
        likeCount={openPost.like_count} dislikeCount={openPost.dislike_count}
        isBookmarked={userBookmarks[openPost.id] || false} bookmarkCount={bookmarkCounts[openPost.id] || 0}
        accessToken={accessToken} onToggleReaction={onToggleReaction} onBookmark={onBookmark}
        onOpenBookmarkFolder={onOpenBookmarkFolder} onRepost={onRepost} showToast={showToast} t={t} />

      {/* Comments */}
      <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.colors.border.secondary}`, paddingTop: 16 }}>
        <CommentsModal postId={openPost.id} comments={comments} loadingComments={loadingComments}
          currentUserId={currentUserId} newComment={newComment} setNewComment={setNewComment}
          submittingComment={submittingComment} onSubmitComment={onSubmitComment}
          replyingTo={replyingTo} setReplyingTo={setReplyingTo} replyContent={replyContent} setReplyContent={setReplyContent}
          submittingReply={submittingReply} onSubmitReply={onSubmitReply}
          commentLikeLoading={commentLikeLoading} onToggleCommentLike={onToggleCommentLike} onToggleCommentDislike={onToggleCommentDislike}
          deletingCommentId={deletingCommentId} onDeleteComment={onDeleteComment}
          editingComment={editingComment} editContent={editContent} setEditContent={setEditContent}
          submittingEdit={submittingEdit} onStartEdit={onStartEdit} onCancelEdit={onCancelEdit} onSubmitEdit={onSubmitEdit}
          expandedReplies={expandedReplies} setExpandedReplies={setExpandedReplies}
          translatedComments={translatedComments} />
      </div>
    </PostModal>
  )
}
