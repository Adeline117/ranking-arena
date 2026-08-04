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
import {
  COMMENT_REACTION_OPERATION,
  COMMENT_REACTION_REQUEST_TIMEOUT_MS,
  commentReactionCountDelta,
  createCommentReactionRequestId,
  isDefinitiveCommentReactionRejection,
  nextCommentReactionState,
  readCommentReactionAcknowledgement,
  type CommentReaction,
  type CommentReactionAcknowledgement,
} from '@/lib/comments/comment-reaction-client-contract'

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
    comment.content === expected.content &&
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

function getCommentReactionTruth(comment: Comment): CommentReactionTruth {
  return {
    reaction: getCommentReaction(comment),
    likeCount: Math.max(0, comment.like_count || 0),
    dislikeCount: Math.max(0, comment.dislike_count || 0),
  }
}

function applyDesiredCommentReaction(comment: Comment, desired: CommentReaction | null): Comment {
  const current = getCommentReaction(comment)
  const delta = commentReactionCountDelta(current, desired)
  return {
    ...comment,
    user_liked: desired === 'like',
    user_disliked: desired === 'dislike',
    like_count: Math.max(0, (comment.like_count || 0) + delta.likeCount),
    dislike_count: Math.max(0, (comment.dislike_count || 0) + delta.dislikeCount),
  }
}

function applyCommentReactionTruth(comment: Comment, truth: CommentReactionTruth): Comment {
  return {
    ...comment,
    user_liked: truth.reaction === 'like',
    user_disliked: truth.reaction === 'dislike',
    like_count: truth.likeCount,
    dislike_count: truth.dislikeCount,
  }
}

function commentMatchesReactionTruth(comment: Comment, truth: CommentReactionTruth): boolean {
  return (
    getCommentReaction(comment) === truth.reaction &&
    Math.max(0, comment.like_count || 0) === truth.likeCount &&
    Math.max(0, comment.dislike_count || 0) === truth.dislikeCount
  )
}

function overlayPendingCommentReactionProjections(
  comments: Comment[],
  intentFor: (commentId: string) => CommentReactionIntent | undefined
): Comment[] {
  return comments.map((comment) => {
    const intent = intentFor(comment.id)
    const projected = intent ? applyDesiredCommentReaction(comment, intent.desired) : comment
    if (intent) intent.projection = getCommentReactionTruth(projected)
    const replies = projected.replies
      ? overlayPendingCommentReactionProjections(projected.replies, intentFor)
      : projected.replies
    return replies === projected.replies ? projected : { ...projected, replies }
  })
}

function commentReactionError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const error = (value as Record<string, unknown>).error
  return typeof error === 'string' ? error : null
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

type CommentReactionIntent = {
  desired: CommentReaction | null
  revision: number
  requestId: string
  projection: CommentReactionTruth
  // Scope-wide on purpose: any concurrent tree mutation makes a stale ACK
  // reconcile instead of relying on projection equality (which has ABA cases).
  visibleStateRevision: number
}

type CommentReactionTruth = {
  reaction: CommentReaction | null
  likeCount: number
  dislikeCount: number
}

type CommentReactionCommandOutcome =
  | { kind: 'acknowledged'; acknowledgement: CommentReactionAcknowledgement }
  | { kind: 'definitive-rejection'; error: string | null; status: number }
  | { kind: 'uncertain'; error: unknown }

type PendingCommentReaction = {
  controller: AbortController
}

function commentViewerScopeKey(scope: Pick<CommentViewerScope, 'viewerKey' | 'sessionGeneration'>) {
  return `${scope.viewerKey}\u0000${scope.sessionGeneration}`
}

