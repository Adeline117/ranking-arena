'use client'

/**
 * Unified Post Interaction Hook
 * Ensures consistent behavior for comments and reactions
 * across ALL entry points (hot page, groups, direct URL).
 *
 * Principles:
 * 1. Server ACK required before showing success
 * 2. Same post ID = same state, regardless of entry point
 * 3. Comments are ordered consistently (chronological, newest last)
 * 4. Failed operations are visible and retryable
 */

import { useState, useCallback, useRef } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from './useAuthSession'
import { logger } from '@/lib/logger'

export type Comment = {
  id: string
  content: string
  user_id: string
  post_id?: string
  parent_id?: string | null
  author_handle?: string | null
  author_avatar_url?: string | null
  like_count?: number
  created_at: string
  updated_at?: string
  /** Client-side only: tracks submit state */
  _status?: 'sending' | 'sent' | 'failed'
  _tempId?: string
}

export type CommentSubmitState = 'idle' | 'sending' | 'success' | 'error'

type UsePostCommentsOptions = {
  postId: string | null
  pageSize?: number
}

export function usePostComments({ postId, pageSize = 10 }: UsePostCommentsOptions) {
  const { getAuthHeaders, isLoggedIn, accessToken } = useAuthSession()
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [submitState, setSubmitState] = useState<CommentSubmitState>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const offsetRef = useRef(0)

  /** Load initial comments for a post */
  const loadComments = useCallback(async (targetPostId?: string) => {
    const pid = targetPostId || postId
    if (!pid) return

    setLoading(true)
    setHasMore(true)
    offsetRef.current = 0

    try {
      const headers: Record<string, string> = {}
      const authHeaders = getAuthHeaders()
      if (authHeaders) Object.assign(headers, authHeaders)

      const response = await fetch(
        `/api/posts/${pid}/comments?limit=${pageSize}&offset=0`,
        { headers }
      )
      const data = await response.json()

      if (response.ok) {
        const loadedComments: Comment[] = (data.comments || []).map((c: Comment) => ({
          ...c,
          _status: 'sent' as const,
        }))
        setComments(loadedComments)
        setHasMore(data.pagination?.has_more ?? loadedComments.length === pageSize)
        offsetRef.current = loadedComments.length
      } else {
        setComments([])
        setHasMore(false)
      }
    } catch (err) {
      logger.error('[usePostComments] Failed to load comments:', err)
      setComments([])
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [postId, pageSize, getAuthHeaders])

  /** Load more comments (pagination) */
  const loadMore = useCallback(async () => {
    if (!postId || loadingMore || !hasMore) return

    setLoadingMore(true)
    try {
      const headers: Record<string, string> = {}
      const authHeaders = getAuthHeaders()
      if (authHeaders) Object.assign(headers, authHeaders)

      const response = await fetch(
        `/api/posts/${postId}/comments?limit=${pageSize}&offset=${offsetRef.current}`,
        { headers }
      )
      const data = await response.json()

      if (response.ok) {
        const newComments: Comment[] = (data.comments || []).map((c: Comment) => ({
          ...c,
          _status: 'sent' as const,
        }))
        setComments(prev => [...prev, ...newComments])
        setHasMore(data.pagination?.has_more ?? newComments.length === pageSize)
        offsetRef.current += newComments.length
      } else {
        setHasMore(false)
      }
    } catch (err) {
      logger.error('[usePostComments] Failed to load more:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [postId, loadingMore, hasMore, pageSize, getAuthHeaders])

  /**
   * Submit a comment. Server ACK is required:
   * - Shows "sending" state
   * - On success: replaces with server-confirmed comment
   * - On failure: shows error state, comment is NOT shown as successful
   */
  const submitComment = useCallback(async (
    content: string,
    options?: { parentId?: string; onSuccess?: (comment: Comment) => void }
  ): Promise<Comment | null> => {
    if (!postId || !content.trim()) return null

    const authHeaders = getAuthHeaders()
    if (!authHeaders) {
      const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
      useLoginModal.getState().openLoginModal()
      return null
    }

    setSubmitState('sending')
    setSubmitError(null)

    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({
          content: content.trim(),
          ...(options?.parentId ? { parent_id: options.parentId } : {}),
        }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        const serverComment: Comment = {
          ...json.data.comment,
          _status: 'sent' as const,
        }

        // Add the server-confirmed comment to the list
        setComments(prev => [...prev, serverComment])
        setSubmitState('success')

        // Reset to idle after a brief success indicator
        setTimeout(() => setSubmitState('idle'), 500)

        options?.onSuccess?.(serverComment)
        return serverComment
      } else {
        // Server rejected the comment
        const errorMsg = json.error || '发表评论失败'
        setSubmitError(errorMsg)
        setSubmitState('error')
        return null
      }
    } catch (err) {
      logger.error('[usePostComments] Submit failed:', err)
      setSubmitError('网络错误，请重试')
      setSubmitState('error')
      return null
    }
  }, [postId, getAuthHeaders])

  /** Reset comment state (when closing modal, switching posts, etc.) */
  const reset = useCallback(() => {
    setComments([])
    setLoading(false)
    setLoadingMore(false)
    setHasMore(true)
    setSubmitState('idle')
    setSubmitError(null)
    offsetRef.current = 0
  }, [])

  return {
    comments,
    loading,
    loadingMore,
    hasMore,
    submitState,
    submitError,
    loadComments,
    loadMore,
    submitComment,
    reset,
    isLoggedIn,
    accessToken,
  }
}

/**
 * Unified reaction hook (like/dislike).
 * Optimistic update pattern (like Mastodon/Discourse):
 * 1. Immediately update UI with predicted state
 * 2. Send request to server in background
 * 3. On success: reconcile with server counts
 * 4. On failure: rollback to previous state + show error
 */
export function usePostReaction() {
  const { getAuthHeaders, isLoggedIn } = useAuthSession()
  const [loading, setLoading] = useState<Record<string, boolean>>({})

  const toggleReaction = useCallback(async (
    postId: string,
    reactionType: 'up' | 'down',
    options?: {
      onSuccess?: (result: { like_count: number; dislike_count: number; reaction: 'up' | 'down' | null }) => void
      onError?: (error: string) => void
      /** Current state for optimistic rollback */
      currentReaction?: 'up' | 'down' | null
      currentLikeCount?: number
      currentDislikeCount?: number
    }
  ): Promise<{ like_count: number; dislike_count: number; reaction: 'up' | 'down' | null } | null> => {
    const authHeaders = getAuthHeaders()
    if (!authHeaders) {
      const { useLoginModal } = await import('@/lib/hooks/useLoginModal')
      useLoginModal.getState().openLoginModal()
      return null
    }

    // Compute optimistic result before server call
    const prevReaction = options?.currentReaction ?? null
    const prevLike = options?.currentLikeCount ?? 0
    const prevDislike = options?.currentDislikeCount ?? 0

    let optimisticReaction: 'up' | 'down' | null
    let optimisticLike = prevLike
    let optimisticDislike = prevDislike

    if (prevReaction === reactionType) {
      // Toggle off (undo)
      optimisticReaction = null
      if (reactionType === 'up') optimisticLike = Math.max(0, prevLike - 1)
      else optimisticDislike = Math.max(0, prevDislike - 1)
    } else {
      // Switch or add
      optimisticReaction = reactionType
      if (prevReaction === 'up') optimisticLike = Math.max(0, prevLike - 1)
      if (prevReaction === 'down') optimisticDislike = Math.max(0, prevDislike - 1)
      if (reactionType === 'up') optimisticLike++
      else optimisticDislike++
    }

    // Fire optimistic update immediately
    const optimistic = { like_count: optimisticLike, dislike_count: optimisticDislike, reaction: optimisticReaction }
    options?.onSuccess?.(optimistic)

    setLoading(prev => ({ ...prev, [postId]: true }))

    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ reaction_type: reactionType }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        // Reconcile with server truth (counts may differ from optimistic)
        const serverResult = json.data as { like_count: number; dislike_count: number; reaction: 'up' | 'down' | null }
        options?.onSuccess?.(serverResult)
        return serverResult
      } else {
        // Rollback to previous state
        options?.onSuccess?.({ like_count: prevLike, dislike_count: prevDislike, reaction: prevReaction })
        options?.onError?.(json.error || '操作失败')
        return null
      }
    } catch (err) {
      // Rollback on network error
      logger.error('[usePostReaction] Failed:', err)
      options?.onSuccess?.({ like_count: prevLike, dislike_count: prevDislike, reaction: prevReaction })
      options?.onError?.('网络错误')
      return null
    } finally {
      setLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [getAuthHeaders])

  return {
    toggleReaction,
    loading,
    isLoggedIn,
  }
}
