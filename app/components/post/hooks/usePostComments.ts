'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePostStore, type CommentData } from '@/lib/stores/postStore'

export type Comment = {
  id: string
  content: string
  user_id?: string
  author_handle?: string
  author_avatar_url?: string
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  created_at: string
  like_count?: number
  user_liked?: boolean
  replies?: Comment[]
}

interface UsePostCommentsOptions {
  accessToken: string | null
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
  onCommentCountChange?: (postId: string, delta: number) => void
}

type HttpMethod = 'GET' | 'POST' | 'DELETE'

// Helper to build auth headers
function buildAuthHeaders(accessToken: string | null): Record<string, string> {
  if (!accessToken) return {}
  return { Authorization: `Bearer ${accessToken}` }
}

// Helper for authenticated API calls with consistent error handling
async function apiRequest<T>(
  url: string,
  method: HttpMethod,
  accessToken: string | null,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: T | null }> {
  const headers: Record<string, string> = {
    ...buildAuthHeaders(accessToken),
  }

  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    Object.assign(headers, getCsrfHeaders())
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, data }
}

// Map HTTP status to user-friendly error messages
function getErrorMessage(status: number, fallback: string): string {
  if (status === 401) return '登录已过期，请重新登录'
  if (status === 403) return '权限不足'
  if (status === 429) return '操作太快，稍等一下'
  if (status >= 500) return '服务异常，请稍后重试'
  return fallback
}

// Convert Comment to CommentData for store compatibility
function toCommentData(comment: Comment): CommentData {
  return {
    id: comment.id,
    content: comment.content,
    user_id: comment.user_id,
    author_handle: comment.author_handle || '匿名',
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
}: UsePostCommentsOptions) {
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

  // Auth guard helper
  const requireAuth = useCallback((): boolean => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return false
    }
    return true
  }, [accessToken, showToast])

  const loadComments = useCallback(async (postId: string): Promise<void> => {
    setLoadingComments(true)
    try {
      const { ok, data } = await apiRequest<{ success: boolean; data?: { comments: Comment[] } }>(
        `/api/posts/${postId}/comments`,
        'GET',
        accessToken
      )
      setComments(ok && data?.success ? data.data?.comments || [] : [])
    } catch {
      setComments([])
    } finally {
      setLoadingComments(false)
    }
  }, [accessToken])

  const submitComment = useCallback(async (postId: string): Promise<void> => {
    if (!requireAuth() || !newComment.trim()) return

    setSubmittingComment(true)
    try {
      const { ok, status, data } = await apiRequest<{ success: boolean; error?: string; data?: { comment: Comment } }>(
        `/api/posts/${postId}/comments`,
        'POST',
        accessToken,
        { content: newComment.trim() }
      )

      if (!ok) {
        showToast(getErrorMessage(status, data?.error || '发表评论失败'), 'error')
        return
      }

      if (data?.success && data.data?.comment) {
        const newComment = data.data.comment
        setComments(prev => [...prev, newComment])
        setNewComment('')
        usePostStore.getState().addComment(postId, toCommentData(newComment))
        onCommentCountChange?.(postId, 1)
      } else {
        showToast(data?.error || '发表评论失败', 'error')
      }
    } catch {
      showToast('网络异常，请重试', 'error')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, requireAuth, showToast, onCommentCountChange])

  const toggleCommentLike = useCallback(async (postId: string, commentId: string): Promise<void> => {
    if (!requireAuth() || commentLikeLoading[commentId]) return

    setCommentLikeLoading(prev => ({ ...prev, [commentId]: true }))
    try {
      const { ok, status, data } = await apiRequest<{ success: boolean; error?: string; data?: { like_count: number; liked: boolean } }>(
        `/api/posts/${postId}/comments/like`,
        'POST',
        accessToken,
        { comment_id: commentId }
      )

      if (ok && data?.success) {
        const updateCommentLike = (comment: Comment): Comment => {
          if (comment.id === commentId) {
            return { ...comment, like_count: data.data!.like_count, user_liked: data.data!.liked }
          }
          if (comment.replies) {
            return { ...comment, replies: comment.replies.map(updateCommentLike) }
          }
          return comment
        }
        setComments(prev => prev.map(updateCommentLike))
      } else {
        showToast(getErrorMessage(status, data?.error || '点赞失败'), status === 429 ? 'warning' : 'error')
      }
    } catch {
      showToast('网络错误', 'error')
    } finally {
      setCommentLikeLoading(prev => ({ ...prev, [commentId]: false }))
    }
  }, [accessToken, commentLikeLoading, requireAuth, showToast])

  const submitReply = useCallback(async (postId: string, parentId: string): Promise<void> => {
    if (!requireAuth() || !replyContent.trim()) return

    setSubmittingReply(true)
    try {
      const { ok, data } = await apiRequest<{ success: boolean; error?: string; data?: { comment: Comment } }>(
        `/api/posts/${postId}/comments`,
        'POST',
        accessToken,
        { content: replyContent.trim(), parent_id: parentId }
      )

      if (ok && data?.success && data.data?.comment) {
        const newReply = data.data.comment
        setComments(prev => prev.map(c =>
          c.id === parentId ? { ...c, replies: [...(c.replies || []), newReply] } : c
        ))
        setReplyContent('')
        setReplyingTo(null)
        setExpandedReplies(prev => ({ ...prev, [parentId]: true }))
        onCommentCountChange?.(postId, 1)
        showToast('已回复', 'success')
      } else {
        showToast(data?.error || '回复失败', 'error')
      }
    } catch {
      showToast('回复失败', 'error')
    } finally {
      setSubmittingReply(false)
    }
  }, [accessToken, replyContent, requireAuth, showToast, onCommentCountChange])

  const deleteComment = useCallback(async (postId: string, commentId: string): Promise<void> => {
    if (!requireAuth()) return

    const confirmed = await showDangerConfirm('删除评论', '确定要删除这条评论吗？')
    if (!confirmed) return

    setDeletingCommentId(commentId)
    try {
      const { ok, data } = await apiRequest<{ success: boolean; error?: string }>(
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
        showToast('已删除', 'success')
      } else {
        showToast(data?.error || '删除评论失败', 'error')
      }
    } catch {
      showToast('删除评论失败', 'error')
    } finally {
      setDeletingCommentId(null)
    }
  }, [accessToken, requireAuth, showDangerConfirm, showToast, onCommentCountChange])

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
    loadComments,
    submitComment,
    toggleCommentLike,
    submitReply,
    deleteComment,
  }
}
