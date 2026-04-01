'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { useLanguage } from '../Providers/LanguageProvider'
import { CompactErrorBoundary } from '../utils/ErrorBoundary'
import type { Comment } from './hooks/usePostComments'
import type { CommentSortMode } from './comments/comment-types'
import { CommentThread } from './comments/CommentThread'
import { CommentInput } from './comments/CommentInput'
import { CommentSkeleton, EmptyComments, CommentSortToggle } from './comments/CommentActions'

export type { CommentSortMode }

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
  // Edit
  editingComment?: { id: string; content: string } | null
  editContent?: string
  setEditContent?: (val: string) => void
  submittingEdit?: boolean
  onStartEdit?: (comment: Comment) => void
  onCancelEdit?: () => void
  onSubmitEdit?: (postId: string) => void
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
  editingComment,
  editContent,
  setEditContent,
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

  // Client-side sort: Wilson score or newest
  const sortedComments = useMemo(() => {
    if (comments.length <= 1) return comments
    const sorted = [...comments]
    if (commentSort === 'time') {
      sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    } else {
      // Wilson score lower bound (95% confidence)
      const wilson = (ups: number, downs: number) => {
        const n = ups + downs
        if (n === 0) return 0
        const z = 1.96
        const p = ups / n
        return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n)
      }
      sorted.sort((a, b) => {
        const sa = wilson(a.like_count || 0, a.dislike_count || 0)
        const sb = wilson(b.like_count || 0, b.dislike_count || 0)
        if (sb !== sa) return sb - sa
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      })
    }
    return sorted
  }, [comments, commentSort])

  const commentsEndRef = useRef<HTMLDivElement>(null)
  const prevCommentCount = useRef(comments.length)

  // UF13: Auto-scroll to new comment after submission
  useEffect(() => {
    if (comments.length > prevCommentCount.current && commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    prevCommentCount.current = comments.length
  }, [comments.length])

  return (
    <div style={{ marginTop: 16 }}>
      {/* Comment input */}
      <CommentInput
        postId={postId}
        newComment={newComment}
        setNewComment={setNewComment}
        submittingComment={submittingComment}
        onSubmitComment={onSubmitComment}
        language={language}
        t={t}
      />

      {/* Sort toggle */}
      {comments.length > 1 && (
        <CommentSortToggle
          commentSort={commentSort}
          onSortChange={handleSortChange}
          t={t}
        />
      )}

      {/* Comments list */}
      <CompactErrorBoundary>
        {loadingComments ? (
          <CommentSkeleton />
        ) : sortedComments.length === 0 ? (
          <EmptyComments t={t} />
        ) : (
          <div>
            {sortedComments.map(comment => (
              <CommentThread
                key={comment.id}
                comment={comment}
                postId={postId}
                currentUserId={currentUserId}
                language={language}
                t={t}
                replyingTo={replyingTo}
                setReplyingTo={setReplyingTo}
                replyContent={replyContent}
                setReplyContent={setReplyContent}
                submittingReply={submittingReply}
                onSubmitReply={onSubmitReply}
                commentLikeLoading={commentLikeLoading}
                onToggleCommentLike={onToggleCommentLike}
                onToggleCommentDislike={onToggleCommentDislike}
                deletingCommentId={deletingCommentId}
                onDeleteComment={onDeleteComment}
                editingComment={editingComment}
                editContent={editContent}
                setEditContent={setEditContent}
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
