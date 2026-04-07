'use client'

import { useState, useCallback, useRef } from 'react'
import { authedFetch, getHttpErrorMessage } from '@/lib/api/client'
import { usePostStore, type CommentData } from '@/lib/stores/postStore'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

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
  like_count?: number
  dislike_count?: number
  user_liked?: boolean
  user_disliked?: boolean
  replies?: Comment[]
}

interface UsePostCommentsOptions {
  accessToken: string | null
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
  onCommentCountChange?: (postId: string, delta: number) => void
  t?: (key: string) => string
}

// Convert Comment to CommentData for store compatibility
function toCommentData(comment: Comment): CommentData {
  return {
    id: comment.id,
    content: comment.content,
    user_id: comment.user_id,
    author_handle: comment.author_handle || 'user',
    author_avatar_url: comment.author_avatar_url,
    created_at: comment.created_at,
    like_count: comment.like_count,
    user_liked: comment.user_liked,
    replies: comment.replies?.map(toCommentData),
  }
}

export function usePostComments({
  accessToken,
  showToast,
  showDangerConfirm,
  onCommentCountChange,
  t: externalT,
}: UsePostCommentsOptions) {
  const { t: hookT } = useLanguage()
  const t = externalT || hookT
  const [comments, setComments] = useState<Comment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [replyingTo, setReplyingTo] = useState<{ commentId: string; handle: string } | null>(null)
  const [replyContent, setReplyContent] = useState('')
  const [submittingReply, setSubmittingReply] = useState(false)
  const [commentLikeLoading, setCommentLikeLoading] = useState<Record<string, boolean>>({})
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const [editingComment, setEditingComment] = useState<{ id: string; content: string } | null>(null)
  const [editContent, setEditContent] = useState('')
  const [submittingEdit, setSubmittingEdit] = useState(false)

  // Ref-based guards to prevent double submissions
  const submittingCommentRef = useRef(false)
  const submittingReplyRef = useRef(false)

  // Auth guard helper
  const requireAuth = useCallback((): boolean => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return false
    }
    return true
  }, [accessToken, showToast, t])

  const loadComments = useCallback(async (postId: string, sort: 'best' | 'time' = 'best'): Promise<void> => {
    setLoadingComments(true)
    try {
      const { ok, data } = await authedFetch<{ success: boolean; data?: { comments: Comment[] } }>(
        `/api/posts/${postId}/comments?sort=${sort}`,
        'GET',
        accessToken
      )
      const loaded = ok && data?.success ? data.data?.comments || [] : []
      setComments(loaded)
      // Sync with postStore as single source of truth
      usePostStore.getState().setComments(postId, loaded.map(toCommentData))
    } catch {
      // Don't clear existing comments on refresh failure — preserve what users already see
    } finally {
      setLoadingComments(false)
    }
  }, [accessToken])

  const submitComment = useCallback(async (postId: string): Promise<void> => {
    if (!requireAuth() || !newComment.trim()) return
    if (submittingCommentRef.current) return // Prevent double submission

    submittingCommentRef.current = true
    setSubmittingComment(true)

    // Optimistic: show comment immediately with temp ID
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticComment: Comment = {
      id: tempId,
      content: newComment.trim(),
      created_at: new Date().toISOString(),
    }
    setComments(prev => [...prev, optimisticComment])
    const savedContent = newComment.trim()
    setNewComment('')
    onCommentCountChange?.(postId, 1)

    try {
      const { ok, status, data } = await authedFetch<{ success: boolean; error?: string; data?: { comment: Comment } }>(
        `/api/posts/${postId}/comments`,
        'POST',
        accessToken,
        { content: savedContent }
      )

      if (!ok) {
        // Rollback optimistic comment
        setComments(prev => prev.filter(c => c.id !== tempId))
        setNewComment(savedContent)
        onCommentCountChange?.(postId, -1)
        showToast(getHttpErrorMessage(status, data?.error || t('commentFailedRetry')), 'error')
        return
      }

      if (data?.success && data.data?.comment) {
        // Replace optimistic comment with server response
        const serverComment = data.data.comment
        setComments(prev => prev.map(c => c.id === tempId ? serverComment : c))
        usePostStore.getState().addComment(postId, toCommentData(serverComment))
      } else {
        // Rollback optimistic comment
        setComments(prev => prev.filter(c => c.id !== tempId))
        setNewComment(savedContent)
        onCommentCountChange?.(postId, -1)
        showToast(data?.error || t('commentFailedRetry'), 'error')
      }
    } catch {
      // Rollback optimistic comment
      setComments(prev => prev.filter(c => c.id !== tempId))
      setNewComment(savedContent)
      onCommentCountChange?.(postId, -1)
      showToast(t('networkError'), 'error')
    } finally {
      submittingCommentRef.current = false
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, requireAuth, showToast, onCommentCountChange, t])

  const toggleCommentLike = useCallback(async (postId: string, commentId: string): Promise<void> => {
    if (!requireAuth() || commentLikeLoading[commentId]) return

    setCommentLikeLoading(prev => ({ ...prev, [commentId]: true }))

    // Optimistic update: toggle like immediately
    const updateOptimistic = (comment: Comment): Comment => {
      if (comment.id === commentId) {
        const wasLiked = comment.user_liked
        return {
          ...comment,
          user_liked: !wasLiked,
          like_count: (comment.like_count || 0) + (wasLiked ? -1 : 1),
          // If switching from dislike to like, clear dislike
          ...(comment.user_disliked && !wasLiked ? { user_disliked: false, dislike_count: Math.max(0, (comment.dislike_count || 0) - 1) } : {}),
        }
      }
      if (comment.replies) return { ...comment, replies: comment.replies.map(updateOptimistic) }
      return comment
    }
    setComments(prev => prev.map(updateOptimistic))

    try {
      const { ok, status, data } = await authedFetch<{ success: boolean; error?: string; data?: { like_count: number; liked: boolean } }>(
        `/api/posts/${postId}/comments/like`,
        'POST',
        accessToken,
        { comment_id: commentId }
      )

      if (ok && data?.success) {
        // Reconcile with server counts
        const d = data.data!
        const reconcile = (comment: Comment): Comment => {
          if (comment.id === commentId) {
            return {
              ...comment,
              like_count: d.like_count,
              user_liked: d.liked,
              ...('dislike_count' in d ? { dislike_count: (d as Record<string, unknown>).dislike_count as number, user_disliked: (d as Record<string, unknown>).disliked as boolean } : {}),
            }
          }
          if (comment.replies) return { ...comment, replies: comment.replies.map(reconcile) }
          return comment
        }
        setComments(prev => prev.map(reconcile))
      } else {
        // Rollback: re-fetch to get correct state
        showToast(getHttpErrorMessage(status, data?.error || t('operationFailed')), status === 429 ? 'warning' : 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setCommentLikeLoading(prev => ({ ...prev, [commentId]: false }))
    }
  }, [accessToken, commentLikeLoading, requireAuth, showToast, t])

  const toggleCommentDislike = useCallback(async (postId: string, commentId: string): Promise<void> => {
    if (!requireAuth() || commentLikeLoading[commentId]) return

    setCommentLikeLoading(prev => ({ ...prev, [commentId]: true }))

    // Optimistic update: toggle dislike immediately
    const updateOptimistic = (comment: Comment): Comment => {
      if (comment.id === commentId) {
        const wasDisliked = comment.user_disliked
        return {
          ...comment,
          user_disliked: !wasDisliked,
          dislike_count: (comment.dislike_count || 0) + (wasDisliked ? -1 : 1),
          // If switching from like to dislike, clear like
          ...(comment.user_liked && !wasDisliked ? { user_liked: false, like_count: Math.max(0, (comment.like_count || 0) - 1) } : {}),
        }
      }
      if (comment.replies) return { ...comment, replies: comment.replies.map(updateOptimistic) }
      return comment
    }
    setComments(prev => prev.map(updateOptimistic))

    try {
      const { ok, status, data } = await authedFetch<{ success: boolean; error?: string; data?: { dislike_count: number; disliked: boolean; like_count: number; liked: boolean } }>(
        `/api/posts/${postId}/comments/like`,
        'POST',
        accessToken,
        { comment_id: commentId, type: 'dislike' }
      )

      if (ok && data?.success) {
        // Reconcile with server counts
        const reconcile = (comment: Comment): Comment => {
          if (comment.id === commentId) {
            return {
              ...comment,
              dislike_count: data.data!.dislike_count,
              user_disliked: data.data!.disliked,
              like_count: data.data!.like_count,
              user_liked: data.data!.liked,
            }
          }
          if (comment.replies) return { ...comment, replies: comment.replies.map(reconcile) }
          return comment
        }
        setComments(prev => prev.map(reconcile))
      } else {
        showToast(getHttpErrorMessage(status, data?.error || t('operationFailed')), status === 429 ? 'warning' : 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setCommentLikeLoading(prev => ({ ...prev, [commentId]: false }))
    }
  }, [accessToken, commentLikeLoading, requireAuth, showToast, t])

  const submitReply = useCallback(async (postId: string, parentId: string): Promise<void> => {
    if (!requireAuth() || !replyContent.trim()) return
    if (submittingReplyRef.current) return // Prevent double submission

    submittingReplyRef.current = true
    setSubmittingReply(true)

    // Optimistic: show reply immediately
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const optimisticReply: Comment = {
      id: tempId,
      content: replyContent.trim(),
      created_at: new Date().toISOString(),
    }
    const savedContent = replyContent.trim()
    setComments(prev => prev.map(c =>
      c.id === parentId ? { ...c, replies: [...(c.replies || []), optimisticReply] } : c
    ))
    setReplyContent('')
    setReplyingTo(null)
    setExpandedReplies(prev => ({ ...prev, [parentId]: true }))
    onCommentCountChange?.(postId, 1)

    try {
      const { ok, data } = await authedFetch<{ success: boolean; error?: string; data?: { comment: Comment } }>(
        `/api/posts/${postId}/comments`,
        'POST',
        accessToken,
        { content: savedContent, parent_id: parentId }
      )

      if (ok && data?.success && data.data?.comment) {
        // Replace optimistic reply with server response
        const serverReply = data.data.comment
        setComments(prev => prev.map(c =>
          c.id === parentId
            ? { ...c, replies: (c.replies || []).map(r => r.id === tempId ? serverReply : r) }
            : c
        ))
        showToast(t('replied'), 'success')
      } else {
        // Rollback optimistic reply
        setComments(prev => prev.map(c =>
          c.id === parentId
            ? { ...c, replies: (c.replies || []).filter(r => r.id !== tempId) }
            : c
        ))
        onCommentCountChange?.(postId, -1)
        showToast(data?.error || t('operationFailed'), 'error')
      }
    } catch {
      // Rollback optimistic reply
      setComments(prev => prev.map(c =>
        c.id === parentId
          ? { ...c, replies: (c.replies || []).filter(r => r.id !== tempId) }
          : c
      ))
      onCommentCountChange?.(postId, -1)
      showToast(t('operationFailed'), 'error')
    } finally {
      submittingReplyRef.current = false
      setSubmittingReply(false)
    }
  }, [accessToken, replyContent, requireAuth, showToast, onCommentCountChange, t])

  const startEditComment = useCallback((comment: Comment) => {
    setEditingComment({ id: comment.id, content: comment.content })
    setEditContent(comment.content)
  }, [])

  const cancelEditComment = useCallback(() => {
    setEditingComment(null)
    setEditContent('')
  }, [])

  const submitEditComment = useCallback(async (postId: string): Promise<void> => {
    if (!editingComment || !editContent.trim() || !requireAuth()) return

    setSubmittingEdit(true)
    try {
      const { ok, data } = await authedFetch<{ success: boolean; error?: string; data?: { comment: Comment } }>(
        `/api/posts/${postId}/comments`,
        'PUT',
        accessToken,
        { comment_id: editingComment.id, content: editContent.trim() }
      )

      if (ok && data?.success) {
        const updateInList = (c: Comment): Comment => {
          if (c.id === editingComment.id) {
            return { ...c, content: editContent.trim() }
          }
          if (c.replies) {
            return { ...c, replies: c.replies.map(updateInList) }
          }
          return c
        }
        setComments(prev => prev.map(updateInList))
        setEditingComment(null)
        setEditContent('')
        showToast(t('saved'), 'success')
      } else {
        showToast(data?.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setSubmittingEdit(false)
    }
  }, [accessToken, editingComment, editContent, requireAuth, showToast, t])

  const deleteComment = useCallback(async (postId: string, commentId: string): Promise<void> => {
    if (!requireAuth()) return

    const confirmed = await showDangerConfirm(t('deleteComment'), t('confirmDeleteComment'))
    if (!confirmed) return

    setDeletingCommentId(commentId)
    try {
      const { ok, data } = await authedFetch<{ success: boolean; error?: string }>(
        `/api/posts/${postId}/comments`,
        'DELETE',
        accessToken,
        { comment_id: commentId }
      )

      if (ok && data?.success) {
        setComments(prev => prev
          .map(c => {
            if (c.id === commentId) return null
            if (c.replies?.length) {
              return { ...c, replies: c.replies.filter(r => r.id !== commentId) }
            }
            return c
          })
          .filter((c): c is Comment => c !== null)
        )
        onCommentCountChange?.(postId, -1)
        showToast(t('deleted'), 'success')
      } else {
        showToast(data?.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('operationFailed'), 'error')
    } finally {
      setDeletingCommentId(null)
    }
  }, [accessToken, requireAuth, showDangerConfirm, showToast, onCommentCountChange, t])

  return {
    comments,
    setComments,
    loadingComments,
    newComment,
    setNewComment,
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
