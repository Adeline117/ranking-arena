'use client'

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { authedFetch, getHttpErrorMessage } from '@/lib/api/client'
import {
  fetchPostCommentsPage,
  isCreatedCommentAcknowledgement,
  isDefinitiveMutationRejection,
} from '@/lib/api/comments-client'
import { trackEvent } from '@/lib/analytics/track'
import { usePostStore, type CommentData } from '@/lib/stores/postStore'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useViewerOwnedState } from '@/lib/state/viewer-owned-state'

export type Comment = {
  id: string
  content: string
  user_id?: string
  author_handle?: string
  author_avatar_url?: string
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  created_at: string
  updated_at?: string
  post_id?: string
  parent_id?: string | null
  like_count?: number
  dislike_count?: number
  user_liked?: boolean
  user_disliked?: boolean
  replies?: Comment[]
}

type CommentReaction = 'like' | 'dislike'

type CommentReactionResponse = {
  like_count: number
  dislike_count: number
  liked: boolean
  disliked: boolean
}

type DeleteCommentResponse = {
  deleted_count: number
  comment_count: number
}

type EditedCommentResponse = {
  author_handle: string | null
  author_id: string | null
  id: string
  post_id: string
  user_id: string
  content: string
  created_at: string | null
  delete_reason: null
  deleted_at: null
  deleted_by: null
  updated_at: string
  parent_id: string | null
  like_count: number
  dislike_count: number
  ranking_score: number
}

const EDITED_COMMENT_RESPONSE_KEYS = [
  'author_handle',
  'author_id',
  'content',
  'created_at',
  'delete_reason',
  'deleted_at',
  'deleted_by',
  'dislike_count',
  'id',
  'like_count',
  'parent_id',
  'post_id',
  'ranking_score',
  'updated_at',
  'user_id',
] as const

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isEditedCommentResponse(
  value: unknown,
  expected: { commentId: string; postId: string; userId?: string | null; content: string }
): value is EditedCommentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const comment = value as Partial<EditedCommentResponse>
  const keys = Object.keys(value)
  return (
    keys.length === EDITED_COMMENT_RESPONSE_KEYS.length &&
    EDITED_COMMENT_RESPONSE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    comment.id === expected.commentId &&
    comment.post_id === expected.postId &&
    typeof comment.user_id === 'string' &&
    comment.user_id.length > 0 &&
    (!expected.userId || comment.user_id === expected.userId) &&
    typeof comment.content === 'string' &&
    (comment.author_handle === null || typeof comment.author_handle === 'string') &&
    (comment.author_id === null || typeof comment.author_id === 'string') &&
    (comment.parent_id === null || typeof comment.parent_id === 'string') &&
    isTimestamp(comment.updated_at) &&
    (comment.created_at === null || isTimestamp(comment.created_at)) &&
    comment.deleted_at === null &&
    comment.deleted_by === null &&
    comment.delete_reason === null &&
    Number.isSafeInteger(comment.like_count) &&
    (comment.like_count ?? -1) >= 0 &&
    Number.isSafeInteger(comment.dislike_count) &&
    (comment.dislike_count ?? -1) >= 0 &&
    typeof comment.ranking_score === 'number' &&
    Number.isFinite(comment.ranking_score) &&
    comment.ranking_score >= 0
  )
}

function findComment(comments: Comment[], commentId: string): Comment | undefined {
  for (const comment of comments) {
    if (comment.id === commentId) return comment
    const reply = comment.replies ? findComment(comment.replies, commentId) : undefined
    if (reply) return reply
  }
  return undefined
}

function updateComment(
  comments: Comment[],
  commentId: string,
  updater: (comment: Comment) => Comment
): Comment[] {
  return comments.map((comment) => {
    if (comment.id === commentId) return updater(comment)
    if (!comment.replies) return comment
    const replies = updateComment(comment.replies, commentId, updater)
    return replies === comment.replies ? comment : { ...comment, replies }
  })
}

function getCommentReaction(comment: Comment): CommentReaction | null {
  if (comment.user_liked) return 'like'
  if (comment.user_disliked) return 'dislike'
  return null
}

function isCommentReactionResponse(
  value: unknown,
  expectedReaction: CommentReaction | null
): value is CommentReactionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Partial<CommentReactionResponse>
  const acknowledgedReaction = data.liked ? 'like' : data.disliked ? 'dislike' : null
  return (
    Number.isSafeInteger(data.like_count) &&
    (data.like_count ?? -1) >= 0 &&
    Number.isSafeInteger(data.dislike_count) &&
    (data.dislike_count ?? -1) >= 0 &&
    typeof data.liked === 'boolean' &&
    typeof data.disliked === 'boolean' &&
    !(data.liked && data.disliked) &&
    acknowledgedReaction === expectedReaction
  )
}

