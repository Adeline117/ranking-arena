'use client'

import { useState, useCallback } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePostStore } from '@/lib/stores/postStore'

export type Comment = {
  id: string
  content: string
  user_id?: string
  author_handle?: string
  author_avatar_url?: string
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

  const loadComments = useCallback(async (postId: string) => {
    try {
      setLoadingComments(true)
      const headers: Record<string, string> = {}
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }
      const response = await fetch(`/api/posts/${postId}/comments`, { headers })
      const json = await response.json()

      if (response.ok && json.success) {
        setComments(json.data?.comments || [])
      } else {
        setComments([])
      }
    } catch (_err) {
      setComments([])
    } finally {
      setLoadingComments(false)
    }
  }, [accessToken])

  const submitComment = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    if (!newComment.trim()) return

    setSubmittingComment(true)
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ content: newComment.trim() }),
      })

      if (!response.ok) {
        if (response.status === 401) {
          showToast('登录已过期，请重新登录', 'error')
        } else if (response.status === 403) {
          showToast('权限不足', 'error')
        } else if (response.status >= 500) {
          showToast('服务异常，请稍后重试', 'error')
        } else {
          const json = await response.json().catch(() => null)
          showToast(json?.error || '发表评论失败', 'error')
        }
        return
      }

      const json = await response.json()

      if (json.success && json.data?.comment) {
        setComments(prev => [...prev, json.data.comment])
        setNewComment('')
        usePostStore.getState().addComment(postId, json.data.comment)
        onCommentCountChange?.(postId, 1)
      } else {
        showToast(json.error || '发表评论失败', 'error')
      }
    } catch (_err) {
      showToast('网络异常，请重试', 'error')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, showToast, onCommentCountChange])

  const toggleCommentLike = useCallback(async (postId: string, commentId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    if (commentLikeLoading[commentId]) return
    setCommentLikeLoading(prev => ({ ...prev, [commentId]: true }))

    try {
      const response = await fetch(`/api/posts/${postId}/comments/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ comment_id: commentId }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        const updateCommentLike = (comment: Comment): Comment => {
          if (comment.id === commentId) {
            return {
              ...comment,
              like_count: json.data.like_count,
              user_liked: json.data.liked,
            }
          }
          if (comment.replies) {
            return {
              ...comment,
              replies: comment.replies.map(updateCommentLike),
            }
          }
          return comment
        }
        setComments(prev => prev.map(updateCommentLike))
      } else {
        if (response.status === 429) {
          showToast('操作太快，稍等一下', 'warning')
        } else if (response.status === 401) {
          showToast('登录已过期', 'warning')
        } else {
          showToast(json.error || '点赞失败', 'error')
        }
      }
    } catch (_err) {
      showToast('网络错误', 'error')
    } finally {
      setCommentLikeLoading(prev => ({ ...prev, [commentId]: false }))
    }
  }, [accessToken, commentLikeLoading, showToast])

  const submitReply = useCallback(async (postId: string, parentId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    if (!replyContent.trim()) return

    setSubmittingReply(true)
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ content: replyContent.trim(), parent_id: parentId }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        const newReply = json.data.comment
        setComments(prev => prev.map(c => {
          if (c.id === parentId) {
            return { ...c, replies: [...(c.replies || []), newReply] }
          }
          return c
        }))
        setReplyContent('')
        setReplyingTo(null)
        setExpandedReplies(prev => ({ ...prev, [parentId]: true }))
        onCommentCountChange?.(postId, 1)
        showToast('已回复', 'success')
      } else {
        showToast(json.error || '回复失败', 'error')
      }
    } catch (err) {
      console.error('[usePostComments] reply error:', err)
      showToast('回复失败', 'error')
    } finally {
      setSubmittingReply(false)
    }
  }, [accessToken, replyContent, showToast, onCommentCountChange])

  const deleteComment = useCallback(async (postId: string, commentId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    const confirmed = await showDangerConfirm('删除评论', '确定要删除这条评论吗？')
    if (!confirmed) return

    setDeletingCommentId(commentId)
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ comment_id: commentId }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        setComments(prev => prev.map(c => {
          if (c.id === commentId) return null
          if (c.replies && c.replies.length > 0) {
            return { ...c, replies: c.replies.filter(r => r.id !== commentId) }
          }
          return c
        }).filter(Boolean) as Comment[])
        onCommentCountChange?.(postId, -1)
        showToast('已删除', 'success')
      } else {
        showToast(json.error || '删除评论失败', 'error')
      }
    } catch (_err) {
      showToast('删除评论失败', 'error')
    } finally {
      setDeletingCommentId(null)
    }
  }, [accessToken, showDangerConfirm, showToast, onCommentCountChange])

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
