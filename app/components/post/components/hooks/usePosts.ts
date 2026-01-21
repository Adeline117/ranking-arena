'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import { type PostWithUserState } from '@/lib/types'
import { getCsrfHeaders } from '@/lib/api/client'

type Post = PostWithUserState
type SortType = 'time' | 'likes' | 'hot'

interface UsePostsOptions {
  groupId?: string
  authorHandle?: string
  initialSortType?: SortType
}

interface UsePostsResult {
  posts: Post[]
  loading: boolean
  error: string | null
  sortType: SortType
  setSortType: (type: SortType) => void
  refresh: () => Promise<void>
  accessToken: string | null
  currentUserId: string | null
  updatePost: (postId: string, updates: Partial<Post>) => void
}

/**
 * 帖子数据管理 Hook
 * 处理帖子列表的获取、排序和状态管理
 */
export function usePosts(options: UsePostsOptions = {}): UsePostsResult {
  const { groupId, authorHandle, initialSortType = 'time' } = options
  
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortType, setSortType] = useState<SortType>(initialSortType)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  
  // 获取认证状态
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setAccessToken(session?.access_token || null)
      setCurrentUserId(session?.user?.id || null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAccessToken(session?.access_token || null)
      setCurrentUserId(session?.user?.id || null)
    })

    return () => subscription.unsubscribe()
  }, [])

  // 加载帖子
  const loadPosts = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams()
      params.set('limit', '20')
      
      // 根据排序类型设置排序方式
      if (sortType === 'likes') {
        params.set('sort_by', 'like_count')
      } else if (sortType === 'hot') {
        params.set('sort_by', 'hot_score')
      } else {
        params.set('sort_by', 'created_at')
      }
      params.set('sort_order', 'desc')
      
      if (groupId) params.set('group_id', groupId)
      if (authorHandle) params.set('author_handle', authorHandle)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }

      const response = await fetch(`/api/posts?${params.toString()}`, { headers })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || '获取帖子失败')
      }

      setPosts(data.data?.posts || [])
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '加载失败'
      setError(errorMessage)
    } finally {
      setLoading(false)
    }
  }, [groupId, authorHandle, accessToken, sortType])

  // 初始加载
  useEffect(() => {
    loadPosts()
  }, [loadPosts])

  // 更新单个帖子
  const updatePost = useCallback((postId: string, updates: Partial<Post>) => {
    setPosts(prev => prev.map(p => 
      p.id === postId ? { ...p, ...updates } : p
    ))
  }, [])

  return {
    posts,
    loading,
    error,
    sortType,
    setSortType,
    refresh: loadPosts,
    accessToken,
    currentUserId,
    updatePost,
  }
}

/**
 * 帖子操作 Hook
 * 处理点赞、投票等操作
 */
export function usePostActions(accessToken: string | null) {
  const processingRef = useRef<Set<string>>(new Set())
  
  // 点赞/踩
  const toggleReaction = useCallback(async (
    postId: string,
    reactionType: 'up' | 'down',
    onSuccess?: (result: { like_count: number; dislike_count: number; reaction: 'up' | 'down' | null }) => void,
    onError?: (error: string) => void
  ) => {
    if (!accessToken) {
      console.warn('[usePostActions] 需要登录')
      onError?.('请先登录')
      return
    }

    const key = `react-${postId}-${reactionType}`
    if (processingRef.current.has(key)) return
    processingRef.current.add(key)

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
        onSuccess?.(json.data)
      } else {
        const errorMsg = json.error || '点赞失败'
        console.error('[usePostActions] 点赞失败:', errorMsg)
        onError?.(errorMsg)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '网络错误，请重试'
      console.error('[usePostActions] 点赞失败:', err)
      onError?.(errorMsg)
    } finally {
      setTimeout(() => processingRef.current.delete(key), 300)
    }
  }, [accessToken])

  // 投票
  const toggleVote = useCallback(async (
    postId: string,
    choice: 'bull' | 'bear' | 'wait',
    onSuccess?: (result: { poll: { bull: number; bear: number; wait: number }; vote: 'bull' | 'bear' | 'wait' | null }) => void,
    onError?: (error: string) => void
  ) => {
    if (!accessToken) {
      console.warn('[usePostActions] 需要登录')
      onError?.('请先登录')
      return
    }

    const key = `vote-${postId}-${choice}`
    if (processingRef.current.has(key)) return
    processingRef.current.add(key)

    try {
      const response = await fetch(`/api/posts/${postId}/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ choice }),
      })

      const json = await response.json()

      if (response.ok && json.success) {
        onSuccess?.(json.data)
      } else {
        const errorMsg = json.error || '投票失败'
        console.error('[usePostActions] 投票失败:', errorMsg)
        onError?.(errorMsg)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '网络错误，请重试'
      console.error('[usePostActions] 投票失败:', err)
      onError?.(errorMsg)
    } finally {
      setTimeout(() => processingRef.current.delete(key), 300)
    }
  }, [accessToken])

  return {
    toggleReaction,
    toggleVote,
  }
}

export default usePosts

