'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

export interface Post {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  author_handle?: string | null
  author_id?: string | null
  author_avatar_url?: string | null
  like_count?: number | null
  comment_count?: number | null
  bookmark_count?: number | null
  repost_count?: number | null
  is_pinned?: boolean | null
  user_liked?: boolean
  user_bookmarked?: boolean
  user_reposted?: boolean
}

export interface CommentWithAuthor {
  id: string
  post_id: string
  user_id: string
  content: string
  parent_id?: string | null
  like_count: number
  created_at: string
  updated_at: string
  author_handle?: string | null
  author_avatar_url?: string | null
  replies?: CommentWithAuthor[]
}

interface UseGroupPostsOptions {
  groupId: string
  userId: string | null
  accessToken: string | null
  isMember: boolean
  language: string
  showToast: (msg: string, type: 'success' | 'error' | 'warning') => void
  showDangerConfirm: (title: string, message: string) => Promise<boolean>
}

const POST_PAGE_SIZE = 20
const POST_SELECT_FIELDS = 'id, group_id, title, content, created_at, author_handle, author_id, like_count, comment_count, bookmark_count, repost_count, is_pinned'

// Helper to create bilingual messages
function msg(zh: string, en: string, language: string): string {
  return language === 'zh' ? zh : en
}

// Generic fetch for user interactions (likes, bookmarks, reposts)
async function fetchUserInteractions(
  table: string,
  postIds: string[],
  userId: string
): Promise<Record<string, boolean>> {
  if (!userId || postIds.length === 0) return {}
  const { data } = await supabase
    .from(table)
    .select('post_id')
    .eq('user_id', userId)
    .in('post_id', postIds)
  const map: Record<string, boolean> = {}
  data?.forEach(item => { map[item.post_id] = true })
  return map
}

// Fetch author avatars in batch and mutate posts
async function enrichPostsWithAvatars(postsList: Post[]): Promise<void> {
  const authorIds = [...new Set(postsList.map(p => p.author_id).filter(Boolean))] as string[]
  if (authorIds.length === 0) return
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, avatar_url')
    .in('id', authorIds)
  if (profiles) {
    const avatarMap = new Map(profiles.map(p => [p.id, p.avatar_url]))
    postsList.forEach(post => {
      if (post.author_id) {
        post.author_avatar_url = avatarMap.get(post.author_id) || null
      }
    })
  }
}

// Enrich posts with user interactions
async function enrichPostsWithUserState(postsList: Post[], userId: string): Promise<void> {
  const postIds = postsList.map(p => p.id)
  const [likeMap, bookmarkMap, repostMap] = await Promise.all([
    fetchUserInteractions('post_likes', postIds, userId),
    fetchUserInteractions('post_bookmarks', postIds, userId),
    fetchUserInteractions('reposts', postIds, userId),
  ])
  postsList.forEach(post => {
    post.user_liked = likeMap[post.id] || false
    post.user_bookmarked = bookmarkMap[post.id] || false
    post.user_reposted = repostMap[post.id] || false
  })
}

