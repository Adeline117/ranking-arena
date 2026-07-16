'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useLanguage } from '../Providers/LanguageProvider'
import { CompactErrorBoundary } from '../utils/ErrorBoundary'
import type { Comment } from './hooks/usePostComments'
import type { CommentSortMode } from './comments/comment-types'
import type { ReplyTarget, ReplyTargetSetter } from './comments/reply-types'
import { CommentThread } from './comments/CommentThread'
import { CommentInput } from './comments/CommentInput'
import { CommentSkeleton, EmptyComments, CommentSortToggle } from './comments/CommentActions'

export type { CommentSortMode }

interface CommentsModalProps {
  postId: string
  viewerKey: string
  comments: Comment[]
  loadingComments: boolean
  currentUserId: string | null
  // Comment input
  submittingComment: boolean
  onSubmitComment: (postId: string, content: string) => Promise<boolean>
  // Reply
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
  // Sort
  commentSort?: CommentSortMode
  onSortChange?: (sort: CommentSortMode) => void
}

export default function CommentsModal({
  postId,
  viewerKey,
  comments,
  loadingComments,
  currentUserId,
  submittingComment,
  onSubmitComment,
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
  commentSort: externalSort,
  onSortChange: externalOnSortChange,
}: CommentsModalProps) {
  const { language, t } = useLanguage()
  const [internalSort, setInternalSort] = useState<CommentSortMode>('best')

  const commentSort = externalSort ?? internalSort
  const handleSortChange = (sort: CommentSortMode) => {
    if (externalOnSortChange) externalOnSortChange(sort)
    else setInternalSort(sort)
  }

  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const rootStructureKey = comments.map((comment) => comment.id).join(',')
  const sortRevision = useMemo(
    () => ({ postId, rootStructureKey, commentSort }),
    [postId, rootStructureKey, commentSort]
  )

  // Freeze root order while only reaction counts/content change. This keeps the
  // comment the viewer just reacted to from jumping under their pointer. A root
  // add/remove/replacement, post switch, or explicit sort-mode change re-sorts.
  const sortedCommentIds = useMemo(() => {
    const sorted = [...commentsRef.current]
    if (sortRevision.commentSort === 'time') {
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    } else {
      // Wilson score lower bound (95% confidence)
      const wilson = (ups: number, downs: number) => {
        const n = ups + downs
        if (n === 0) return 0
        const z = 1.96
        const p = ups / n
        return (
          (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) /
          (1 + (z * z) / n)
        )
      }
      sorted.sort((a, b) => {
        const sa = wilson(a.like_count || 0, a.dislike_count || 0)
        const sb = wilson(b.like_count || 0, b.dislike_count || 0)
        if (sb !== sa) return sb - sa
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      })
    }
    return sorted.map((comment) => comment.id)
  }, [sortRevision])

  const commentsById = new Map(comments.map((comment) => [comment.id, comment]))
  const sortedComments = sortedCommentIds
    .map((commentId) => commentsById.get(commentId))
    .filter((comment): comment is Comment => !!comment)

  const commentsEndRef = useRef<HTMLDivElement>(null)
  const prevCommentCount = useRef(comments.length)

  // UF13: Auto-scroll to new comment after submission.
  // Only scroll when the growth is the viewer's OWN freshly-submitted comment
  // (optimistic id starts with "temp_"). The initial async comment load also grows
  // the array 0 -> N, and scrolling on that was landing first-time visitors past the
  // post title/body straight into the comment list (U8-4).
  useEffect(() => {
    const latestComments = commentsRef.current
    const last = latestComments[latestComments.length - 1]
    if (
      latestComments.length > prevCommentCount.current &&
      last?.id?.startsWith('temp_') &&
      commentsEndRef.current
    ) {
      commentsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevCommentCount.current = latestComments.length
  }, [comments.length])

  return (
    <div style={{ marginTop: 16 }}>
      {/* Comment input */}
      <CommentInput
        postId={postId}
        viewerKey={viewerKey}
        submittingComment={submittingComment}
        onSubmitComment={onSubmitComment}
        language={language}
        t={t}
      />

      {/* Sort toggle */}
      {comments.length > 1 && (
        <CommentSortToggle commentSort={commentSort} onSortChange={handleSortChange} t={t} />
      )}

      {/* Comments list */}
      <CompactErrorBoundary>
        {loadingComments ? (
          <CommentSkeleton />
        ) : sortedComments.length === 0 ? (
          <EmptyComments t={t} />
        ) : (
          <div>
            {sortedComments.map((comment) => (
              <CommentThread
                key={comment.id}
                comment={comment}
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
            <div ref={commentsEndRef} />
          </div>
        )}
      </CompactErrorBoundary>
    </div>
  )
}