function isDeleteCommentResponse(value: unknown): value is DeleteCommentResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<DeleteCommentResponse>
  return (
    Number.isSafeInteger(data.deleted_count) &&
    (data.deleted_count ?? 0) > 0 &&
    Number.isSafeInteger(data.comment_count) &&
    (data.comment_count ?? -1) >= 0
  )
}

interface UsePostCommentsOptions {
  accessToken: string | null
  currentUserId?: string | null
  authChecked?: boolean
  viewerKey?: string
  sessionGeneration?: number
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
  onCommentCountChange?: (postId: string, delta: number, absoluteCount?: number) => void
  onResourceAbsent?: (postId: string) => void
  t?: (key: string) => string
}

type CommentViewerScope = {
  viewerKey: string
  sessionGeneration: number
  userId: string | null
}

function commentViewerScopeKey(scope: Pick<CommentViewerScope, 'viewerKey' | 'sessionGeneration'>) {
  return `${scope.viewerKey}\u0000${scope.sessionGeneration}`
}

// Convert Comment to CommentData for store compatibility
function toCommentData(comment: Comment): CommentData {
  return {
    id: comment.id,
    post_id: comment.post_id,
    content: comment.content,
    user_id: comment.user_id,
    author_handle: comment.author_handle || 'user',
    author_avatar_url: comment.author_avatar_url,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    like_count: comment.like_count,
    dislike_count: comment.dislike_count,
    user_liked: comment.user_liked,
    user_disliked: comment.user_disliked,
    parent_id: comment.parent_id,
    replies: comment.replies?.map(toCommentData),
  }
}