export function useGroupPosts({
  groupId,
  userId,
  accessToken,
  isMember,
  language,
  showToast,
  showDangerConfirm,
}: UseGroupPostsOptions) {
  // Core state
  const [posts, setPosts] = useState<Post[]>([])
  const [sortMode, setSortMode] = useState<'latest' | 'hot'>('latest')
  const [viewMode, setViewMode] = useState<'list' | 'masonry'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('group-view-mode') as 'list' | 'masonry') || 'masonry'
    }
    return 'masonry'
  })
  const [hasMorePosts, setHasMorePosts] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Post editing state
  const [editingPost, setEditingPost] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingPost, setDeletingPost] = useState<string | null>(null)

  // Interaction loading states (using single object for each type)
  const [likeLoading, setLikeLoading] = useState<Record<string, boolean>>({})
  const [bookmarkLoading, setBookmarkLoading] = useState<Record<string, boolean>>({})
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')

  // Comments state
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<Record<string, CommentWithAuthor[]>>({})
  const [newComment, setNewComment] = useState<Record<string, string>>({})
  const [commentLoading, setCommentLoading] = useState<Record<string, boolean>>({})
  const [replyingTo, setReplyingTo] = useState<Record<string, string | null>>({})
  const [replyContent, setReplyContent] = useState<Record<string, string>>({})
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})

  // Content expansion
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})

  // Helper to set loading state for a specific post
  const setPostLoading = useCallback((
    setter: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
    postId: string,
    loading: boolean
  ) => {
    setter(prev => ({ ...prev, [postId]: loading }))
  }, [])

  // Fetch posts from database with optional cursor
  const fetchPosts = useCallback(async (cursor?: string): Promise<Post[]> => {
    let query = supabase
      .from('posts')
      .select(POST_SELECT_FIELDS)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(POST_PAGE_SIZE)

    if (cursor) {
      query = query.lt('created_at', cursor)
    }

    const { data, error } = await query
    if (error) throw error
    return (data || []) as Post[]
  }, [groupId])

  // Enrich posts with avatars and user state
  const enrichPosts = useCallback(async (postsList: Post[]): Promise<void> => {
    const promises: Promise<void>[] = [enrichPostsWithAvatars(postsList)]
    if (userId) {
      promises.push(enrichPostsWithUserState(postsList, userId))
    }
    await Promise.all(promises)
  }, [userId])

  // Load initial posts
  const loadPosts = useCallback(async (forceLoad = false) => {
    if (!groupId || (!isMember && !forceLoad)) {
      setPosts([])
      setHasMorePosts(false)
      return
    }

    try {
      const postsList = await fetchPosts()
      await enrichPosts(postsList)
      setPosts(postsList)
      setHasMorePosts(postsList.length === POST_PAGE_SIZE)
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Failed to load posts'
      showToast(error, 'error')
    }
  }, [groupId, isMember, fetchPosts, enrichPosts, showToast])

  // Infinite scroll: load more
  const loadMorePosts = useCallback(async () => {
    if (loadingMore || !hasMorePosts || posts.length === 0 || !isMember) return

    setLoadingMore(true)
    try {
      const lastPost = posts[posts.length - 1]
      const postsList = await fetchPosts(lastPost.created_at)

      if (postsList.length > 0) {
        await enrichPosts(postsList)
        setPosts(prev => [...prev, ...postsList])
        setHasMorePosts(postsList.length === POST_PAGE_SIZE)
      } else {
        setHasMorePosts(false)
      }
    } catch (err) {
      console.error('Load more posts error:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMorePosts, posts, isMember, fetchPosts, enrichPosts])

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMorePosts()
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMorePosts])

  // Sorted posts (memoized)
  const sortedPosts = useMemo(() => {
    if (posts.length === 0) return []

    let sorted: Post[]
    if (sortMode === 'latest') {
      sorted = [...posts].sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )
    } else {
      const now = Date.now()
      sorted = [...posts].sort((a, b) => {
        const hoursA = (now - new Date(a.created_at).getTime()) / (1000 * 60 * 60)
        const hoursB = (now - new Date(b.created_at).getTime()) / (1000 * 60 * 60)
        const scoreA = ((a.like_count || 0) * 2 + (a.comment_count || 0) * 1) / (1 + hoursA / 24)
        const scoreB = ((b.like_count || 0) * 2 + (b.comment_count || 0) * 1) / (1 + hoursB / 24)
        return scoreB - scoreA
      })
    }

    return sorted.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1
      if (!a.is_pinned && b.is_pinned) return 1
      return 0
    })
  }, [posts, sortMode])

  // Heat color
  const maxComments = sortedPosts.reduce((max, post) =>
    Math.max(max, post.comment_count || 0), 0
  )

  const getHeatColor = (commentCount: number): string => {
    if (maxComments === 0) return '#FFE4CC'
    const ratio = Math.min(commentCount / maxComments, 1)
    const r = 255
    const g = Math.round(228 - ratio * (228 - 107))
    const b = Math.round(204 - ratio * 204)
    return `rgb(${r}, ${g}, ${b})`
  }

  // Generic API call helper
  const apiCall = useCallback(async (
    url: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    try {
      const response = await fetch(url, {
        method: options.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
          ...options.headers,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      })
      const data = await response.json().catch(() => ({}))
      return { ok: response.ok, data, error: data.error }
    } catch {
      return { ok: false, error: msg('网络错误', 'Network error', language) }
    }
  }, [accessToken, language])

  // Like handler
  const handleLike = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(msg('请先登录', 'Please login first', language), 'warning')
      return
    }
    setPostLoading(setLikeLoading, postId, true)
    const result = await apiCall(`/api/posts/${postId}/like`, { body: { reaction_type: 'up' } })
    if (result.ok) {
      setPosts(prev => prev.map(p => {
        if (p.id !== postId) return p
        const wasLiked = p.user_liked
        return {
          ...p,
          user_liked: !wasLiked,
          like_count: wasLiked ? Math.max(0, (p.like_count || 0) - 1) : (p.like_count || 0) + 1,
        }
      }))
    } else {
      showToast(result.error || msg('操作失败', 'Operation failed', language), 'error')
    }
    setPostLoading(setLikeLoading, postId, false)
  }, [accessToken, language, showToast, apiCall, setPostLoading])

  // Bookmark handler
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(msg('请先登录', 'Please login first', language), 'warning')
      return
    }
    setPostLoading(setBookmarkLoading, postId, true)
    const result = await apiCall(`/api/posts/${postId}/bookmark`)
    if (result.ok) {
      const data = result.data as { bookmarked: boolean; bookmark_count: number }
      setPosts(prev => prev.map(p =>
        p.id === postId ? { ...p, user_bookmarked: data.bookmarked, bookmark_count: data.bookmark_count } : p
      ))
    } else {
      showToast(result.error || msg('操作失败', 'Operation failed', language), 'error')
    }
    setPostLoading(setBookmarkLoading, postId, false)
  }, [accessToken, language, showToast, apiCall, setPostLoading])

  // Repost handler
  const handleRepost = useCallback(async (postId: string, comment?: string) => {
    if (!accessToken) {
      showToast(msg('请先登录', 'Please login first', language), 'warning')
      return
    }
    const post = posts.find(p => p.id === postId)
    if (post?.author_id === userId) {
      showToast(msg('不能转发自己的帖子', 'Cannot repost your own post', language), 'warning')
      return
    }
    if (post?.user_reposted) {
      showToast(msg('已经转发过此帖子', 'Already reposted', language), 'warning')
      return
    }
    setPostLoading(setRepostLoading, postId, true)
    const result = await apiCall(`/api/posts/${postId}/repost`, { body: { comment } })
    if (result.ok) {
      const data = result.data as { repost_count: number }
      setPosts(prev => prev.map(p =>
        p.id === postId ? { ...p, user_reposted: true, repost_count: data.repost_count } : p
      ))
      setShowRepostModal(null)
      setRepostComment('')
      showToast(msg('转发成功！', 'Reposted successfully!', language), 'success')
    } else {
      showToast(result.error || msg('转发失败', 'Repost failed', language), 'error')
    }
    setPostLoading(setRepostLoading, postId, false)
  }, [accessToken, language, showToast, posts, userId, apiCall, setPostLoading])

  // Delete post
  const handleDeletePost = useCallback(async (postId: string) => {
    const confirmed = await showDangerConfirm(
      msg('删除帖子', 'Delete Post', language),
      msg('确定删除此帖子吗？此操作不可撤销。', 'Are you sure you want to delete this post? This cannot be undone.', language)
    )
    if (!confirmed) return

    setDeletingPost(postId)
    const result = await apiCall(`/api/posts/${postId}/delete`, { method: 'DELETE' })
    if (result.ok) {
      setPosts(prev => prev.filter(p => p.id !== postId))
      showToast(msg('帖子已删除', 'Post deleted', language), 'success')
    } else {
      showToast(result.error || msg('删除失败', 'Delete failed', language), 'error')
    }
    setDeletingPost(null)
  }, [language, showToast, showDangerConfirm, apiCall])

  // Save edit
  const handleSaveEdit = useCallback(async (postId: string) => {
    if (!editTitle.trim()) {
      showToast(msg('标题不能为空', 'Title cannot be empty', language), 'warning')
      return
    }
    setSavingEdit(true)
    const result = await apiCall(`/api/posts/${postId}/edit`, {
      method: 'PUT',
      body: { title: editTitle.trim(), content: editContent.trim() },
    })
    if (result.ok) {
      setPosts(prev => prev.map(p =>
        p.id === postId ? { ...p, title: editTitle.trim(), content: editContent.trim() } : p
      ))
      setEditingPost(null)
      showToast(msg('修改成功', 'Updated successfully', language), 'success')
    } else {
      showToast(result.error || msg('修改失败', 'Update failed', language), 'error')
    }
    setSavingEdit(false)
  }, [language, showToast, editTitle, editContent, apiCall])

  // Pin/unpin
  const handlePinPost = useCallback(async (postId: string) => {
    const result = await apiCall(`/api/posts/${postId}/pin`)
    if (result.ok) {
      const data = result.data as { data?: { is_pinned: boolean }; is_pinned?: boolean }
      const newPinned = data.data?.is_pinned ?? data.is_pinned
      setPosts(prev => prev.map(p => {
        if (p.id === postId) return { ...p, is_pinned: newPinned }
        if (newPinned) return { ...p, is_pinned: false }
        return p
      }))
      showToast(msg(newPinned ? '已置顶' : '已取消置顶', newPinned ? 'Pinned' : 'Unpinned', language), 'success')
    } else {
      showToast(result.error || msg('操作失败', 'Operation failed', language), 'error')
    }
  }, [language, showToast, apiCall])

  // Load comments for a post
  const loadComments = useCallback(async (postId: string) => {
    setPostLoading(setCommentLoading, postId, true)
    try {
      const response = await fetch(`/api/posts/${postId}/comments`)
      const json = await response.json()
      if (response.ok && json.success) {
        setComments(prev => ({ ...prev, [postId]: json.data?.comments || [] }))
      } else {
        showToast(msg('加载评论失败', 'Failed to load comments', language), 'error')
      }
    } catch {
      showToast(msg('网络错误', 'Network error', language), 'error')
    } finally {
      setPostLoading(setCommentLoading, postId, false)
    }
  }, [language, showToast, setPostLoading])

  const toggleComments = useCallback((postId: string) => {
    const isExpanded = expandedComments[postId]
    setExpandedComments(prev => ({ ...prev, [postId]: !isExpanded }))
    if (!isExpanded && !comments[postId]) {
      loadComments(postId)
    }
  }, [expandedComments, comments, loadComments])

  const submitComment = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(msg('请先登录', 'Please login first', language), 'warning')
      return
    }
    const content = newComment[postId]?.trim()
    if (!content) return

    setPostLoading(setCommentLoading, postId, true)
    const result = await apiCall(`/api/posts/${postId}/comments`, { body: { content } })

    if (!result.ok) {
      const errorMsg = result.error || msg('评论发布失败', 'Failed to post comment', language)
      showToast(errorMsg, 'error')
      setPostLoading(setCommentLoading, postId, false)
      return
    }

    const data = result.data as { success: boolean; data?: { comment: CommentWithAuthor }; error?: string }
    if (data.success && data.data?.comment) {
      setNewComment(prev => ({ ...prev, [postId]: '' }))
      setExpandedComments(prev => ({ ...prev, [postId]: true }))
      setComments(prev => ({ ...prev, [postId]: [...(prev[postId] || []), data.data!.comment] }))
      setPosts(prev => prev.map(p =>
        p.id === postId ? { ...p, comment_count: (p.comment_count || 0) + 1 } : p
      ))
    } else {
      showToast(data.error || msg('评论发布失败', 'Failed to post comment', language), 'error')
    }
    setPostLoading(setCommentLoading, postId, false)
  }, [accessToken, language, showToast, newComment, apiCall, setPostLoading])

  const submitReply = useCallback(async (postId: string, commentId: string) => {
    if (!accessToken || !replyContent[commentId]?.trim()) return
    const result = await apiCall(`/api/posts/${postId}/comments`, {
      body: { content: replyContent[commentId].trim(), parent_id: commentId },
    })
    if (result.ok) {
      setReplyContent(prev => ({ ...prev, [commentId]: '' }))
      setReplyingTo(prev => ({ ...prev, [postId]: null }))
      loadComments(postId)
    }
  }, [accessToken, replyContent, loadComments, apiCall])

  // View mode setter
  const setViewModeWithPersist = useCallback((mode: 'list' | 'masonry') => {
    setViewMode(mode)
    localStorage.setItem('group-view-mode', mode)
  }, [])

  return {
    posts,
    setPosts,
    sortedPosts,
    sortMode,
    setSortMode,
    viewMode,
    setViewMode: setViewModeWithPersist,
    hasMorePosts,
    loadingMore,
    sentinelRef,
    loadPosts,

    // Post editing
    editingPost,
    setEditingPost,
    editTitle,
    setEditTitle,
    editContent,
    setEditContent,
    savingEdit,
    deletingPost,

    // Interactions
    likeLoading,
    bookmarkLoading,
    repostLoading,
    showRepostModal,
    setShowRepostModal,
    repostComment,
    setRepostComment,

    // Comments
    expandedComments,
    comments,
    newComment,
    setNewComment,
    commentLoading,
    replyingTo,
    setReplyingTo,
    replyContent,
    setReplyContent,
    expandedReplies,
    setExpandedReplies,

    // Content expand
    expandedPosts,
    setExpandedPosts,

    // Actions
    handleLike,
    handleBookmark,
    handleRepost,
    handleDeletePost,
    handleSaveEdit,
    handlePinPost,
    toggleComments,
    submitComment,
    submitReply,
    getHeatColor,
    maxComments,
  }
}
