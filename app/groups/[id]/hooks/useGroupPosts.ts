'use client'

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabase/client'
import { getCsrfHeaders } from '@/lib/api/client'

export type Post = {
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

export type CommentWithAuthor = {
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

export function useGroupPosts({
  groupId,
  userId,
  accessToken,
  isMember,
  language,
  showToast,
  showDangerConfirm,
}: UseGroupPostsOptions) {
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

  // Post editing
  const [editingPost, setEditingPost] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [deletingPost, setDeletingPost] = useState<string | null>(null)

  // Interactions loading
  const [likeLoading, setLikeLoading] = useState<Record<string, boolean>>({})
  const [bookmarkLoading, setBookmarkLoading] = useState<Record<string, boolean>>({})
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')

  // Comments
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<Record<string, CommentWithAuthor[]>>({})
  const [newComment, setNewComment] = useState<Record<string, string>>({})
  const [commentLoading, setCommentLoading] = useState<Record<string, boolean>>({})
  const [replyingTo, setReplyingTo] = useState<Record<string, string | null>>({})
  const [replyContent, setReplyContent] = useState<Record<string, string>>({})
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})

  // Content expand
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})

  // Fetch user likes/bookmarks/reposts
  const fetchUserLikes = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    const { data } = await supabase
      .from('post_likes')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    const likeMap: Record<string, boolean> = {}
    data?.forEach(item => { likeMap[item.post_id] = true })
    return likeMap
  }, [])

  const fetchUserBookmarks = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    const { data } = await supabase
      .from('post_bookmarks')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    const bookmarkMap: Record<string, boolean> = {}
    data?.forEach(item => { bookmarkMap[item.post_id] = true })
    return bookmarkMap
  }, [])

  const fetchUserReposts = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    const { data } = await supabase
      .from('reposts')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    const repostMap: Record<string, boolean> = {}
    data?.forEach(item => { repostMap[item.post_id] = true })
    return repostMap
  }, [])

  // Fetch author avatars in batch
  const fetchAuthorAvatars = useCallback(async (postsList: Post[]) => {
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
  }, [])

  // Load initial posts
  const loadPosts = useCallback(async () => {
    if (!groupId || !isMember) {
      setPosts([])
      setHasMorePosts(false)
      return
    }

    const { data: postsData, error: postsErr } = await supabase
      .from('posts')
      .select('id, group_id, title, content, created_at, author_handle, author_id, like_count, comment_count, bookmark_count, repost_count, is_pinned')
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20)

    if (postsErr) {
      showToast(postsErr.message, 'error')
      return
    }

    const postsList = (postsData || []) as Post[]

    // Fetch avatars and user interactions in parallel
    const promises: Promise<unknown>[] = [fetchAuthorAvatars(postsList)]
    if (userId) {
      const postIds = postsList.map(p => p.id)
      promises.push(
        Promise.all([
          fetchUserLikes(postIds, userId),
          fetchUserBookmarks(postIds, userId),
          fetchUserReposts(postIds, userId)
        ]).then(([likeMap, bookmarkMap, repostMap]) => {
          postsList.forEach(post => {
            post.user_liked = likeMap[post.id] || false
            post.user_bookmarked = bookmarkMap[post.id] || false
            post.user_reposted = repostMap[post.id] || false
          })
        })
      )
    }
    await Promise.all(promises)

    setPosts(postsList)
    setHasMorePosts(postsList.length === 20)
  }, [groupId, isMember, userId, fetchUserLikes, fetchUserBookmarks, fetchUserReposts, fetchAuthorAvatars, showToast])

  // Infinite scroll: load more
  const loadMorePosts = useCallback(async () => {
    if (loadingMore || !hasMorePosts || posts.length === 0 || !isMember) return

    setLoadingMore(true)
    try {
      const lastPost = posts[posts.length - 1]
      const { data: morePosts } = await supabase
        .from('posts')
        .select('id, group_id, title, content, created_at, author_handle, author_id, like_count, comment_count, bookmark_count, repost_count, is_pinned')
        .eq('group_id', groupId)
        .is('deleted_at', null)
        .lt('created_at', lastPost.created_at)
        .order('created_at', { ascending: false })
        .limit(20)

      if (morePosts && morePosts.length > 0) {
        const postsList = morePosts as Post[]
        const promises: Promise<unknown>[] = [fetchAuthorAvatars(postsList)]
        if (userId) {
          const postIds = postsList.map(p => p.id)
          promises.push(
            Promise.all([
              fetchUserLikes(postIds, userId),
              fetchUserBookmarks(postIds, userId),
              fetchUserReposts(postIds, userId)
            ]).then(([likeMap, bookmarkMap, repostMap]) => {
              postsList.forEach(post => {
                post.user_liked = likeMap[post.id] || false
                post.user_bookmarked = bookmarkMap[post.id] || false
                post.user_reposted = repostMap[post.id] || false
              })
            })
          )
        }
        await Promise.all(promises)
        setPosts(prev => [...prev, ...postsList])
        setHasMorePosts(postsList.length === 20)
      } else {
        setHasMorePosts(false)
      }
    } catch (err) {
      console.error('Load more posts error:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMorePosts, posts, isMember, groupId, userId, fetchUserLikes, fetchUserBookmarks, fetchUserReposts, fetchAuthorAvatars])

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

  // Like handler
  const handleLike = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'warning')
      return
    }
    setLikeLoading(prev => ({ ...prev, [postId]: true }))
    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ reaction_type: 'up' }),
      })
      if (response.ok) {
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            const wasLiked = p.user_liked
            return {
              ...p,
              user_liked: !wasLiked,
              like_count: wasLiked
                ? Math.max(0, (p.like_count || 0) - 1)
                : (p.like_count || 0) + 1,
            }
          }
          return p
        }))
      } else {
        const result = await response.json()
        showToast(result.error || (language === 'zh' ? '操作失败' : 'Operation failed'), 'error')
      }
    } catch (err) {
      console.error('Like error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setLikeLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, language, showToast])

  // Bookmark handler
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'warning')
      return
    }
    setBookmarkLoading(prev => ({ ...prev, [postId]: true }))
    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, ...getCsrfHeaders() },
      })
      const result = await response.json()
      if (response.ok) {
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, user_bookmarked: result.bookmarked, bookmark_count: result.bookmark_count }
          }
          return p
        }))
      } else {
        showToast(result.error || (language === 'zh' ? '操作失败' : 'Operation failed'), 'error')
      }
    } catch (err) {
      console.error('Bookmark error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setBookmarkLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, language, showToast])

  // Repost handler
  const handleRepost = useCallback(async (postId: string, comment?: string) => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'warning')
      return
    }
    const post = posts.find(p => p.id === postId)
    if (post?.author_id === userId) {
      showToast(language === 'zh' ? '不能转发自己的帖子' : 'Cannot repost your own post', 'warning')
      return
    }
    if (post?.user_reposted) {
      showToast(language === 'zh' ? '已经转发过此帖子' : 'Already reposted', 'warning')
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
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, user_reposted: true, repost_count: result.repost_count }
          }
          return p
        }))
        setShowRepostModal(null)
        setRepostComment('')
        showToast(language === 'zh' ? '转发成功！' : 'Reposted successfully!', 'success')
      } else {
        showToast(result.error || (language === 'zh' ? '转发失败' : 'Repost failed'), 'error')
      }
    } catch (err) {
      console.error('Repost error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setRepostLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, language, showToast, posts, userId])

  // Delete post
  const handleDeletePost = useCallback(async (postId: string) => {
    const confirmed = await showDangerConfirm(
      language === 'zh' ? '删除帖子' : 'Delete Post',
      language === 'zh' ? '确定删除此帖子吗？此操作不可撤销。' : 'Are you sure you want to delete this post? This cannot be undone.'
    )
    if (!confirmed) return

    setDeletingPost(postId)
    try {
      const res = await fetch(`/api/posts/${postId}/delete`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() }
      })
      if (res.ok) {
        setPosts(prev => prev.filter(p => p.id !== postId))
        showToast(language === 'zh' ? '帖子已删除' : 'Post deleted', 'success')
      } else {
        const data = await res.json()
        showToast(data.error || (language === 'zh' ? '删除失败' : 'Delete failed'), 'error')
      }
    } catch (err) {
      console.error('Delete post error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setDeletingPost(null)
    }
  }, [accessToken, language, showToast, showDangerConfirm])

  // Save edit
  const handleSaveEdit = useCallback(async (postId: string) => {
    if (!editTitle.trim()) {
      showToast(language === 'zh' ? '标题不能为空' : 'Title cannot be empty', 'warning')
      return
    }
    setSavingEdit(true)
    try {
      const res = await fetch(`/api/posts/${postId}/edit`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ title: editTitle.trim(), content: editContent.trim() })
      })
      if (res.ok) {
        setPosts(prev => prev.map(p =>
          p.id === postId ? { ...p, title: editTitle.trim(), content: editContent.trim() } : p
        ))
        setEditingPost(null)
        showToast(language === 'zh' ? '修改成功' : 'Updated successfully', 'success')
      } else {
        const data = await res.json()
        showToast(data.error || (language === 'zh' ? '修改失败' : 'Update failed'), 'error')
      }
    } catch (err) {
      console.error('Edit post error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setSavingEdit(false)
    }
  }, [accessToken, language, showToast, editTitle, editContent])

  // Pin/unpin
  const handlePinPost = useCallback(async (postId: string) => {
    try {
      const res = await fetch(`/api/posts/${postId}/pin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ...getCsrfHeaders() }
      })
      if (res.ok) {
        const data = await res.json()
        const newPinned = data.data?.is_pinned ?? data.is_pinned
        setPosts(prev => prev.map(p => {
          if (p.id === postId) return { ...p, is_pinned: newPinned }
          if (newPinned) return { ...p, is_pinned: false }
          return p
        }))
        showToast(
          newPinned
            ? (language === 'zh' ? '已置顶' : 'Pinned')
            : (language === 'zh' ? '已取消置顶' : 'Unpinned'),
          'success'
        )
      } else {
        const data = await res.json()
        showToast(data.error || (language === 'zh' ? '操作失败' : 'Operation failed'), 'error')
      }
    } catch (err) {
      console.error('Pin post error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    }
  }, [accessToken, language, showToast])

  // Comments
  const loadComments = useCallback(async (postId: string) => {
    setCommentLoading(prev => ({ ...prev, [postId]: true }))
    try {
      const response = await fetch(`/api/posts/${postId}/comments`)
      const json = await response.json()
      if (response.ok && json.success) {
        setComments(prev => ({ ...prev, [postId]: json.data?.comments || [] }))
      } else {
        showToast(language === 'zh' ? '加载评论失败' : 'Failed to load comments', 'error')
      }
    } catch (err) {
      console.error('Load comments error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setCommentLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [language, showToast])

  const toggleComments = useCallback((postId: string) => {
    const isExpanded = expandedComments[postId]
    setExpandedComments(prev => ({ ...prev, [postId]: !isExpanded }))
    if (!isExpanded && !comments[postId]) {
      loadComments(postId)
    }
  }, [expandedComments, comments, loadComments])

  const submitComment = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'warning')
      return
    }
    const content = newComment[postId]?.trim()
    if (!content) return

    setCommentLoading(prev => ({ ...prev, [postId]: true }))
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) {
        if (response.status === 401) {
          showToast(language === 'zh' ? '登录已过期' : 'Session expired', 'error')
        } else {
          const result = await response.json().catch(() => null)
          showToast(result?.error || (language === 'zh' ? '评论发布失败' : 'Failed to post comment'), 'error')
        }
        return
      }

      const result = await response.json()
      if (result.success && result.data?.comment) {
        setNewComment(prev => ({ ...prev, [postId]: '' }))
        setExpandedComments(prev => ({ ...prev, [postId]: true }))
        setComments(prev => ({
          ...prev,
          [postId]: [...(prev[postId] || []), result.data.comment]
        }))
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: (p.comment_count || 0) + 1 }
          }
          return p
        }))
      } else {
        showToast(result.error || (language === 'zh' ? '评论发布失败' : 'Failed to post comment'), 'error')
      }
    } catch (err) {
      console.error('Submit comment error:', err)
      showToast(language === 'zh' ? '网络错误' : 'Network error', 'error')
    } finally {
      setCommentLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, language, showToast, newComment])

  const submitReply = useCallback(async (postId: string, commentId: string) => {
    if (!accessToken || !replyContent[commentId]?.trim()) return
    try {
      const res = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ content: replyContent[commentId].trim(), parent_id: commentId })
      })
      if (res.ok) {
        setReplyContent(prev => ({ ...prev, [commentId]: '' }))
        setReplyingTo(prev => ({ ...prev, [postId]: null }))
        loadComments(postId)
      }
    } catch { /* ignore */ }
  }, [accessToken, replyContent, loadComments])

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
