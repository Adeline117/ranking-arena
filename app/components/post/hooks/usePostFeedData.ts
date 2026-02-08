/**
 * usePostFeedData Hook
 *
 * Manages post feed data fetching, pagination, and refresh logic.
 * Extracted from PostFeed.tsx to improve maintainability.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { PostWithUserState } from '@/lib/types'
import { getCsrfHeaders } from '@/lib/api/client'

type Post = PostWithUserState

export interface UsePostFeedDataOptions {
  pageSize?: number
  groupId?: string
  groupIds?: string[]
  authorHandle?: string
  sortBy?: string
  onError?: (error: string) => void
  onSuccess?: (posts: Post[]) => void
}

export interface UsePostFeedDataReturn {
  posts: Post[]
  setPosts: React.Dispatch<React.SetStateAction<Post[]>>
  loading: boolean
  refreshing: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  offset: number
  loadPosts: () => Promise<void>
  loadMore: () => Promise<void>
  refreshPosts: () => Promise<void>
}

export function usePostFeedData(options: UsePostFeedDataOptions): UsePostFeedDataReturn {
  const {
    pageSize = 20,
    groupId,
    groupIds,
    authorHandle,
    sortBy,
    onError,
    onSuccess,
  } = options

  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)

  // Load posts (reset list)
  const loadPosts = useCallback(async () => {
    // Cancel previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    // Create new AbortController
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      setLoading(true)
      setError(null)
      setOffset(0)
      setHasMore(true)

      const params = new URLSearchParams()
      params.set('limit', String(pageSize))
      params.set('offset', '0')

      if (sortBy) {
        params.set('sort', sortBy)
      }
      if (groupId) {
        params.set('group_id', groupId)
      }
      if (groupIds && groupIds.length > 0) {
        params.set('group_ids', groupIds.join(','))
      }
      if (authorHandle) {
        params.set('author_handle', authorHandle)
      }

      const url = `/api/posts?${params.toString()}`
      const response = await fetch(url, {
        signal: controller.signal,
        headers: await getCsrfHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to load posts: ${response.status}`)
      }

      const data = await response.json()
      const fetchedPosts = data.posts || []

      setPosts(fetchedPosts)
      setOffset(fetchedPosts.length)
      setHasMore(fetchedPosts.length >= pageSize)

      if (onSuccess) {
        onSuccess(fetchedPosts)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return // Request was cancelled, ignore
      }
      const errorMessage = err instanceof Error ? err.message : 'Failed to load posts'
      setError(errorMessage)
      if (onError) {
        onError(errorMessage)
      }
    } finally {
      setLoading(false)
      abortControllerRef.current = null
    }
  }, [pageSize, groupId, groupIds, authorHandle, sortBy, onError, onSuccess])

  // Load more posts (append to list)
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return

    try {
      setLoadingMore(true)

      const params = new URLSearchParams()
      params.set('limit', String(pageSize))
      params.set('offset', String(offset))

      if (sortBy) {
        params.set('sort', sortBy)
      }
      if (groupId) {
        params.set('group_id', groupId)
      }
      if (groupIds && groupIds.length > 0) {
        params.set('group_ids', groupIds.join(','))
      }
      if (authorHandle) {
        params.set('author_handle', authorHandle)
      }

      const url = `/api/posts?${params.toString()}`
      const response = await fetch(url, {
        headers: await getCsrfHeaders(),
      })

      if (!response.ok) {
        throw new Error(`Failed to load more posts: ${response.status}`)
      }

      const data = await response.json()
      const morePosts = data.posts || []

      if (morePosts.length === 0) {
        setHasMore(false)
        return
      }

      setPosts(prev => [...prev, ...morePosts])
      setOffset(prev => prev + morePosts.length)
      setHasMore(morePosts.length >= pageSize)
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load more posts'
      setError(errorMessage)
      if (onError) {
        onError(errorMessage)
      }
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, pageSize, offset, groupId, groupIds, authorHandle, sortBy, onError])

  // Refresh posts
  const refreshPosts = useCallback(async () => {
    setRefreshing(true)
    await loadPosts()
    setRefreshing(false)
  }, [loadPosts])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  return {
    posts,
    setPosts,
    loading,
    refreshing,
    loadingMore,
    hasMore,
    error,
    offset,
    loadPosts,
    loadMore,
    refreshPosts,
  }
}