function commentReactionLaneKey(
  scope: Pick<CommentViewerScope, 'viewerKey' | 'sessionGeneration'>,
  postId: string,
  commentId: string
) {
  return `${commentViewerScopeKey(scope)}\u0000${postId}\u0000${commentId}`
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
  const [submittingEdit, setSubmittingEdit] = useViewerOwnedState(false, () => false, scopeKey)
  const submittingEditRef = useRef<symbol | null>(null)

  // Ref-based guards to prevent double submissions
  const submittingCommentRef = useRef<symbol | null>(null)
  const submittingReplyRef = useRef<symbol | null>(null)
  const pendingReactionOperationsRef = useRef(new Map<string, PendingCommentReaction>())
  const commentReactionIntentRef = useRef(new Map<string, CommentReactionIntent>())
  const commentReactionWorkerRef = useRef(new Map<string, Promise<void>>())
  const commentReactionRevisionRef = useRef(0)
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

  const abortPendingCommentReactions = useCallback(() => {
    for (const pending of pendingReactionOperationsRef.current.values()) {
      pending.controller.abort()
    }
    pendingReactionOperationsRef.current.clear()
    commentReactionIntentRef.current.clear()
    commentReactionWorkerRef.current.clear()
    commentReactionRevisionRef.current = 0
  }, [])

  useEffect(
    () => () => {
      abortPendingCommentReactions()
    },
    [abortPendingCommentReactions]
  )

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
    abortPendingCommentReactions()
    pendingDeleteIdsRef.current.clear()
    setComments([])
    setLoadingComments(false)
    setSubmittingComment(false)
    setSubmittingReply(false)
    setCommentLikeLoading({})
    setDeletingCommentId(null)
    setReplyingTo(null)
    setExpandedReplies({})
    setEditingComment(null)
    setSubmittingEdit(false)
  }, [
    scopeKey,
    abortPendingCommentReactions,
    setCommentLikeLoading,
    setComments,
    setDeletingCommentId,
    setEditingComment,
    setExpandedReplies,
    setLoadingComments,
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

        // A canonical tree read may overlap a reaction lane on this or another
        // comment. Refresh structural fields from the server while retaining
        // every still-active per-comment desired-state projection.
        const visibleComments = overlayPendingCommentReactionProjections(
          page.comments,
          (commentId) =>
            commentReactionIntentRef.current.get(
              commentReactionLaneKey(capturedScope, postId, commentId)
            )
        )
        const store = usePostStore.getState()
        store.setComments(postId, visibleComments.map(toCommentData))
        store.updatePostCommentCount(postId, page.commentCount)
        onCommentCountChange?.(postId, 0, page.commentCount)

        if (
          scopeIsCurrent(capturedScope) &&
          (currentPostIdRef.current === null || currentPostIdRef.current === postId)
        ) {
          setComments(visibleComments)
        }
        return visibleComments
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
        abortPendingCommentReactions()
        setComments([])
        setReplyingTo(null)
        setExpandedReplies({})
        setEditingComment(null)
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
      abortPendingCommentReactions,
      reconcileCanonicalComments,
      scopeIsCurrent,
      setCommentLikeLoading,
      setComments,
      setDeletingCommentId,
      setEditingComment,
      setExpandedReplies,
      setLoadingComments,
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
    async (postId: string, commentId: string, selectedReaction: CommentReaction): Promise<void> => {
      const capturedScope = activeScopeRef.current
      if (!requireAuth() || !capturedScope.userId || !scopeIsCurrent(capturedScope)) return
      const actorId = capturedScope.userId
      if (currentPostIdRef.current !== null && currentPostIdRef.current !== postId) return

      const targetComment = findComment(commentsRef.current, commentId)
      if (!targetComment) return
      const laneKey = commentReactionLaneKey(capturedScope, postId, commentId)
      const queuedIntent = commentReactionIntentRef.current.get(laneKey)
      const desiredReaction = nextCommentReactionState(
        queuedIntent?.desired ?? getCommentReaction(targetComment),
        selectedReaction
      )
      const projectedComment = applyDesiredCommentReaction(targetComment, desiredReaction)
      const intent: CommentReactionIntent = {
        desired: desiredReaction,
        revision: ++commentReactionRevisionRef.current,
        requestId: createCommentReactionRequestId(),
        projection: getCommentReactionTruth(projectedComment),
        visibleStateRevision: -1,
      }
      commentReactionIntentRef.current.set(laneKey, intent)

      setCommentLikeLoading((previous) => ({ ...previous, [commentId]: true }))
      setComments((previous) =>
        updateComment(previous, commentId, (comment) => {
          const projected = applyDesiredCommentReaction(comment, desiredReaction)
          const latest = commentReactionIntentRef.current.get(laneKey)
          if (latest?.revision === intent.revision) {
            latest.projection = getCommentReactionTruth(projected)
          }
          return projected
        })
      )
      intent.visibleStateRevision =
        stateRevisionRef.current.get(commentViewerScopeKey(capturedScope)) || 0

      const sendCommand = async (
        command: CommentReactionIntent,
        signal: AbortSignal
      ): Promise<CommentReactionCommandOutcome> => {
        let lastError: unknown = new Error('Comment reaction acknowledgement unavailable')

        // An absolute desired state is safe to retry. Reuse the exact request
        // identity so a lost response cannot be confused with a newer click.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (signal.aborted || !scopeIsCurrent(capturedScope)) {
            return { kind: 'uncertain', error: signal.reason ?? lastError }
          }
          try {
            const result = await authedFetch<unknown>(
              `/api/posts/${postId}/comments/like`,
              'POST',
              accessToken,
              {
                operation: COMMENT_REACTION_OPERATION,
                request_id: command.requestId,
                comment_id: commentId,
                desired_reaction: command.desired,
              },
              COMMENT_REACTION_REQUEST_TIMEOUT_MS,
              {
                expectedUserId: capturedScope.userId,
                expectedSessionGeneration: capturedScope.sessionGeneration,
                signal,
              }
            )
            if (signal.aborted || !scopeIsCurrent(capturedScope) || result.stale) {
              return { kind: 'uncertain', error: signal.reason ?? lastError }
            }

            const acknowledgement =
              result.ok && result.status === 200
                ? readCommentReactionAcknowledgement(result.data, {
                    actorId,
                    postId,
                    commentId,
                    requestId: command.requestId,
                    desiredReaction: command.desired,
                  })
                : null
            if (acknowledgement) return { kind: 'acknowledged', acknowledgement }

            const error = commentReactionError(result.data)
            if (isDefinitiveCommentReactionRejection(result.status)) {
              return { kind: 'definitive-rejection', error, status: result.status }
            }
            lastError = error ? new Error(error) : lastError
          } catch (error) {
            lastError = error
          }
        }

        return { kind: 'uncertain', error: lastError }
      }

      const drainIntents = async (signal: AbortSignal): Promise<void> => {
        let knownTruth = getCommentReactionTruth(targetComment)
        let knownTruthIsCertain = true

        while (!signal.aborted && scopeIsCurrent(capturedScope)) {
          const command = commentReactionIntentRef.current.get(laneKey)
          if (!command) return
          const outcome = await sendCommand(command, signal)
          if (signal.aborted || !scopeIsCurrent(capturedScope)) return
          const latestIntent = commentReactionIntentRef.current.get(laneKey)

          if (outcome.kind === 'acknowledged') {
            const acknowledgement = outcome.acknowledgement
            knownTruth = {
              reaction: acknowledgement.reaction,
              likeCount: acknowledgement.likeCount,
              dislikeCount: acknowledgement.dislikeCount,
            }
            knownTruthIsCertain = true

            // An older ACK cannot overwrite a newer opposite intent. When the
            // latest intent converges to the same state, one ACK closes the lane.
            if (latestIntent?.desired === acknowledgement.reaction) {
              const acknowledgementCanReplaceVisibleState =
                latestIntent.visibleStateRevision ===
                (stateRevisionRef.current.get(commentViewerScopeKey(capturedScope)) || 0)
              commentReactionIntentRef.current.delete(laneKey)
              if (acknowledgementCanReplaceVisibleState) {
                setComments((previous) =>
                  updateComment(previous, commentId, (comment) =>
                    commentMatchesReactionTruth(comment, latestIntent.projection)
                      ? applyCommentReactionTruth(comment, knownTruth)
                      : comment
                  )
                )
              } else {
                await reconcileCanonicalComments(postId, 'best', capturedScope)
              }
              return
            }

            if (latestIntent) {
              // Rebase the pending projection on the absolute counters returned
              // by the older command, but only if no external truth replaced it.
              if (
                latestIntent.visibleStateRevision ===
                (stateRevisionRef.current.get(commentViewerScopeKey(capturedScope)) || 0)
              ) {
                setComments((previous) =>
                  updateComment(previous, commentId, (comment) => {
                    if (!commentMatchesReactionTruth(comment, latestIntent.projection)) {
                      return comment
                    }
                    const rebased = applyDesiredCommentReaction(
                      applyCommentReactionTruth(comment, knownTruth),
                      latestIntent.desired
                    )
                    latestIntent.projection = getCommentReactionTruth(rebased)
                    return rebased
                  })
                )
                latestIntent.visibleStateRevision =
                  stateRevisionRef.current.get(commentViewerScopeKey(capturedScope)) || 0
              }
            }
            continue
          }

          if (outcome.kind === 'definitive-rejection') {
            if (latestIntent?.revision === command.revision) {
              commentReactionIntentRef.current.delete(laneKey)
              if (
                knownTruthIsCertain &&
                command.visibleStateRevision ===
                  (stateRevisionRef.current.get(commentViewerScopeKey(capturedScope)) || 0)
              ) {
                setComments((previous) =>
                  updateComment(previous, commentId, (comment) =>
                    commentMatchesReactionTruth(comment, command.projection)
                      ? applyCommentReactionTruth(comment, knownTruth)
                      : comment
                  )
                )
              } else {
                await reconcileCanonicalComments(postId, 'best', capturedScope)
              }
              if (scopeIsCurrent(capturedScope)) {
                showToast(
                  getHttpErrorMessage(outcome.status, outcome.error ?? t('operationFailed')),
                  outcome.status === 429 ? 'warning' : 'error'
                )
              }
              return
            }
            continue
          }

          // Both attempts are uncertain. Never invert a command that may have
          // committed. A newer absolute intent can still converge safely.
          knownTruthIsCertain = false
          if (latestIntent?.revision === command.revision) {
            commentReactionIntentRef.current.delete(laneKey)
            const reconciled = await reconcileCanonicalComments(postId, 'best', capturedScope)
            if (!reconciled && scopeIsCurrent(capturedScope)) {
              showToast(t('networkError'), 'error')
            }
            return
          }
        }
      }

      const startWorker = (): Promise<void> => {
        const running = commentReactionWorkerRef.current.get(laneKey)
        if (running) return running

        const controller = new AbortController()
        pendingReactionOperationsRef.current.set(laneKey, { controller })
        const worker = drainIntents(controller.signal).finally(() => {
          if (commentReactionWorkerRef.current.get(laneKey) === worker) {
            commentReactionWorkerRef.current.delete(laneKey)
          }
          if (pendingReactionOperationsRef.current.get(laneKey)?.controller === controller) {
            pendingReactionOperationsRef.current.delete(laneKey)
          }
          if (
            !commentReactionIntentRef.current.has(laneKey) &&
            scopeIsCurrent(capturedScope) &&
            (currentPostIdRef.current === null || currentPostIdRef.current === postId)
          ) {
            setCommentLikeLoading((previous) => ({ ...previous, [commentId]: false }))
          }
        })
        commentReactionWorkerRef.current.set(laneKey, worker)
        return worker
      }

      try {
        // Recheck after every worker completion so an intent queued in its final
        // microtask cannot be stranded without a drain.
        while (scopeIsCurrent(capturedScope) && commentReactionIntentRef.current.has(laneKey)) {
          await startWorker()
        }
      } catch {
        if (!scopeIsCurrent(capturedScope)) return
        commentReactionIntentRef.current.delete(laneKey)
        setCommentLikeLoading((previous) => ({ ...previous, [commentId]: false }))
        showToast(t('networkError'), 'error')
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
    async (postId: string, parentId: string, content: string): Promise<boolean> => {
      const savedContent = content.trim()
      if (!requireAuth() || !savedContent) return false
      if (currentPostIdRef.current !== postId) return false
      const parentComment = findComment(commentsRef.current, parentId)
      if (!parentComment || parentComment.parent_id) return false
      if (submittingReplyRef.current) return false // Prevent double submission

      const operation = Symbol('submit-reply')
      const capturedScope = activeScopeRef.current
      submittingReplyRef.current = operation
      setSubmittingReply(true)

      // Optimistic: show reply immediately
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const optimisticReply: Comment = {
        id: tempId,
        content: savedContent,
        created_at: new Date().toISOString(),
      }
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

        if (!scopeIsCurrent(capturedScope) || result.stale) return false

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

          if (scopeIsCurrent(capturedScope)) showToast(t('replied'), 'success')
          return true
        } else if (isDefinitiveMutationRejection(result)) {
          await rollbackReply()
          if (scopeIsCurrent(capturedScope)) {
            showToast(
              getHttpErrorMessage(result.status, result.data?.error || t('operationFailed')),
              result.status === 429 ? 'warning' : 'error'
            )
          }
          return false
        } else if (!(await reconcileCanonicalComments(postId, 'best', capturedScope))) {
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
      requireAuth,
      scopeIsCurrent,
      setComments,
      setExpandedReplies,
      setSubmittingReply,
      showToast,
      t,
    ]
  )

  const startEditComment = useCallback(
    (comment: Comment) => {
      setEditingComment({ id: comment.id, content: comment.content })
    },
    [setEditingComment]
  )

  const cancelEditComment = useCallback(
    (commentId?: string) => {
      setEditingComment((currentTarget) =>
        !commentId || currentTarget?.id === commentId ? null : currentTarget
      )
    },
    [setEditingComment]
  )

  const submitEditComment = useCallback(
    async (postId: string, commentId: string, content: string): Promise<boolean> => {
      const expectedContent = content.trim()
      if (!expectedContent || !requireAuth() || submittingEditRef.current) return false

      const targetComment = findComment(commentsRef.current, commentId)
      if (!targetComment) return false
      const boundPostId = currentPostIdRef.current
      if (boundPostId !== null && boundPostId !== postId) return false
      const requestGeneration = loadRequestGenerationRef.current
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
            comment_id: commentId,
            content: expectedContent,
          },
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
          isEditedCommentResponse(result.data.data?.comment, {
            commentId,
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
              if (c.id === commentId) {
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
            if (scopeIsCurrent(capturedScope)) showToast(t('saved'), 'success')
          } else {
            // The ACK is valid but belongs to an older generation/resource.
            // Refresh its keyed cache without touching the newly visible post.
            await reconcileCanonicalComments(postId, 'best', capturedScope)
          }
          return true
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
        if (submittingEditRef.current === operation) {
          submittingEditRef.current = null
          if (scopeIsCurrent(capturedScope)) setSubmittingEdit(false)
        }
      }
    },
    [
      accessToken,
      reconcileCanonicalComments,
      requireAuth,
      scopeIsCurrent,
      setComments,
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
    submittingReply,
    commentLikeLoading,
    expandedReplies,
    setExpandedReplies,
    deletingCommentId,
    editingComment,
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
