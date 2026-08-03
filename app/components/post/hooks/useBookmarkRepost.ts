'use client'

import { useState, useCallback, useRef } from 'react'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { getViewerScope, isViewerScopeCurrent } from '@/lib/auth/viewer-scope'
import { savePostToBookmarkFolder } from '@/lib/bookmarks/folder-save-client'

interface UseBookmarkRepostOptions {
  accessToken: string | null
  currentUserId: string | null
  showToast: (msg: string, type: string) => void
  t: (key: string) => string
  getPosts: () => Array<{ id: string; author_id: string }>
  getOpenPost: () => { id: string; author_id: string } | null
}
export function useBookmarkRepost({
  accessToken,
  currentUserId,
  showToast,
  t,
  getPosts,
  getOpenPost,
}: UseBookmarkRepostOptions) {
  const [bookmarkLoading, setBookmarkLoading] = useState<Record<string, boolean>>({})
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')
  const [userBookmarks, setUserBookmarks] = useState<Record<string, boolean>>({})
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({})
  const [, setRepostCounts] = useState<Record<string, number>>({})
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [bookmarkingPostId, setBookmarkingPostId] = useState<string | null>(null)
  const folderSaveLockRef = useRef<Set<string>>(new Set())

  const handleBookmark = useCallback(
    async (postId: string) => {
      if (!accessToken) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }
      if (bookmarkLoading[postId]) return

      setBookmarkLoading((prev) => ({ ...prev, [postId]: true }))
      try {
        const response = await fetch(`/api/posts/${postId}/bookmark`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
        })
        const result = await response.json()
        if (response.ok) {
          setUserBookmarks((prev) => ({ ...prev, [postId]: result.bookmarked }))
          setBookmarkCounts((prev) => ({ ...prev, [postId]: result.bookmark_count }))
          showToast(result.bookmarked ? t('bookmarked') : t('unbookmarked'), 'success')
        } else {
          showToast(result.error || t('operationFailed'), 'error')
        }
      } catch (_err) {
        showToast(t('networkError'), 'error')
      } finally {
        setBookmarkLoading((prev) => ({ ...prev, [postId]: false }))
      }
    },
    [accessToken, showToast, t, bookmarkLoading]
  )

  const openBookmarkFolderModal = useCallback(
    (postId: string) => {
      if (!accessToken || !currentUserId) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }
      setBookmarkingPostId(postId)
      setShowBookmarkModal(true)
    },
    [accessToken, currentUserId, showToast, t]
  )

  const handleBookmarkToFolder = useCallback(
    async (folderId: string): Promise<boolean> => {
      if (!accessToken || !currentUserId || !bookmarkingPostId) return false
      const scope = getViewerScope()
      if (scope.userId !== currentUserId || !isViewerScopeCurrent(scope)) return false
      const capturedPostId = bookmarkingPostId
      const lockKey = `${scope.viewerKey}\u0000${scope.sessionGeneration}\u0000${capturedPostId}`
      if (folderSaveLockRef.current.has(lockKey)) return false
      folderSaveLockRef.current.add(lockKey)

      setBookmarkLoading((prev) => ({ ...prev, [capturedPostId]: true }))
      try {
        const result = await savePostToBookmarkFolder({
          accessToken,
          userId: currentUserId,
          postId: capturedPostId,
          folderId,
          sessionGeneration: scope.sessionGeneration,
        })
        if (!isViewerScopeCurrent(scope)) return false
        if (!result.ok && result.stale) return false
        if (result.ok) {
          setUserBookmarks((prev) => ({ ...prev, [capturedPostId]: true }))
          setBookmarkCounts((prev) => ({
            ...prev,
            [capturedPostId]: result.acknowledgement.bookmark_count,
          }))
          showToast(t('bookmarked'), 'success')
          return true
        }
        showToast(
          result.error || t(result.status === 0 ? 'networkError' : 'operationFailed'),
          'error'
        )
      } catch (_error) {
        if (isViewerScopeCurrent(scope)) showToast(t('networkError'), 'error')
      } finally {
        folderSaveLockRef.current.delete(lockKey)
        if (isViewerScopeCurrent(scope)) {
          setBookmarkLoading((prev) => ({ ...prev, [capturedPostId]: false }))
        }
      }
      return false
    },
    [accessToken, bookmarkingPostId, currentUserId, showToast, t]
  )

  const handleRepost = useCallback(
    async (postId: string, comment?: string) => {
      if (!accessToken) {
        showToast(t('pleaseLogin'), 'warning')
        return
      }
      const post = getPosts().find((p) => p.id === postId) || getOpenPost()
      if (post?.author_id === currentUserId) {
        showToast(t('cannotRepostOwn'), 'warning')
        return
      }
      setRepostLoading((prev) => ({ ...prev, [postId]: true }))
      try {
        const response = await fetch(`/api/posts/${postId}/repost`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ comment }),
        })
        const result = await response.json()
        if (response.ok) {
          setShowRepostModal(null)
          setRepostComment('')
          showToast(t('reposted'), 'success')
        } else {
          showToast(result.error || t('repostFailed'), 'error')
        }
      } catch (err) {
        logger.error('[PostFeed] repost failed:', err)
        showToast(t('networkError'), 'error')
      } finally {
        setRepostLoading((prev) => ({ ...prev, [postId]: false }))
      }
    },
    [accessToken, currentUserId, getOpenPost, getPosts, showToast, t]
  )

  // Batch load bookmark status for a list of post IDs
  const loadBookmarkStatus = useCallback(
    async (postIds: string[]) => {
      if (!accessToken || postIds.length === 0) return
      try {
        const res = await fetch('/api/posts/bookmarks/status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ post_ids: postIds }),
        })
        const data = await res.json()
        const bookmarks = data.bookmarks || {}
        setUserBookmarks((prev) => ({ ...prev, ...bookmarks }))
      } catch {
        /* ignore fetch errors */
      }
    },
    [accessToken]
  )

  // Initialize counts from post data
  const initCounts = useCallback(
    (posts: Array<{ id: string; bookmark_count?: number; repost_count?: number }>) => {
      const bc: Record<string, number> = {}
      const rc: Record<string, number> = {}
      for (const post of posts) {
        bc[post.id] = post.bookmark_count || 0
        rc[post.id] = post.repost_count || 0
      }
      setBookmarkCounts((prev) => ({ ...prev, ...bc }))
      setRepostCounts((prev) => ({ ...prev, ...rc }))
    },
    []
  )

  return {
    bookmarkLoading,
    repostLoading,
    showRepostModal,
    setShowRepostModal,
    repostComment,
    setRepostComment,
    userBookmarks,
    setUserBookmarks,
    bookmarkCounts,
    setBookmarkCounts,
    showBookmarkModal,
    setShowBookmarkModal,
    bookmarkingPostId,
    handleBookmark,
    openBookmarkFolderModal,
    handleBookmarkToFolder,
    handleRepost,
    loadBookmarkStatus,
    initCounts,
  }
}
