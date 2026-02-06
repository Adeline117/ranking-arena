/**
 * usePostActions Hook
 *
 * Manages post actions like upvote, downvote, bookmark, and repost.
 * Extracted from PostFeed.tsx to improve maintainability.
 */

import { useState, useCallback, useRef } from 'react'
import type { PostWithUserState } from '@/lib/types'
import { getCsrfHeaders } from '@/lib/api/client'

type Post = PostWithUserState

export interface UsePostActionsOptions {
  accessToken: string | null
  onToast?: (message: string, type?: 'success' | 'error' | 'warning') => void
  onPostUpdate?: (postId: string, updates: Partial<Post>) => void
}

export interface UsePostActionsReturn {
  // Upvote/Downvote
  handleUpvote: (postId: string) => Promise<void>
  handleDownvote: (postId: string) => Promise<void>

  // Bookmark
  userBookmarks: Record<string, boolean>
  bookmarkCounts: Record<string, number>
  handleBookmark: (postId: string) => Promise<void>
  fetchBookmarkStatus: (postIds: string[]) => Promise<void>

  // Repost
  repostLoading: Record<string, boolean>
  handleRepost: (postId: string, comment?: string) => Promise<void>
}

export function usePostActions(options: UsePostActionsOptions): UsePostActionsReturn {
  const { accessToken, onToast, onPostUpdate } = options

  // Lock for preventing concurrent actions on same post
  const lockRef = useRef<Set<string>>(new Set())

  // Bookmark state
  const [userBookmarks, setUserBookmarks] = useState<Record<string, boolean>>({})
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({})

  // Repost state
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})

  // Handle upvote
  const handleUpvote = useCallback(async (postId: string) => {
    if (!accessToken) {
      onToast?.('Please login to vote', 'warning')
      return
    }

    // Check lock
    if (lockRef.current.has(postId)) {
      return
    }

    // Acquire lock
    lockRef.current.add(postId)

    try {
      const response = await fetch(`/api/posts/${postId}/vote`, {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ vote_type: 'up' }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to upvote')
      }

      const data = await response.json()

      // Update post with new counts
      if (onPostUpdate) {
        onPostUpdate(postId, {
          up_count: data.up_count,
          down_count: data.down_count,
          user_vote_type: data.user_vote_type,
        })
      }
    } catch (err: any) {
      onToast?.(err.message || 'Failed to upvote', 'error')
    } finally {
      // Release lock
      lockRef.current.delete(postId)
    }
  }, [accessToken, onToast, onPostUpdate])

  // Handle downvote
  const handleDownvote = useCallback(async (postId: string) => {
    if (!accessToken) {
      onToast?.('Please login to vote', 'warning')
      return
    }

    // Check lock
    if (lockRef.current.has(postId)) {
      return
    }

    // Acquire lock
    lockRef.current.add(postId)

    try {
      const response = await fetch(`/api/posts/${postId}/vote`, {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ vote_type: 'down' }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to downvote')
      }

      const data = await response.json()

      // Update post with new counts
      if (onPostUpdate) {
        onPostUpdate(postId, {
          up_count: data.up_count,
          down_count: data.down_count,
          user_vote_type: data.user_vote_type,
        })
      }
    } catch (err: any) {
      onToast?.(err.message || 'Failed to downvote', 'error')
    } finally {
      // Release lock
      lockRef.current.delete(postId)
    }
  }, [accessToken, onToast, onPostUpdate])

  // Fetch bookmark status for multiple posts
  const fetchBookmarkStatus = useCallback(async (postIds: string[]) => {
    if (!accessToken || postIds.length === 0) return

    try {
      const response = await fetch('/api/bookmarks/batch', {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ post_ids: postIds }),
      })

      if (!response.ok) {
        throw new Error('Failed to fetch bookmark status')
      }

      const data = await response.json()

      // Update bookmark state
      const bookmarkMap: Record<string, boolean> = {}
      const countMap: Record<string, number> = {}

      data.bookmarks?.forEach((bookmark: any) => {
        bookmarkMap[bookmark.post_id] = bookmark.is_bookmarked
        countMap[bookmark.post_id] = bookmark.bookmark_count || 0
      })

      setUserBookmarks(prev => ({ ...prev, ...bookmarkMap }))
      setBookmarkCounts(prev => ({ ...prev, ...countMap }))
    } catch (err: any) {
      // Silent fail for bookmark status fetch
      console.error('Failed to fetch bookmark status:', err)
    }
  }, [accessToken])

  // Handle bookmark toggle
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) {
      onToast?.('Please login to bookmark', 'warning')
      return
    }

    const isCurrentlyBookmarked = userBookmarks[postId] || false

    // Optimistic update
    setUserBookmarks(prev => ({ ...prev, [postId]: !isCurrentlyBookmarked }))
    setBookmarkCounts(prev => ({
      ...prev,
      [postId]: (prev[postId] || 0) + (isCurrentlyBookmarked ? -1 : 1),
    }))

    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, {
        method: isCurrentlyBookmarked ? 'DELETE' : 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to bookmark')
      }

      const data = await response.json()

      // Update with server response
      setUserBookmarks(prev => ({ ...prev, [postId]: data.is_bookmarked }))
      setBookmarkCounts(prev => ({ ...prev, [postId]: data.bookmark_count || 0 }))

      onToast?.(
        isCurrentlyBookmarked ? 'Bookmark removed' : 'Bookmarked successfully',
        'success'
      )
    } catch (err: any) {
      // Revert optimistic update
      setUserBookmarks(prev => ({ ...prev, [postId]: isCurrentlyBookmarked }))
      setBookmarkCounts(prev => ({
        ...prev,
        [postId]: (prev[postId] || 0) + (isCurrentlyBookmarked ? 1 : -1),
      }))
      onToast?.(err.message || 'Failed to bookmark', 'error')
    }
  }, [accessToken, userBookmarks, onToast])

  // Handle repost
  const handleRepost = useCallback(async (postId: string, comment?: string) => {
    if (!accessToken) {
      onToast?.('Please login to repost', 'warning')
      return
    }

    setRepostLoading(prev => ({ ...prev, [postId]: true }))

    try {
      const response = await fetch(`/api/posts/${postId}/repost`, {
        method: 'POST',
        headers: {
          ...await getCsrfHeaders(),
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ comment: comment || '' }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to repost')
      }

      onToast?.('Reposted successfully', 'success')
    } catch (err: any) {
      onToast?.(err.message || 'Failed to repost', 'error')
    } finally {
      setRepostLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, onToast])

  return {
    handleUpvote,
    handleDownvote,
    userBookmarks,
    bookmarkCounts,
    handleBookmark,
    fetchBookmarkStatus,
    repostLoading,
    handleRepost,
  }
}
