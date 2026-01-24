'use client'

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getCsrfHeaders } from '@/lib/api/client'
import { usePostStore } from '@/lib/stores/postStore'

interface UsePostActionsOptions {
  accessToken: string | null
  currentUserId: string | null
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
}

export function usePostActions({
  accessToken,
  currentUserId,
  showToast,
  showDangerConfirm,
}: UsePostActionsOptions) {
  const router = useRouter()
  // Per-postId lock: awaits API response before allowing next action
  const lockRef = useRef<Set<string>>(new Set())

  // Bookmark state
  const [userBookmarks, setUserBookmarks] = useState<Record<string, boolean>>({})
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({})
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [bookmarkingPostId, setBookmarkingPostId] = useState<string | null>(null)

  // Repost state
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')

  const acquireLock = useCallback((key: string): boolean => {
    if (lockRef.current.has(key)) return false
    lockRef.current.add(key)
    return true
  }, [])

  const releaseLock = useCallback((key: string) => {
    lockRef.current.delete(key)
  }, [])

  // Like/Dislike with per-post lock
  const toggleReaction = useCallback(async (
    postId: string,
    reactionType: 'up' | 'down',
    onUpdate?: (data: { like_count: number; dislike_count: number; reaction: string | null }) => void
  ) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    const key = `react-${postId}-${reactionType}`
    if (!acquireLock(key)) return

    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ reaction_type: reactionType }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        const result = json.data
        usePostStore.getState().updatePostReaction(postId, {
          like_count: result.like_count,
          dislike_count: result.dislike_count,
          reaction: result.reaction,
        })
        onUpdate?.(result)
      } else {
        showToast(json.error || json.message || '操作失败', 'error')
      }
    } catch (err) {
      console.error('[usePostActions] toggleReaction error:', err)
      showToast('网络错误，请重试', 'error')
    } finally {
      releaseLock(key)
    }
  }, [accessToken, showToast, acquireLock, releaseLock])

  // Bookmark
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    const key = `bookmark-${postId}`
    if (!acquireLock(key)) return

    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
      })

      const result = await response.json()

      if (response.ok) {
        setUserBookmarks(prev => ({ ...prev, [postId]: result.bookmarked }))
        setBookmarkCounts(prev => ({ ...prev, [postId]: result.bookmark_count }))
        showToast(result.bookmarked ? '已收藏' : '已取消收藏', 'success')
      } else {
        showToast(result.error || '操作失败', 'error')
      }
    } catch (_err) {
      showToast('网络错误', 'error')
    } finally {
      releaseLock(key)
    }
  }, [accessToken, showToast, acquireLock, releaseLock])

  // Open bookmark folder modal
  const openBookmarkFolderModal = useCallback((postId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }
    setBookmarkingPostId(postId)
    setShowBookmarkModal(true)
  }, [accessToken, showToast])

  // Bookmark to specific folder
  const handleBookmarkToFolder = useCallback(async (folderId: string) => {
    if (!accessToken || !bookmarkingPostId) return

    const key = `bookmark-folder-${bookmarkingPostId}`
    if (!acquireLock(key)) return

    try {
      const response = await fetch(`/api/posts/${bookmarkingPostId}/bookmark`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ folder_id: folderId }),
      })

      const result = await response.json()

      if (response.ok) {
        setUserBookmarks(prev => ({ ...prev, [bookmarkingPostId]: result.bookmarked }))
        setBookmarkCounts(prev => ({ ...prev, [bookmarkingPostId]: result.bookmark_count }))
        showToast('已收藏', 'success')
      } else {
        showToast(result.error || '操作失败', 'error')
      }
    } catch (_err) {
      showToast('网络错误', 'error')
    } finally {
      releaseLock(key)
      setShowBookmarkModal(false)
      setBookmarkingPostId(null)
    }
  }, [accessToken, bookmarkingPostId, showToast, acquireLock, releaseLock])

  // Repost
  const handleRepost = useCallback(async (
    postId: string,
    authorId: string | undefined,
    comment?: string
  ) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    if (authorId === currentUserId) {
      showToast('不能转发自己的帖子', 'warning')
      return
    }

    setRepostLoading(prev => ({ ...prev, [postId]: true }))

    try {
      const response = await fetch(`/api/posts/${postId}/repost`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ comment }),
      })

      const result = await response.json()

      if (response.ok) {
        setShowRepostModal(null)
        setRepostComment('')
        showToast('已转发', 'success')
      } else {
        showToast(result.error || '转发失败', 'error')
      }
    } catch (err) {
      console.error('[usePostActions] repost error:', err)
      showToast('网络错误', 'error')
    } finally {
      setRepostLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, currentUserId, showToast])

  // Delete post
  const handleDeletePost = useCallback(async (postId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return false
    }

    const confirmed = await showDangerConfirm('删除帖子', '确定要删除这篇帖子吗？此操作不可撤销。')
    if (!confirmed) return false

    try {
      const response = await fetch(`/api/posts/${postId}/delete`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })

      const json = await response.json()

      if (response.ok && json.success) {
        showToast('已删除', 'success')
        return true
      } else {
        showToast(json.error || '删除失败', 'error')
        return false
      }
    } catch (err) {
      console.error('[usePostActions] delete error:', err)
      showToast('删除失败', 'error')
      return false
    }
  }, [accessToken, showDangerConfirm, showToast])

  // Toggle pin
  const handleTogglePin = useCallback(async (postId: string, currentPinned: boolean, groupId?: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return null
    }

    try {
      const response = await fetch(`/api/posts/${postId}/pin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ pinned: !currentPinned, group_id: groupId }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        showToast(!currentPinned ? '已置顶' : '已取消置顶', 'success')
        return !currentPinned
      } else {
        showToast(json.error || '操作失败', 'error')
        return null
      }
    } catch (err) {
      console.error('[usePostActions] pin error:', err)
      showToast('操作失败', 'error')
      return null
    }
  }, [accessToken, showToast])

  // Start editing (navigate to edit page)
  const handleStartEdit = useCallback((postId: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    router.push(`/post/${postId}/edit`)
  }, [router])

  return {
    // Bookmark state
    userBookmarks,
    setUserBookmarks,
    bookmarkCounts,
    setBookmarkCounts,
    showBookmarkModal,
    setShowBookmarkModal,
    bookmarkingPostId,
    // Repost state
    repostLoading,
    showRepostModal,
    setShowRepostModal,
    repostComment,
    setRepostComment,
    // Actions
    toggleReaction,
    handleBookmark,
    openBookmarkFolderModal,
    handleBookmarkToFolder,
    handleRepost,
    handleDeletePost,
    handleTogglePin,
    handleStartEdit,
  }
}