export function usePostComments({
  accessToken,
  currentUserId: suppliedCurrentUserId,
  authChecked = true,
  viewerKey: suppliedViewerKey,
  sessionGeneration = 0,
  showToast,
  showDangerConfirm,
  onCommentCountChange,
  onResourceAbsent,
  t: externalT,
}: UsePostCommentsOptions) {
  const currentUserId = suppliedCurrentUserId ?? null
  const viewerKey =
    suppliedViewerKey ??
    (currentUserId ? `user:${currentUserId}` : accessToken ? 'user:legacy' : 'anon')
  const activeScopeRef = useRef({ viewerKey, sessionGeneration, userId: currentUserId })
  activeScopeRef.current = { viewerKey, sessionGeneration, userId: currentUserId }
  const scopeKey = `${viewerKey}\u0000${sessionGeneration}`
  const previousScopeKeyRef = useRef(scopeKey)
  const stateRevisionRef = useRef(new Map<string, number>())
  const { t: hookT } = useLanguage()
  const t = externalT || hookT
  const [comments, setCommentsOwned] = useViewerOwnedState<Comment[]>([], () => [], scopeKey)
  const commentsRef = useRef<Comment[]>(comments)
  commentsRef.current = comments
  const setComments = useCallback<Dispatch<SetStateAction<Comment[]>>>(
    (action) => {
      const invocationScopeKey = commentViewerScopeKey(activeScopeRef.current)
      stateRevisionRef.current.set(
        invocationScopeKey,
        (stateRevisionRef.current.get(invocationScopeKey) || 0) + 1
      )
      setCommentsOwned(action)
    },
    [setCommentsOwned]
  )
  const [loadingComments, setLoadingComments] = useViewerOwnedState(false, () => false, scopeKey)
  const [submittingComment, setSubmittingComment] = useViewerOwnedState(
    false,
    () => false,
    scopeKey
  )
  const [replyingTo, setReplyingTo] = useViewerOwnedState<{
    commentId: string
    handle: string
  } | null>(null, () => null, scopeKey)
  const [replyContent, setReplyContent] = useViewerOwnedState('', () => '', scopeKey)
  const replyContentRef = useRef(replyContent)
  replyContentRef.current = replyContent
  const [submittingReply, setSubmittingReply] = useViewerOwnedState(false, () => false, scopeKey)
  const [commentLikeLoading, setCommentLikeLoading] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [expandedReplies, setExpandedReplies] = useViewerOwnedState<Record<string, boolean>>(
    {},
    () => ({}),
    scopeKey
  )
  const [deletingCommentId, setDeletingCommentId] = useViewerOwnedState<string | null>(
    null,
    () => null,
    scopeKey
  )
  const [editingComment, setEditingComment] = useViewerOwnedState<{
    id: string
    content: string
  } | null>(null, () => null, scopeKey)
  const [editContent, setEditContent] = useViewerOwnedState('', () => '', scopeKey)
  const [submittingEdit, setSubmittingEdit] = useViewerOwnedState(false, () => false, scopeKey)
  const submittingEditRef = useRef<symbol | null>(null)

  // Ref-based guards to prevent double submissions
  const submittingCommentRef = useRef<symbol | null>(null)
  const submittingReplyRef = useRef<symbol | null>(null)
  const pendingReactionIdsRef = useRef(new Map<string, symbol>())
  const pendingDeleteIdsRef = useRef(new Map<string, symbol>())
  // Resource binding is deliberately separate from draft persistence. It guards
  // every async response from mutating a newly opened post.
  const currentPostIdRef = useRef<string | null>(null)
  const loadRequestGenerationRef = useRef(0)
  const canonicalReadGenerationRef = useRef(new Map<string, number>())

  const scopeIsCurrent = useCallback((scope: CommentViewerScope) => {
    const current = activeScopeRef.current
    return (
      current.viewerKey === scope.viewerKey &&
      current.sessionGeneration === scope.sessionGeneration &&
      current.userId === scope.userId
    )
  }, [])

  useEffect(() => {
    const store = usePostStore.getState()
    if ('setViewerScope' in store && typeof store.setViewerScope === 'function') {
      store.setViewerScope(viewerKey, sessionGeneration)
    }
  }, [sessionGeneration, viewerKey])

  useEffect(() => {
    if (previousScopeKeyRef.current === scopeKey) return
    previousScopeKeyRef.current = scopeKey
    loadRequestGenerationRef.current += 1
    canonicalReadGenerationRef.current.clear()
    submittingCommentRef.current = null
    submittingReplyRef.current = null
    submittingEditRef.current = null
    pendingReactionIdsRef.current.clear()
    pendingDeleteIdsRef.current.clear()
    setComments([])
    setLoadingComments(false)
    setSubmittingComment(false)
    setSubmittingReply(false)
    setCommentLikeLoading({})
    setDeletingCommentId(null)
    setReplyingTo(null)
    setReplyContent('')
    setExpandedReplies({})
    setEditingComment(null)
    setEditContent('')
    setSubmittingEdit(false)
  }, [
    scopeKey,
    setCommentLikeLoading,
    setComments,
    setDeletingCommentId,
    setEditContent,
    setEditingComment,
    setExpandedReplies,
    setLoadingComments,
    setReplyContent,
    setReplyingTo,
    setSubmittingComment,
    setSubmittingEdit,
    setSubmittingReply,
  ])

  // Auth guard helper — opens the login modal (consistent with usePostActions gates)
  const requireAuth = useCallback((): boolean => {
    // Session restoration is not a logged-out verdict. Writes wait silently so
    // hydration cannot flash a false login prompt for an authenticated user.
    if (!authChecked) return false
    if (!accessToken || (suppliedViewerKey !== undefined && !currentUserId)) {
      useLoginModal.getState().openLoginModal()
      return false
    }
    return true
  }, [accessToken, authChecked, currentUserId, suppliedViewerKey])

  const reconcileCanonicalComments = useCallback(
    async (
      postId: string,
      sort: 'best' | 'time' = 'best',
      capturedScope: CommentViewerScope = activeScopeRef.current,
      retryAfterNewerState = true
    ): Promise<Comment[] | null> => {
      if (!scopeIsCurrent(capturedScope)) return null
      const generationKey = `${capturedScope.viewerKey}\u0000${postId}`
      const generation = (canonicalReadGenerationRef.current.get(generationKey) || 0) + 1
      canonicalReadGenerationRef.current.set(generationKey, generation)
      const revisionKey = commentViewerScopeKey(capturedScope)
      const requestStartRevision = stateRevisionRef.current.get(revisionKey) || 0

      try {
        const page = await fetchPostCommentsPage<Comment>(postId, accessToken, {
          sort,
          viewerScope: {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          },
        })
        if (
          !page.ok ||
          !scopeIsCurrent(capturedScope) ||
          canonicalReadGenerationRef.current.get(generationKey) !== generation
        ) {
          return null
        }

        if (page.resourceAbsent) {
          const store = usePostStore.getState()
          if ('removePostResource' in store && typeof store.removePostResource === 'function') {
            store.removePostResource(postId)
          }
          onCommentCountChange?.(postId, 0, 0)
          if (currentPostIdRef.current === postId) {
            setComments([])
            onResourceAbsent?.(postId)
          }
          return []
        }

        if ((stateRevisionRef.current.get(revisionKey) || 0) !== requestStartRevision) {
          return retryAfterNewerState &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)
            ? reconcileCanonicalComments(postId, sort, capturedScope, false)
            : null
        }

        const store = usePostStore.getState()
        store.setComments(postId, page.comments.map(toCommentData))
        store.updatePostCommentCount(postId, page.commentCount)
        onCommentCountChange?.(postId, 0, page.commentCount)

        if (
          scopeIsCurrent(capturedScope) &&
          (currentPostIdRef.current === null || currentPostIdRef.current === postId)
        ) {
          setComments(page.comments)
        }
        return page.comments
      } catch {
        return null
      } finally {
        if (canonicalReadGenerationRef.current.get(generationKey) === generation) {
          canonicalReadGenerationRef.current.delete(generationKey)
        }
      }
    },
    [accessToken, onCommentCountChange, onResourceAbsent, scopeIsCurrent, setComments]
  )

  const loadComments = useCallback(
    async (postId: string, sort: 'best' | 'time' = 'best'): Promise<void> => {
      if (!authChecked) return
      const capturedScope = activeScopeRef.current
      const requestGeneration = ++loadRequestGenerationRef.current
      if (currentPostIdRef.current !== postId) {
        // Modal/page reuse must not carry interaction state from the previous
        // post while the next post is loading.
        setComments([])
        setReplyingTo(null)
        setReplyContent('')
        setExpandedReplies({})
        setEditingComment(null)
        setEditContent('')
        setCommentLikeLoading({})
        setDeletingCommentId(null)
      }
      currentPostIdRef.current = postId
      setLoadingComments(true)
      try {
        await reconcileCanonicalComments(postId, sort, capturedScope)
      } finally {
        if (
          scopeIsCurrent(capturedScope) &&
          requestGeneration === loadRequestGenerationRef.current
        ) {
          setLoadingComments(false)
        }
      }
    },
    [
      authChecked,
      reconcileCanonicalComments,
      scopeIsCurrent,
      setCommentLikeLoading,
      setComments,
      setDeletingCommentId,
      setEditContent,
      setEditingComment,
      setExpandedReplies,
      setLoadingComments,
      setReplyContent,
      setReplyingTo,
    ]
  )

  const submitComment = useCallback(
    async (postId: string, content: string): Promise<boolean> => {
      const savedContent = content.trim()
      if (!requireAuth() || !savedContent) return false
      if (currentPostIdRef.current !== postId) return false
      if (submittingCommentRef.current) return false // Prevent double submission

      const operation = Symbol('submit-comment')
      const capturedScope = activeScopeRef.current
      submittingCommentRef.current = operation
      setSubmittingComment(true)

      // Optimistic: show comment immediately with temp ID
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticComment: Comment = {
        id: tempId,
        content: savedContent,
        created_at: new Date().toISOString(),
      }
      setComments((prev) => [...prev, optimisticComment])
      const revisionKey = commentViewerScopeKey(capturedScope)
      const optimisticRevision = stateRevisionRef.current.get(revisionKey) || 0
      onCommentCountChange?.(postId, 1)

      const rollbackSubmission = async () => {
        if (!scopeIsCurrent(capturedScope)) return
        if (
          (stateRevisionRef.current.get(revisionKey) || 0) === optimisticRevision &&
          (currentPostIdRef.current === null || currentPostIdRef.current === postId)
        ) {
          setComments((prev) => prev.filter((c) => c.id !== tempId))
          onCommentCountChange?.(postId, -1)
        } else {
          await reconcileCanonicalComments(postId, 'best', capturedScope)
        }
      }

      try {
        const result = await authedFetch<{
          success: boolean
          error?: string
          data?: { comment?: unknown }
        }>(
          `/api/posts/${postId}/comments`,
          'POST',
          accessToken,
          { content: savedContent },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )

        if (!scopeIsCurrent(capturedScope) || result.stale) return false

        if (
          result.ok &&
          result.data?.success &&
          isCreatedCommentAcknowledgement(result.data.data?.comment, {
            postId,
            userId: capturedScope.userId,
          })
        ) {
          const serverComment = result.data.data.comment
          if (
            (stateRevisionRef.current.get(revisionKey) || 0) === optimisticRevision &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)
          ) {
            setComments((prev) => prev.map((c) => (c.id === tempId ? serverComment : c)))
            usePostStore.getState().addComment(postId, toCommentData(serverComment))
          } else {
            await reconcileCanonicalComments(postId, 'best', capturedScope)
          }

          trackEvent('comment_created', { post_id: postId })
          return true
        } else if (isDefinitiveMutationRejection(result)) {
          await rollbackSubmission()
          if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('commentFailedRetry')),
              'error'
            )
          }
          return false
        } else if (!(await reconcileCanonicalComments(postId, 'best', capturedScope))) {
          // Commit status is unknown. Keep the optimistic/server-event state;
          // the false ACK tells the local composer to retain its scoped draft.
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
        return false
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCanonicalComments(postId, 'best', capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
        return false
      } finally {
        if (submittingCommentRef.current === operation) {
          submittingCommentRef.current = null
          if (scopeIsCurrent(capturedScope)) setSubmittingComment(false)
        }
      }
    },
    [
      accessToken,
      requireAuth,
      showToast,
      onCommentCountChange,
      t,
      reconcileCanonicalComments,
      scopeIsCurrent,
      setComments,
      setSubmittingComment,
    ]
  )

  const toggleCommentReaction = useCallback(
    async (
      postId: string,
      commentId: string,
      requestedReaction: CommentReaction
    ): Promise<void> => {
      if (!requireAuth() || pendingReactionIdsRef.current.has(commentId)) return
      const operation = Symbol('comment-reaction')
      const capturedScope = activeScopeRef.current

      const targetComment = findComment(commentsRef.current, commentId)
      if (!targetComment) return

      pendingReactionIdsRef.current.set(commentId, operation)
      setCommentLikeLoading((previous) => ({ ...previous, [commentId]: true }))

      const previousReaction = getCommentReaction(targetComment)
      const nextReaction = previousReaction === requestedReaction ? null : requestedReaction
      const previousLikeCount = Math.max(0, targetComment.like_count || 0)
      const previousDislikeCount = Math.max(0, targetComment.dislike_count || 0)
      const likeDelta = Number(nextReaction === 'like') - Number(previousReaction === 'like')
      const dislikeDelta =
        Number(nextReaction === 'dislike') - Number(previousReaction === 'dislike')
      const optimisticLikeCount = Math.max(0, previousLikeCount + likeDelta)
      const optimisticDislikeCount = Math.max(0, previousDislikeCount + dislikeDelta)

      setComments((previous) =>
        updateComment(previous, commentId, (comment) => ({
          ...comment,
          user_liked: nextReaction === 'like',
          user_disliked: nextReaction === 'dislike',
          like_count: optimisticLikeCount,
          dislike_count: optimisticDislikeCount,
        }))
      )
      const revisionKey = commentViewerScopeKey(capturedScope)
      const optimisticRevision = stateRevisionRef.current.get(revisionKey) || 0

      const rollback = () => {
        if (
          !scopeIsCurrent(capturedScope) ||
          (stateRevisionRef.current.get(revisionKey) || 0) !== optimisticRevision
        )
          return
        if (currentPostIdRef.current !== null && currentPostIdRef.current !== postId) return
        setComments((previous) =>
          updateComment(previous, commentId, (comment) => {
            // A refresh or another authoritative update may have replaced this optimistic
            // state while the request was in flight. Never overwrite that newer state.
            if (
              getCommentReaction(comment) !== nextReaction ||
              comment.like_count !== optimisticLikeCount ||
              comment.dislike_count !== optimisticDislikeCount
            ) {
              return comment
            }
            return {
              ...comment,
              user_liked: previousReaction === 'like',
              user_disliked: previousReaction === 'dislike',
              like_count: previousLikeCount,
              dislike_count: previousDislikeCount,
            }
          })
        )
      }

      try {
        const result = await authedFetch<{
          success: boolean
          error?: string
          data?: unknown
        }>(
          `/api/posts/${postId}/comments/like`,
          'POST',
          accessToken,
          {
            comment_id: commentId,
            type: requestedReaction,
          },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )

        if (!scopeIsCurrent(capturedScope) || result.stale) return

        if (
          result.ok &&
          result.data?.success &&
          isCommentReactionResponse(result.data.data, nextReaction)
        ) {
          const serverReaction = result.data.data
          if (
            (stateRevisionRef.current.get(revisionKey) || 0) === optimisticRevision &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)
          ) {
            setComments((previous) =>
              updateComment(previous, commentId, (comment) => {
                // A valid ACK can still be older than a Realtime event or a
                // canonical refresh. Apply it only to the exact optimistic state.
                if (
                  getCommentReaction(comment) !== nextReaction ||
                  comment.like_count !== optimisticLikeCount ||
                  comment.dislike_count !== optimisticDislikeCount
                ) {
                  return comment
                }
                return {
                  ...comment,
                  like_count: serverReaction.like_count,
                  dislike_count: serverReaction.dislike_count,
                  user_liked: serverReaction.liked,
                  user_disliked: serverReaction.disliked,
                }
              })
            )
          } else await reconcileCanonicalComments(postId, 'best', capturedScope)
        } else if (isDefinitiveMutationRejection(result)) {
          rollback()
          if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('operationFailed')),
              result.status === 429 ? 'warning' : 'error'
            )
          }
        } else if (!(await reconcileCanonicalComments(postId, 'best', capturedScope))) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCanonicalComments(postId, 'best', capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } finally {
        if (pendingReactionIdsRef.current.get(commentId) === operation) {
          pendingReactionIdsRef.current.delete(commentId)
        }
        if (
          scopeIsCurrent(capturedScope) &&
          (currentPostIdRef.current === null || currentPostIdRef.current === postId)
        ) {
          setCommentLikeLoading((previous) => ({ ...previous, [commentId]: false }))
        }
      }
    },
    [
      accessToken,
      reconcileCanonicalComments,
      requireAuth,
      scopeIsCurrent,
      setCommentLikeLoading,
      setComments,
      showToast,
      t,
    ]
  )

  const toggleCommentLike = useCallback(
    (postId: string, commentId: string) => toggleCommentReaction(postId, commentId, 'like'),
    [toggleCommentReaction]
  )

  const toggleCommentDislike = useCallback(
    (postId: string, commentId: string) => toggleCommentReaction(postId, commentId, 'dislike'),
    [toggleCommentReaction]
  )

  const submitReply = useCallback(
    async (postId: string, parentId: string): Promise<void> => {
      if (!requireAuth() || !replyContent.trim()) return
      if (currentPostIdRef.current !== postId) return
      const parentComment = findComment(commentsRef.current, parentId)
      if (!parentComment || parentComment.parent_id) return
      if (submittingReplyRef.current) return // Prevent double submission

      const operation = Symbol('submit-reply')
      const capturedScope = activeScopeRef.current
      submittingReplyRef.current = operation
      setSubmittingReply(true)

      // Optimistic: show reply immediately
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticReply: Comment = {
        id: tempId,
        content: replyContent.trim(),
        created_at: new Date().toISOString(),
      }
      const savedContent = replyContent.trim()
      setComments((prev) =>
        prev.map((c) =>
          c.id === parentId ? { ...c, replies: [...(c.replies || []), optimisticReply] } : c
        )
      )
      const revisionKey = commentViewerScopeKey(capturedScope)
      const optimisticRevision = stateRevisionRef.current.get(revisionKey) || 0
      setExpandedReplies((prev) => ({ ...prev, [parentId]: true }))
      onCommentCountChange?.(postId, 1)

      const rollbackReply = async () => {
        if (!scopeIsCurrent(capturedScope)) return
        if (
          (stateRevisionRef.current.get(revisionKey) || 0) === optimisticRevision &&
          (currentPostIdRef.current === null || currentPostIdRef.current === postId)
        ) {
          setComments((prev) =>
            prev.map((comment) =>
              comment.id === parentId
                ? {
                    ...comment,
                    replies: (comment.replies || []).filter((reply) => reply.id !== tempId),
                  }
                : comment
            )
          )
          onCommentCountChange?.(postId, -1)
        } else {
          await reconcileCanonicalComments(postId, 'best', capturedScope)
        }
      }

      try {
        const result = await authedFetch<{
          success: boolean
          error?: string
          data?: { comment?: unknown }
        }>(
          `/api/posts/${postId}/comments`,
          'POST',
          accessToken,
          {
            content: savedContent,
            parent_id: parentId,
          },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )

        if (!scopeIsCurrent(capturedScope) || result.stale) return

        if (
          result.ok &&
          result.data?.success &&
          isCreatedCommentAcknowledgement(result.data.data?.comment, {
            postId,
            parentId,
            userId: capturedScope.userId,
          })
        ) {
          const serverReply = result.data.data.comment
          if (
            (stateRevisionRef.current.get(revisionKey) || 0) === optimisticRevision &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)
          ) {
            setComments((prev) =>
              prev.map((c) =>
                c.id === parentId
                  ? {
                      ...c,
                      replies: (c.replies || []).map((r) => (r.id === tempId ? serverReply : r)),
                    }
                  : c
              )
            )
          } else await reconcileCanonicalComments(postId, 'best', capturedScope)

          if (replyContentRef.current.trim() === savedContent) {
            setReplyContent('')
            setReplyingTo(null)
          }
          if (scopeIsCurrent(capturedScope)) showToast(t('replied'), 'success')
        } else if (isDefinitiveMutationRejection(result)) {
          await rollbackReply()
          if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('operationFailed')),
              result.status === 429 ? 'warning' : 'error'
            )
          }
        } else if (!(await reconcileCanonicalComments(postId, 'best', capturedScope))) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCanonicalComments(postId, 'best', capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } finally {
        if (submittingReplyRef.current === operation) {
          submittingReplyRef.current = null
          if (scopeIsCurrent(capturedScope)) setSubmittingReply(false)
        }
      }
    },
    [
      accessToken,
      onCommentCountChange,
      reconcileCanonicalComments,
      replyContent,
      requireAuth,
      scopeIsCurrent,
      setComments,
      setExpandedReplies,
      setReplyContent,
      setReplyingTo,
      setSubmittingReply,
      showToast,
      t,
    ]
  )

  const startEditComment = useCallback(
    (comment: Comment) => {
      setEditingComment({ id: comment.id, content: comment.content })
      setEditContent(comment.content)
    },
    [setEditContent, setEditingComment]
  )

  const cancelEditComment = useCallback(() => {
    setEditingComment(null)
    setEditContent('')
  }, [setEditContent, setEditingComment])

  const submitEditComment = useCallback(
    async (postId: string): Promise<void> => {
      if (!editingComment || !editContent.trim() || !requireAuth()) return

      const targetComment = findComment(commentsRef.current, editingComment.id)
      if (!targetComment) return
      const boundPostId = currentPostIdRef.current
      if (boundPostId !== null && boundPostId !== postId) return
      const requestGeneration = loadRequestGenerationRef.current
      const expectedContent = editContent.trim()
      const capturedScope = activeScopeRef.current
      const revisionKey = commentViewerScopeKey(capturedScope)
      const requestStartRevision = stateRevisionRef.current.get(revisionKey) || 0
      const operation = Symbol('edit-comment')

      submittingEditRef.current = operation
      setSubmittingEdit(true)
      try {
        const result = await authedFetch<{
          success: boolean
          error?: string
          data?: { comment?: unknown }
        }>(
          `/api/posts/${postId}/comments`,
          'PUT',
          accessToken,
          {
            comment_id: editingComment.id,
            content: expectedContent,
          },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )

        if (!scopeIsCurrent(capturedScope) || result.stale) return

        if (
          result.ok &&
          result.data?.success &&
          isEditedCommentResponse(result.data.data?.comment, {
            commentId: editingComment.id,
            postId,
            userId: capturedScope.userId,
            content: expectedContent,
          })
        ) {
          const acknowledgement = result.data.data.comment
          const responseStillTargetsVisibleTree =
            requestGeneration === loadRequestGenerationRef.current &&
            (stateRevisionRef.current.get(revisionKey) || 0) === requestStartRevision &&
            scopeIsCurrent(capturedScope) &&
            currentPostIdRef.current === boundPostId &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)

          if (responseStillTargetsVisibleTree) {
            const updateInList = (c: Comment): Comment => {
              if (c.id === editingComment.id) {
                return {
                  ...c,
                  content: acknowledgement.content,
                  updated_at: acknowledgement.updated_at,
                  like_count: acknowledgement.like_count,
                  dislike_count: acknowledgement.dislike_count,
                }
              }
              if (c.replies) {
                return { ...c, replies: c.replies.map(updateInList) }
              }
              return c
            }
            setComments((prev) => prev.map(updateInList))
            setEditingComment(null)
            setEditContent('')
            if (scopeIsCurrent(capturedScope)) showToast(t('saved'), 'success')
          } else {
            // The ACK is valid but belongs to an older generation/resource.
            // Refresh its keyed cache without touching the newly visible post.
            await reconcileCanonicalComments(postId, 'best', capturedScope)
          }
        } else if (isDefinitiveMutationRejection(result)) {
          if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('operationFailed')),
              result.status === 429 ? 'warning' : 'error'
            )
          }
        } else if (!(await reconcileCanonicalComments(postId, 'best', capturedScope))) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCanonicalComments(postId, 'best', capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } finally {
        if (submittingEditRef.current === operation) {
          submittingEditRef.current = null
          if (scopeIsCurrent(capturedScope)) setSubmittingEdit(false)
        }
      }
    },
    [
      accessToken,
      editingComment,
      editContent,
      reconcileCanonicalComments,
      requireAuth,
      scopeIsCurrent,
      setComments,
      setEditContent,
      setEditingComment,
      setSubmittingEdit,
      showToast,
      t,
    ]
  )

  const deleteComment = useCallback(
    async (postId: string, commentId: string): Promise<void> => {
      if (!requireAuth() || pendingDeleteIdsRef.current.size > 0) return

      // A stale click must not issue a delete for an item that is no longer in
      // this hook's current tree.
      const targetComment = findComment(commentsRef.current, commentId)
      if (!targetComment) return
      const boundPostId = currentPostIdRef.current
      if (boundPostId !== null && boundPostId !== postId) return

      // Reserve the operation before opening the async confirmation dialog so
      // double-clicks cannot open parallel confirms. A post switch/refresh
      // increments the generation while the dialog is open; re-check both the
      // resource binding and the target before issuing the destructive call.
      const requestGeneration = loadRequestGenerationRef.current
      const capturedScope = activeScopeRef.current
      const operation = Symbol('delete-comment')
      pendingDeleteIdsRef.current.set(commentId, operation)
      const confirmed = await showDangerConfirm(
        t('deleteComment'),
        t('confirmDeleteComment')
      ).catch(() => false)
      const stillTargetsCurrentPost =
        requestGeneration === loadRequestGenerationRef.current &&
        scopeIsCurrent(capturedScope) &&
        currentPostIdRef.current === boundPostId &&
        !!findComment(commentsRef.current, commentId)

      if (!confirmed || !stillTargetsCurrentPost) {
        if (pendingDeleteIdsRef.current.get(commentId) === operation) {
          pendingDeleteIdsRef.current.delete(commentId)
        }
        return
      }

      const revisionKey = commentViewerScopeKey(capturedScope)
      const requestStartRevision = stateRevisionRef.current.get(revisionKey) || 0
      setDeletingCommentId(commentId)
      try {
        const result = await authedFetch<{
          success: boolean
          error?: string
          data?: DeleteCommentResponse
        }>(
          `/api/posts/${postId}/comments`,
          'DELETE',
          accessToken,
          { comment_id: commentId },
          15_000,
          {
            expectedUserId: capturedScope.userId,
            expectedSessionGeneration: capturedScope.sessionGeneration,
          }
        )

        if (!scopeIsCurrent(capturedScope) || result.stale) return

        if (result.ok && result.data?.success && isDeleteCommentResponse(result.data.data)) {
          const acknowledgement = result.data.data
          const responseStillTargetsVisibleTree =
            requestGeneration === loadRequestGenerationRef.current &&
            (stateRevisionRef.current.get(revisionKey) || 0) === requestStartRevision &&
            scopeIsCurrent(capturedScope) &&
            currentPostIdRef.current === boundPostId &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)

          if (responseStillTargetsVisibleTree) {
            setComments((prev) =>
              prev
                .map((c) => {
                  if (c.id === commentId) return null
                  if (c.replies?.length) {
                    return { ...c, replies: c.replies.filter((r) => r.id !== commentId) }
                  }
                  return c
                })
                .filter((c): c is Comment => c !== null)
            )
          } else {
            await reconcileCanonicalComments(postId, 'best', capturedScope)
          }
          if (responseStillTargetsVisibleTree) {
            onCommentCountChange?.(
              postId,
              -acknowledgement.deleted_count,
              acknowledgement.comment_count
            )
            usePostStore.getState().updatePostCommentCount(postId, acknowledgement.comment_count)
          }
          if (scopeIsCurrent(capturedScope)) showToast(t('deleted'), 'success')
        } else if (result.status === 404) {
          // A comment may be auto-moderated/soft-deleted after it was rendered
          // but before this DELETE reaches the route. Treat the 404 as an
          // idempotent success only when a fresh canonical read proves the
          // target is now absent; the visible tree/count come from that read.
          const canonical = await reconcileCanonicalComments(postId, 'best', capturedScope)
          if (canonical && !findComment(canonical, commentId)) {
            if (scopeIsCurrent(capturedScope)) showToast(t('deleted'), 'success')
          } else if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('operationFailed')),
              'error'
            )
          }
        } else if (isDefinitiveMutationRejection(result)) {
          if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('operationFailed')),
              result.status === 429 ? 'warning' : 'error'
            )
          }
        } else if (!(await reconcileCanonicalComments(postId, 'best', capturedScope))) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } catch {
        if (
          scopeIsCurrent(capturedScope) &&
          !(await reconcileCanonicalComments(postId, 'best', capturedScope))
        ) {
          if (scopeIsCurrent(capturedScope)) showToast(t('networkError'), 'error')
        }
      } finally {
        if (pendingDeleteIdsRef.current.get(commentId) === operation) {
          pendingDeleteIdsRef.current.delete(commentId)
        }
        if (scopeIsCurrent(capturedScope)) setDeletingCommentId(null)
      }
    },
    [
      accessToken,
      onCommentCountChange,
      reconcileCanonicalComments,
      requireAuth,
      scopeIsCurrent,
      setComments,
      setDeletingCommentId,
      showDangerConfirm,
      showToast,
      t,
    ]
  )

  return {
    comments,
    setComments,
    loadingComments,
    submittingComment,
    replyingTo,
    setReplyingTo,
    replyContent,
    setReplyContent,
    submittingReply,
    commentLikeLoading,
    expandedReplies,
    setExpandedReplies,
    deletingCommentId,
    editingComment,
    editContent,
    setEditContent,
    submittingEdit,
    startEditComment,
    cancelEditComment,
    submitEditComment,
    loadComments,
    submitComment,
    toggleCommentLike,
    toggleCommentDislike,
    submitReply,
    deleteComment,
  }
}
