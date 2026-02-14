'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { CommentIcon } from '../ui/icons'
import { useLanguage } from '../Providers/LanguageProvider'
// Note: supabase import removed - using REST API instead
import { formatTimeAgo } from '@/lib/utils/date'
import { type PollChoice, type PostWithUserState } from '@/lib/types'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { getCsrfHeaders } from '@/lib/api/client'
import { DynamicBookmarkModal as BookmarkModal, DynamicCommentsModal as CommentsModal } from '../ui/Dynamic'
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'
import { usePostStore, type PostData } from '@/lib/stores/postStore'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { usePostComments, type Comment } from './hooks/usePostComments'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'
import { PostSkeleton } from '../ui/Skeleton'
import { SortButtons, type SortType, AvatarLink, PostModal, CustomPollCard, PostDetailActions } from './components'
import LevelBadge from '@/app/components/user/LevelBadge'
import { PostListItem } from './PostList'
import { EditPostModal, RepostModal } from './Modals'
import { logger } from '@/lib/logger'

// 本地类型（扩展后端类型）
type Post = PostWithUserState


interface PostFeedProps {
  variant?: 'compact' | 'full'
  layout?: 'list' | 'masonry'
  groupId?: string
  groupIds?: string[]
  authorHandle?: string
  initialPostId?: string | null
  showSortButtons?: boolean
  sortBy?: string
  limit?: number
  showRefreshButton?: boolean
}

export default function PostFeed(props: PostFeedProps = {}): React.ReactNode {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [sortType, setSortType] = useState<SortType>('time')
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const loadMoreRef = useRef<HTMLDivElement>(null)
  // 移动端视图切换：默认列表视图，可切换为瀑布流
  const [mobileViewMode, setMobileViewMode] = useState<'list' | 'masonry'>('list')

  // Listen to feed refresh trigger from store
  const feedRefreshTrigger = usePostStore(s => s.feedRefreshTrigger)
  // Unified auth - single source of truth
  const auth = useUnifiedAuth({
    onUnauthenticated: () => showToast(t('pleaseLogin'), 'warning'),
  })
  const accessToken = auth.accessToken
  const currentUserId = auth.userId
  const [editingPost, setEditingPost] = useState<Post | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const lockRef = useRef<Set<string>>(new Set())
  const postsRef = useRef(posts)
  postsRef.current = posts
  const abortControllerRef = useRef<AbortController | null>(null)

  // Comments hook
  const commentsHook = usePostComments({
    accessToken,
    showToast,
    showDangerConfirm,
    onCommentCountChange: (postId, delta) => {
      setPosts(prev => prev.map(p =>
        p.id === postId ? { ...p, comment_count: p.comment_count + delta } : p
      ))
      if (openPost?.id === postId) {
        setOpenPost(prev => prev ? { ...prev, comment_count: prev.comment_count + delta } : null)
      }
    },
  })
  const { comments, setComments, loadingComments, newComment, setNewComment, submittingComment,
    replyingTo, setReplyingTo, replyContent, setReplyContent, submittingReply,
    commentLikeLoading, expandedReplies, setExpandedReplies, deletingCommentId,
    loadComments, submitComment, toggleCommentLike, toggleCommentDislike, submitReply, deleteComment } = commentsHook

  // 翻译相关状态
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})
  // 列表翻译状态
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)
  // 评论翻译状态
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({})
  const [translatingComments, setTranslatingComments] = useState(false)
  // 自定义投票状态
  const [customPoll, setCustomPoll] = useState<{
    id: string
    question: string
    options: { text: string; votes: number | null }[]
    type: 'single' | 'multiple'
    endAt: string | null
    isExpired: boolean
    showResults: boolean
    totalVotes: number | null
  } | null>(null)
  const [customPollUserVotes, setCustomPollUserVotes] = useState<number[]>([])
  const [loadingCustomPoll, setLoadingCustomPoll] = useState(false)
  const [votingCustomPoll, setVotingCustomPoll] = useState(false)
  const [selectedPollOptions, setSelectedPollOptions] = useState<number[]>([])
  // 收藏和转发状态
  const [bookmarkLoading, setBookmarkLoading] = useState<Record<string, boolean>>({})
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')
  // 用户收藏和转发状态
  const [userBookmarks, setUserBookmarks] = useState<Record<string, boolean>>({})
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({})
  // Note: repostCounts tracks counts but value is not currently displayed in UI
  const [, setRepostCounts] = useState<Record<string, number>>({})
  // 收藏夹选择弹窗状态
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [bookmarkingPostId, setBookmarkingPostId] = useState<string | null>(null)

  // Auth state is now managed by useUnifiedAuth hook (single source of truth)
  // Store posts in canonical store when loaded
  const storeSetPosts = usePostStore(s => s.setPosts)

  const pageSize = props.limit || 20

  // 加载帖子（重置列表）
  const loadPosts = useCallback(async () => {
    // 取消之前的请求
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    // 创建新的AbortController
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
      // 根据排序类型设置排序方式
      if (props.sortBy) {
        params.set('sort_by', props.sortBy)
      } else if (sortType === 'likes') {
        params.set('sort_by', 'like_count')
      } else if (props.authorHandle) {
        params.set('sort_by', 'created_at')
      } else if (props.groupId || props.groupIds) {
        params.set('sort_by', 'created_at')
      } else {
        params.set('sort_by', 'hot_score')
      }
      params.set('sort_order', 'desc')

      if (props.groupId) params.set('group_id', props.groupId)
      if (props.groupIds && props.groupIds.length > 0) params.set('group_ids', props.groupIds.join(','))
      if (props.authorHandle) params.set('author_handle', props.authorHandle)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }

      const response = await fetch(`/api/posts?${params.toString()}`, {
        headers,
        signal: controller.signal
      })

      // 检查请求是否被取消
      if (controller.signal.aborted) {
        return
      }

      const data = await response.json()

      if (!response.ok) {
        const errorMsg = typeof data.error === 'string'
          ? data.error
          : (data.error?.message || t('fetchPostsFailed'))
        throw new Error(errorMsg)
      }

      // API 返回格式: { success: true, data: { posts: [...], pagination?: { has_more } } }
      const loadedPosts = data.data?.posts || []
      setPosts(loadedPosts)
      setOffset(loadedPosts.length)
      setHasMore(data.data?.pagination?.has_more ?? loadedPosts.length >= pageSize)

      // Store in canonical postStore for cross-component consistency
      const canonicalPosts: PostData[] = loadedPosts.map((p: Post) => ({
        id: p.id,
        title: p.title || '',
        content: p.content || '',
        author_handle: p.author_handle || 'user',
        group_id: p.group_id,
        group_name: p.group_name,
        created_at: p.created_at,
        like_count: p.like_count || 0,
        dislike_count: p.dislike_count || 0,
        comment_count: p.comment_count || 0,
        view_count: p.view_count || 0,
        hot_score: p.hot_score || 0,
        user_reaction: p.user_reaction,
        author_avatar_url: p.author_avatar_url,
      }))
      storeSetPosts(canonicalPosts)

      // 初始化收藏和转发计数
      const initialBookmarkCounts: Record<string, number> = {}
      const initialRepostCounts: Record<string, number> = {}
      loadedPosts.forEach((post: Post) => {
        initialBookmarkCounts[post.id] = post.bookmark_count || 0
        initialRepostCounts[post.id] = post.repost_count || 0
      })
      setBookmarkCounts(prev => ({ ...prev, ...initialBookmarkCounts }))
      setRepostCounts(prev => ({ ...prev, ...initialRepostCounts }))
    } catch (err) {
      // 如果是取消的请求，不处理错误
      if (err instanceof Error && (err.name === 'AbortError' || controller.signal.aborted)) {
        return
      }
      const errorMessage = err instanceof Error ? err.message : t('loadFailed')
      setError(errorMessage)
    } finally {
      // 只有在当前请求完成时才更新loading状态
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from useLanguage
  }, [props.groupId, props.authorHandle, accessToken, sortType, pageSize, props.groupIds, props.sortBy, storeSetPosts])

  // 加载更多帖子（无限滚动）
  const loadMorePosts = useCallback(async () => {
    if (loadingMore || !hasMore || loading) return

    const controller = new AbortController()

    try {
      setLoadingMore(true)

      const params = new URLSearchParams()
      params.set('limit', String(pageSize))
      params.set('offset', String(offset))
      if (props.sortBy) {
        params.set('sort_by', props.sortBy)
      } else if (sortType === 'likes') {
        params.set('sort_by', 'like_count')
      } else if (props.authorHandle) {
        params.set('sort_by', 'created_at')
      } else if (props.groupId || props.groupIds) {
        params.set('sort_by', 'created_at')
      } else {
        params.set('sort_by', 'hot_score')
      }
      params.set('sort_order', 'desc')

      if (props.groupId) params.set('group_id', props.groupId)
      if (props.groupIds && props.groupIds.length > 0) params.set('group_ids', props.groupIds.join(','))
      if (props.authorHandle) params.set('author_handle', props.authorHandle)

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }

      const response = await fetch(`/api/posts?${params.toString()}`, {
        headers,
        signal: controller.signal
      })

      if (controller.signal.aborted) return

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || t('loadMoreFailed'))
      }

      const morePosts = data.data?.posts || []

      // Deduplicate by ID
      const existingIds = new Set(posts.map(p => p.id))
      const newPosts = morePosts.filter((p: Post) => !existingIds.has(p.id))

      setPosts(prev => [...prev, ...newPosts])
      setOffset(prev => prev + newPosts.length)
      setHasMore(data.data?.pagination?.has_more ?? morePosts.length >= pageSize)

      // Update bookmark/repost counts
      const newBookmarkCounts: Record<string, number> = {}
      const newRepostCounts: Record<string, number> = {}
      newPosts.forEach((post: Post) => {
        newBookmarkCounts[post.id] = post.bookmark_count || 0
        newRepostCounts[post.id] = post.repost_count || 0
      })
      setBookmarkCounts(prev => ({ ...prev, ...newBookmarkCounts }))
      setRepostCounts(prev => ({ ...prev, ...newRepostCounts }))
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      logger.error('加载更多失败:', err)
    } finally {
      setLoadingMore(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingMore, hasMore, loading, offset, pageSize, props.sortBy, sortType, props.authorHandle, props.groupId, props.groupIds, accessToken, posts])
  
  // 组件卸载时取消所有请求
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

  // 手动刷新帖子
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await loadPosts()
    setRefreshing(false)
    showToast(t('refreshed'), 'success')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPosts, showToast, language])

  // 加载用户收藏状态 - 必须在使用它的 useEffect 之前定义
  // 注意：转发状态不再需要检查，因为新设计允许多次转发
  // 使用批量 API 一次性获取所有帖子的收藏状态
  const loadUserBookmarksAndReposts = useCallback(async (postIds: string[]) => {
    if (!accessToken || postIds.length === 0) return

    const controller = new AbortController()
    
    try {
      // 使用批量 API 获取收藏状态
      const res = await fetch('/api/posts/bookmarks/status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ postIds }),
        signal: controller.signal
      })
      
      if (controller.signal.aborted) return
      
      const data = await res.json()
      const bookmarks = data.bookmarks || {}

      // 批量更新用户收藏状态（只有在请求未被取消时）
      if (!controller.signal.aborted) {
        setUserBookmarks(prev => ({
          ...prev,
          ...bookmarks,
        }))
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      // 静默处理收藏状态加载失败，不影响主流程
    }
  }, [accessToken])

  // Load posts on key dependency changes and feed refresh trigger
  useEffect(() => {
    loadPosts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.groupId, props.authorHandle, accessToken, sortType, feedRefreshTrigger])

  // Infinite scroll observer
  useEffect(() => {
    const el = loadMoreRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
          loadMorePosts()
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, loading, loadMorePosts])

  // 加载用户收藏和转发状态
  useEffect(() => {
    if (posts.length > 0 && accessToken) {
      const postIds = posts.map(p => p.id)
      loadUserBookmarksAndReposts(postIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posts.length, accessToken])

  // 处理 initialPostId - 自动打开指定帖子
  const initialPostIdRef = useRef<string | null>(null)
  
  useEffect(() => {
    // 防止重复加载同一个帖子
    if (props.initialPostId && props.initialPostId !== initialPostIdRef.current && !openPost) {
      initialPostIdRef.current = props.initialPostId
      
      const postToOpen = posts.find(p => p.id === props.initialPostId)
      if (postToOpen) {
        setOpenPost(postToOpen)
        setComments([])
        // 延迟加载评论避免循环依赖
        fetch(`/api/posts/${postToOpen.id}/comments`)
          .then(res => res.json())
          .then(data => { if (data.success && data.data?.comments) setComments(data.data.comments) })
          .catch(() => {})
      } else {
        // 帖子不在当前列表中，单独加载
        const loadSinglePost = async () => {
          try {
            const response = await fetch(`/api/posts/${props.initialPostId}`)
            const data = await response.json()
            if (response.ok && data.success && data.data?.post) {
              const post = data.data.post
              setOpenPost({
                id: post.id,
                title: post.title || t('noTitle'),
                content: post.content || '',
                author_id: post.author_id,
                author_handle: post.author_handle || 'user',
                author_avatar_url: post.author_avatar_url,
                group_id: post.group_id,
                group_name: post.group_name,
                created_at: post.created_at,
                like_count: post.like_count || 0,
                dislike_count: post.dislike_count || 0,
                comment_count: post.comment_count || 0,
                bookmark_count: post.bookmark_count || 0,
                repost_count: post.repost_count || 0,
                view_count: post.view_count || 0,
                hot_score: post.hot_score || 0,
                is_pinned: post.is_pinned || false,
                poll_enabled: post.poll_enabled || false,
                poll_bull: post.poll_bull || 0,
                poll_bear: post.poll_bear || 0,
                poll_wait: post.poll_wait || 0,
                user_reaction: post.user_reaction,
                user_vote: post.user_vote,
              })
              setComments([])
              // 加载评论
              fetch(`/api/posts/${props.initialPostId}/comments`)
                .then(res => res.json())
                .then(data => { if (data.success && data.data?.comments) setComments(data.data.comments) })
                .catch(() => {})
            }
          } catch (err) {
            logger.error('Failed to load single post:', err)
          }
        }
        loadSinglePost()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable
  }, [props.initialPostId, posts, openPost, setComments])

  // 点赞/踩 - optimistic update with server reconciliation
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    const key = `react-${postId}-${reactionType}`
    if (lockRef.current.has(key)) return
    lockRef.current.add(key)

    // Capture previous state for rollback
    const prevPost = postsRef.current.find(p => p.id === postId)
    const prevOpenPost = openPost?.id === postId ? openPost : null

    // Optimistic update: compute expected new state
    if (prevPost) {
      const currentReaction = prevPost.user_reaction
      const newReaction = currentReaction === reactionType ? null : reactionType
      const optimistic = {
        like_count: prevPost.like_count + (
          reactionType === 'up'
            ? (currentReaction === 'up' ? -1 : 1)
            : (currentReaction === 'up' ? -1 : 0)
        ),
        dislike_count: prevPost.dislike_count + (
          reactionType === 'down'
            ? (currentReaction === 'down' ? -1 : 1)
            : (currentReaction === 'down' ? -1 : 0)
        ),
        user_reaction: newReaction,
      }

      const applyUpdate = (updates: typeof optimistic) => {
        setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...updates } : p))
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, ...updates } : null)
        }
      }

      applyUpdate(optimistic)
    }

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
        // Reconcile with server truth
        const serverUpdate = {
          like_count: result.like_count,
          dislike_count: result.dislike_count,
          user_reaction: result.reaction,
        }
        setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...serverUpdate } : p))

        usePostStore.getState().updatePostReaction(postId, {
          like_count: result.like_count,
          dislike_count: result.dislike_count,
          reaction: result.reaction,
        })

        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, ...serverUpdate } : null)
        }
      } else {
        // Rollback optimistic update
        if (prevPost) {
          setPosts(prev => prev.map(p => p.id === postId ? { ...p, like_count: prevPost.like_count, dislike_count: prevPost.dislike_count, user_reaction: prevPost.user_reaction } : p))
          if (prevOpenPost) {
            setOpenPost(prev => prev ? { ...prev, like_count: prevOpenPost.like_count, dislike_count: prevOpenPost.dislike_count, user_reaction: prevOpenPost.user_reaction } : null)
          }
        }
        const errorMsg = json.error || json.message || t('operationFailed')
        showToast(errorMsg, 'error')
      }
    } catch (err) {
      // Rollback optimistic update
      if (prevPost) {
        setPosts(prev => prev.map(p => p.id === postId ? { ...p, like_count: prevPost.like_count, dislike_count: prevPost.dislike_count, user_reaction: prevPost.user_reaction } : p))
        if (prevOpenPost) {
          setOpenPost(prev => prev ? { ...prev, like_count: prevOpenPost.like_count, dislike_count: prevOpenPost.dislike_count, user_reaction: prevOpenPost.user_reaction } : null)
        }
      }
      logger.error('[PostFeed] toggleReaction error:', err)
      showToast(t('networkError'), 'error')
    } finally {
      lockRef.current.delete(key)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, openPost?.id, showToast])

  // Built-in poll voting (bull/bear/wait) - preserved for future use
   
  const _toggleVote = useCallback(async (postId: string, choice: PollChoice) => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    const key = `vote-${postId}-${choice}`
    if (lockRef.current.has(key)) return
    lockRef.current.add(key)

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
        const result = json.data
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              poll_bull: result.poll.bull,
              poll_bear: result.poll.bear,
              poll_wait: result.poll.wait,
              user_vote: result.vote,
            }
          }
          return p
        }))

        // 如果弹窗打开，也更新
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? {
            ...prev,
            poll_bull: result.poll.bull,
            poll_bear: result.poll.bear,
            poll_wait: result.poll.wait,
            user_vote: result.vote,
          } : null)
        }
      } else {
        // FIX: Show error toast when API returns error
        const errorMsg = json.error || json.message || t('voteFailed')
        showToast(errorMsg, 'error')
      }
    } catch (err) {
      // FIX: Show error toast for network/unexpected errors
      logger.error('[PostFeed] toggleVote error:', err)
      showToast(t('networkError'), 'error')
    } finally {
      lockRef.current.delete(key)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, openPost?.id, showToast])

  // 加载自定义投票
  const loadCustomPoll = useCallback(async (postId: string) => {
    setLoadingCustomPoll(true)
    setCustomPoll(null)
    setCustomPollUserVotes([])
    setSelectedPollOptions([])
    try {
      const headers: Record<string, string> = {}
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }
      const response = await fetch(`/api/posts/${postId}/poll-vote`, { headers })
      const data = await response.json()
      if (response.ok && data.success && data.data?.poll) {
        setCustomPoll(data.data.poll)
        setCustomPollUserVotes(data.data.userVotes || [])
        setSelectedPollOptions(data.data.userVotes || [])
      }
    } catch (_err) {
      // 错误已在 showToast 中处理
    } finally {
      setLoadingCustomPoll(false)
    }
  }, [accessToken])

  // 提交自定义投票
  const submitCustomPollVote = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }
    if (selectedPollOptions.length === 0) {
      showToast(t('selectAtLeastOneOption'), 'warning')
      return
    }
    setVotingCustomPoll(true)
    try {
      const response = await fetch(`/api/posts/${postId}/poll-vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ optionIndexes: selectedPollOptions }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        // 更新投票状态 - 现在可以显示结果了
        setCustomPoll(prev => prev ? {
          ...prev,
          options: data.data.poll.options,
          showResults: true,
          totalVotes: data.data.poll.totalVotes,
        } : null)
        setCustomPollUserVotes(data.data.userVotes)
        showToast(t('voted'), 'success')
      } else {
        showToast(data.error || t('voteFailed'), 'error')
      }
    } catch (err) {
      logger.error('[PostFeed] custom poll vote failed:', err)
      showToast(t('voteFailed'), 'error')
    } finally {
      setVotingCustomPoll(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, selectedPollOptions])

  // 收藏帖子 - 点击收藏到默认收藏夹，已收藏则取消收藏
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }
    if (bookmarkLoading[postId]) return // prevent double-click

    setBookmarkLoading(prev => ({ ...prev, [postId]: true }))
    
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
        showToast(result.bookmarked ? t('bookmarked') : t('unbookmarked'), 'success')
      } else {
        showToast(result.error || t('operationFailed'), 'error')
      }
    } catch (_err) {
      showToast(t('networkError'), 'error')
    } finally {
      setBookmarkLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, showToast, t, bookmarkLoading])

  // 打开收藏夹选择弹窗
  const openBookmarkFolderModal = useCallback((postId: string) => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }
    setBookmarkingPostId(postId)
    setShowBookmarkModal(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, showToast])

  // 收藏到指定收藏夹
  const handleBookmarkToFolder = useCallback(async (folderId: string) => {
    if (!accessToken || !bookmarkingPostId) return

    setBookmarkLoading(prev => ({ ...prev, [bookmarkingPostId]: true }))
    
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
        showToast(t('bookmarked'), 'success')
      } else {
        showToast(result.error || t('operationFailed'), 'error')
      }
    } catch (_err) {
      showToast(t('networkError'), 'error')
    } finally {
      setBookmarkLoading(prev => ({ ...prev, [bookmarkingPostId]: false }))
      setShowBookmarkModal(false)
      setBookmarkingPostId(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, bookmarkingPostId, showToast])

  // 转发帖子
  const handleRepost = useCallback(async (postId: string, comment?: string) => {
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    const post = posts.find(p => p.id === postId) || openPost
    if (post?.author_id === currentUserId) {
      showToast(t('cannotRepostOwn'), 'warning')
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
        showToast(t('reposted'), 'success')
      } else {
        showToast(result.error || t('repostFailed'), 'error')
      }
    } catch (err) {
      logger.error('[PostFeed] repost failed:', err)
      showToast(t('networkError'), 'error')
    } finally {
      setRepostLoading(prev => ({ ...prev, [postId]: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, posts, openPost, currentUserId, showToast])

  // 路由
  const router = useRouter()

  // 开始编辑帖子 - 导航到编辑页面
  const handleStartEdit = useCallback((post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    router.push(`/post/${post.id}/edit`)
  }, [router])

  // 保存编辑
  const handleSaveEdit = useCallback(async () => {
    if (!editingPost || !accessToken) return
    if (!editTitle.trim()) {
      showToast(t('titleRequired'), 'warning')
      return
    }

    setSavingEdit(true)
    try {
      const response = await fetch(`/api/posts/${editingPost.id}/edit`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
        body: JSON.stringify({
          title: editTitle.trim(),
          content: editContent.trim(),
        }),
      })

      const data = await response.json()

      if (response.ok) {
        // 更新本地状态
        setPosts(prev => prev.map(p => 
          p.id === editingPost.id 
            ? { ...p, title: editTitle.trim(), content: editContent.trim() }
            : p
        ))
        
        // 如果弹窗打开，也更新
        if (openPost?.id === editingPost.id) {
          setOpenPost(prev => prev ? { ...prev, title: editTitle.trim(), content: editContent.trim() } : null)
        }
        
        setEditingPost(null)
        showToast(t('editSaved'), 'success')
      } else {
        showToast(data.error || t('editFailed'), 'error')
      }
    } catch (err) {
      logger.error('[PostFeed] edit failed:', err)
      showToast(t('editFailed'), 'error')
    } finally {
      setSavingEdit(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingPost, accessToken, editTitle, editContent, openPost?.id, showToast])

  // 删除帖子
  const handleDeletePost = useCallback(async (post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    const confirmed = await showDangerConfirm(t('deletePost'), t('deletePostConfirm'))
    if (!confirmed) return

    try {
      const response = await fetch(`/api/posts/${post.id}/delete`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })

      const data = await response.json()

      if (response.ok) {
        // 从列表中移除
        setPosts(prev => prev.filter(p => p.id !== post.id))
        
        // 如果弹窗打开，关闭它
        if (openPost?.id === post.id) {
          setOpenPost(null)
        }
        
        showToast(t('deleted'), 'success')
      } else {
        showToast(data.error || t('deleteFailed'), 'error')
      }
    } catch (_err) {
      showToast(t('deleteFailed'), 'error')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, openPost?.id, showDangerConfirm, showToast])

  // 置顶帖子
  const handleTogglePin = useCallback(async (post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    
    if (!accessToken) {
      showToast(t('pleaseLogin'), 'warning')
      return
    }

    try {
      const response = await fetch(`/api/posts/${post.id}/pin`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders()
        },
      })

      const data = await response.json()

      if (response.ok && data.success) {
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === post.id) {
            return { ...p, is_pinned: data.data.is_pinned }
          }
          // 如果置顶了一个帖子，取消其他帖子的置顶状态
          if (data.data.is_pinned && p.is_pinned) {
            return { ...p, is_pinned: false }
          }
          return p
        }))
        
        showToast(data.data.message, 'success')
      } else {
        showToast(data.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('operationFailed'), 'error')
    }
  }, [accessToken, showToast, t])

  // 检测文本是否是中文
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1 // 超过10%是中文字符
  }, [])

  // 从内容中提取图片Markdown
  const extractImagesFromContent = useCallback((content: string): string[] => {
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
    const images: string[] = []
    let match
    while ((match = imageRegex.exec(content)) !== null) {
      images.push(match[0])
    }
    return images
  }, [])

  // 从内容中移除图片Markdown（用于翻译）
  const removeImagesFromContent = useCallback((content: string): string => {
    return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '').replace(/\n{3,}/g, '\n\n').trim()
  }, [])

  // 翻译帖子内容（带缓存，一个帖子只消耗一次GPT）
  const translateContent = useCallback(async (postId: string, content: string, targetLang: 'zh' | 'en') => {
    const cacheKey = `${postId}-content-${targetLang}`
    
    // 提取原内容中的图片
    const originalImages = extractImagesFromContent(content)
    
    // 检查本地缓存
    if (translationCache[cacheKey]) {
      // 将原图片追加到缓存的翻译内容后
      let cachedWithImages = translationCache[cacheKey]
      if (originalImages.length > 0 && !cachedWithImages.includes('![')) {
        cachedWithImages += '\n\n' + originalImages.join('\n')
      }
      setTranslatedContent(cachedWithImages)
      setShowingOriginal(false)
      return
    }

    setTranslating(true)
    try {
      // 移除图片后再翻译（避免翻译图片链接）
      const textToTranslate = removeImagesFromContent(content)
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getCsrfHeaders(),
      }
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: textToTranslate,
          targetLang,
          contentType: 'post_content',
          contentId: postId,
        }),
      })
      const data = await response.json()
      
      if (response.ok && data.success && data.data?.translatedText) {
        let translated = data.data.translatedText
        // 将原图片追加到翻译内容后
        if (originalImages.length > 0) {
          translated += '\n\n' + originalImages.join('\n')
        }
        setTranslatedContent(translated)
        setShowingOriginal(false)
        // 本地缓存（不含图片，图片会在读取时动态添加）
        setTranslationCache(prev => ({ ...prev, [cacheKey]: data.data.translatedText }))
      } else {
        showToast(data.error || t('translationFailed'), 'error')
      }
    } catch {
      showToast(t('translationServiceError'), 'error')
    } finally {
      setTranslating(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable
  }, [translationCache, showToast, extractImagesFromContent, removeImagesFromContent, accessToken])

  // 批量翻译帖子标题和内容预览（使用批量API，减少请求次数）
  const translateListPosts = useCallback(async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
    if (translatingList) return

    // 过滤出需要翻译的帖子（标题或内容需要翻译）
    const needsTranslation = postsToTranslate.filter(p => {
      const alreadyTranslated = translatedListPosts[p.id]?.title && translatedListPosts[p.id]?.body
      if (alreadyTranslated) return false

      const titleIsChinese = p.title ? isChineseText(p.title) : false
      const contentIsChinese = p.content ? isChineseText(p.content) : false

      // 检查标题或内容是否需要翻译
      const needsTitleTranslation = p.title && (targetLang === 'en' ? titleIsChinese : !titleIsChinese)
      const needsContentTranslation = p.content && (targetLang === 'en' ? contentIsChinese : !contentIsChinese)

      return needsTitleTranslation || needsContentTranslation
    })

    if (needsTranslation.length === 0) return

    setTranslatingList(true)

    try {
      // 使用批量翻译API（最多10个帖子，每个帖子有标题+内容）
      const items: Array<{ id: string; text: string; contentType: 'post_title' | 'post_content'; contentId: string }> = []

      for (const post of needsTranslation.slice(0, 10)) {
        // 添加标题翻译项
        if (post.title && !translatedListPosts[post.id]?.title) {
          items.push({
            id: `${post.id}_title`,
            text: post.title,
            contentType: 'post_title' as const,
            contentId: post.id,
          })
        }
        // 添加内容预览翻译项（只翻译前200字符以节省API调用）
        if (post.content && !translatedListPosts[post.id]?.body) {
          const contentPreview = removeImagesFromContent(post.content).slice(0, 200)
          if (contentPreview) {
            items.push({
              id: `${post.id}_body`,
              text: contentPreview,
              contentType: 'post_content' as const,
              contentId: post.id,
            })
          }
        }
      }

      if (items.length === 0) {
        setTranslatingList(false)
        return
      }

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()

      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>

        setTranslatedListPosts(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            // 解析ID：postId_title 或 postId_body
            const [postId, type] = id.split('_')
            if (!updated[postId]) {
              updated[postId] = {}
            }
            if (type === 'title') {
              updated[postId].title = result.translatedText
            } else if (type === 'body') {
              updated[postId].body = result.translatedText
            }
          }
          return updated
        })

      }
    } catch {
      // 批量翻译失败，静默处理
    } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts, isChineseText, removeImagesFromContent])

  // 批量翻译评论（使用批量API）
  const translateComments = useCallback(async (commentsToTranslate: Comment[], targetLang: 'zh' | 'en') => {
    if (translatingComments) return
    
    // 收集所有需要翻译的评论和回复
    const allComments: Comment[] = []
    
    commentsToTranslate.forEach(c => {
      // 检查主评论
      if (!translatedComments[c.id] && c.content) {
        const hasChinese = isChineseText(c.content)
        if ((targetLang === 'en' && hasChinese) || (targetLang === 'zh' && !hasChinese)) {
          allComments.push(c)
        }
      }
      // 检查回复
      if (c.replies) {
        c.replies.forEach(r => {
          if (!translatedComments[r.id] && r.content) {
            const hasChinese = isChineseText(r.content)
            if ((targetLang === 'en' && hasChinese) || (targetLang === 'zh' && !hasChinese)) {
              allComments.push(r)
            }
          }
        })
      }
    })
    
    if (allComments.length === 0) return
    
    setTranslatingComments(true)
    
    try {
      // 使用批量翻译API（最多20个）
      const items = allComments.slice(0, 20).map(comment => ({
        id: comment.id,
        text: comment.content || '',
        contentType: 'comment' as const,
        contentId: comment.id,
      }))

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ items, targetLang }),
      })
      const data = await response.json()
      
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string; cached: boolean }>
        
        setTranslatedComments(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = result.translatedText
          }
          return updated
        })
        
      }
    } catch {
      // 评论翻译失败，静默处理
    } finally {
      setTranslatingComments(false)
    }
  }, [translatingComments, translatedComments, isChineseText])

  // 当语言变化时翻译列表帖子和评论
  useEffect(() => {
    if (posts.length > 0) {
      translateListPosts(posts, language as 'zh' | 'en')
    }
    if (comments.length > 0 && openPost) {
      const targetLang = language === 'en' ? 'en' : 'zh'
      translateComments(comments, targetLang)
    }
     
  }, [language, posts, translateListPosts, comments, openPost, translateComments])

  // Memoized sorted posts for author pages (pinned first)
  const sortedPosts = useMemo(() => {
    if (!props.authorHandle) return posts
    return [...posts].sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1
      if (!a.is_pinned && b.is_pinned) return 1
      return 0
    })
  }, [posts, props.authorHandle])

  // 打开帖子详情
  const handleOpenPost = useCallback((post: Post) => {
    setOpenPost(post)
    setComments([])
    setTranslatedContent(null)
    loadComments(post.id)
    // 如果帖子有关联的自定义投票，加载它
    if (post.poll_id) {
      loadCustomPoll(post.id)
    } else {
      setCustomPoll(null)
      setCustomPollUserVotes([])
      setSelectedPollOptions([])
    }

    // 检测是否需要翻译
    const contentIsChinese = post.content ? isChineseText(post.content) : false
    const titleIsChinese = post.title ? isChineseText(post.title) : false
    const needsContentTranslation = post.content && ((language === 'en' && contentIsChinese) || (language === 'zh' && !contentIsChinese))
    const needsTitleTranslation = post.title && ((language === 'en' && titleIsChinese) || (language === 'zh' && !titleIsChinese))
    const hasTranslatedTitle = !!translatedListPosts[post.id]?.title
    
    // 如果有翻译需求或已有翻译，默认显示翻译版本
    if (needsContentTranslation || needsTitleTranslation || hasTranslatedTitle) {
      setShowingOriginal(false)
    } else {
      setShowingOriginal(true)
    }

    // 自动检测并翻译内容
    if (needsContentTranslation) {
      translateContent(post.id, post.content!, language)
    }
    
    // 翻译标题（如果还没翻译过）
    if (!hasTranslatedTitle && needsTitleTranslation) {
      translateListPosts([post], language as 'zh' | 'en')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadComments, language, isChineseText, translateContent, translatedListPosts, translateListPosts])

  if (loading) {
    return (
      <div className="stagger-children" style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        <PostSkeleton />
        <PostSkeleton />
        <PostSkeleton />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        padding: tokens.spacing[6],
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[3],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <div style={{
          color: tokens.colors.accent.error,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.bold,
        }}>
          {t('failedToLoad')}
        </div>
        <div style={{
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.xs,
        }}>
          {error}
        </div>
        <button
          onClick={loadPosts}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            background: tokens.colors.accent.primary,
            color: tokens.colors.white,
            border: 'none',
            borderRadius: tokens.radius.md,
            cursor: 'pointer',
            fontWeight: tokens.typography.fontWeight.bold,
            fontSize: tokens.typography.fontSize.sm,
            transition: tokens.transition.base,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9' }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
        >
          {t('tryAgain')}
        </button>
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div>
        {props.showSortButtons && <SortButtons sortType={sortType} setSortType={setSortType} t={t} />}
        <div style={{
          padding: tokens.spacing[6],
          textAlign: 'center',
          color: tokens.colors.text.tertiary,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[2],
        }}>
          <span>{t('noPostsYet')}</span>
          <span style={{ fontSize: tokens.typography.fontSize.xs }}>
            {t('beFirstToPost')}
          </span>
        </div>
      </div>
    )
  }

  return (
    <SectionErrorBoundary>
      {/* 刷新按钮 */}
      {props.showRefreshButton && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: tokens.spacing[2] }}>
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              cursor: refreshing ? 'not-allowed' : 'pointer',
              opacity: refreshing ? 0.6 : 1,
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => { if (!refreshing) e.currentTarget.style.background = tokens.colors.bg.tertiary }}
            onMouseLeave={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
              }}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
            {refreshing ? t('refreshing') : t('refresh')}
          </button>
        </div>
      )}
      {props.showSortButtons && <SortButtons sortType={sortType} setSortType={setSortType} t={t} />}
      {/* 移动端视图切换按钮 */}
      {props.layout === 'masonry' && (
        <div className="mobile-only" style={{ display: 'none', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button
            onClick={() => setMobileViewMode(prev => prev === 'list' ? 'masonry' : 'list')}
            aria-label={mobileViewMode === 'list' ? (language === 'zh' ? '切换为瀑布流' : 'Switch to grid') : (language === 'zh' ? '切换为列表' : 'Switch to list')}
            style={{
              padding: '6px 12px',
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: 'transparent',
              color: tokens.colors.text.secondary,
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {mobileViewMode === 'list' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            )}
            {mobileViewMode === 'list' ? (language === 'zh' ? '瀑布流' : 'Grid') : (language === 'zh' ? '列表' : 'List')}
          </button>
        </div>
      )}
      <div style={props.layout === 'masonry' ? { columnGap: 12 } : undefined} className={`stagger-children${props.layout === 'masonry' ? ' post-feed-masonry' : ''} ${props.layout === 'masonry' ? `mobile-view-${mobileViewMode}` : ''}`}>
        {/* 只在个人主页（有 authorHandle）时才将置顶帖子排在最上面 */}
        {sortedPosts.map((p) => (
          <PostListItem
            key={p.id}
            post={p}
            isMasonry={props.layout === 'masonry'}
            language={language}
            currentUserId={currentUserId}
            translatedListPosts={translatedListPosts}
            onOpenPost={handleOpenPost}
            onToggleReaction={toggleReaction}
            onTogglePin={handleTogglePin}
            onStartEdit={handleStartEdit}
            onDeletePost={handleDeletePost}
            removeImagesFromContent={removeImagesFromContent}
            t={t}
          />
        ))}
      </div>

      {/* Infinite scroll trigger */}
      {hasMore && (
        <div
          ref={loadMoreRef}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: tokens.spacing[4],
            minHeight: 60,
          }}
        >
          {loadingMore && (
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke={tokens.colors.text.tertiary}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ animation: 'spin 1s linear infinite' }}
              >
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span style={{ fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
                {t('loadingMore')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* No more posts indicator */}
      {!hasMore && posts.length > 0 && (
        <div
          style={{
            textAlign: 'center',
            padding: tokens.spacing[4],
            color: tokens.colors.text.tertiary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          {t('noMorePosts')}
        </div>
      )}

      {openPost && (
        <PostModal onClose={() => setOpenPost(null)}>
          {openPost.group_name && (
            openPost.group_id ? (
              <Link
                href={`/groups/${openPost.group_id}`}
                style={{
                  fontSize: 12,
                  color: ARENA_PURPLE,
                  textDecoration: 'none',
                  fontWeight: 600,
                  padding: '2px 8px',
                  background: `${ARENA_PURPLE}20`,
                  borderRadius: tokens.radius.sm,
                  display: 'inline-block',
                }}
              >
                {language === 'zh' ? openPost.group_name : (openPost.group_name_en || openPost.group_name)}
              </Link>
            ) : (
              <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
                {language === 'zh' ? openPost.group_name : (openPost.group_name_en || openPost.group_name)}

              </div>
            )
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <div style={{ 
              fontSize: 20, 
              fontWeight: 900, 
              lineHeight: 1.25,
              color: !showingOriginal && translatedListPosts[openPost.id]?.title 
                ? tokens.colors.accent.translated 
                : tokens.colors.text.primary,
            }}>
              {showingOriginal 
                ? openPost.title 
                : (translatedListPosts[openPost.id]?.title || openPost.title)
              }
            </div>
            <AvatarLink handle={openPost.author_handle} avatarUrl={openPost.author_avatar_url} isPro={openPost.author_is_pro} showProBadge={openPost.author_show_pro_badge} />
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 6 }}>
            {openPost.author_handle ? (
              <Link
                href={`/u/${encodeURIComponent(openPost.author_handle)}`}
                style={{
                  color: tokens.colors.text.secondary,
                  textDecoration: 'none',
                  fontWeight: 700,
                }}
              >
                @{openPost.author_handle}
              </Link>
            ) : (
              <span>user</span>
            )}
            <LevelBadge exp={openPost.author_exp || 0} size="sm" />
            <span>·</span>
            <span>{formatTimeAgo(openPost.created_at, language)}</span>
            <span>·</span>
            <CommentIcon size={12} />
            <span>{openPost.comment_count}</span>
          </div>

          <div translate="no" style={{ 
            marginTop: 12, 
            fontSize: 14, 
            color: !showingOriginal && translatedContent 
              ? tokens.colors.accent.translated 
              : tokens.colors.text.primary, 
            lineHeight: 1.7, 
            whiteSpace: 'pre-wrap' 
          }}>
            {showingOriginal 
              ? renderContentWithLinks(openPost.content || '')
              : renderContentWithLinks(translatedContent || openPost.content || '')
            }
          </div>

          {/* 原始帖子引用卡片（转发时显示） */}
          {openPost.original_post && (
            <div 
              style={{ 
                marginTop: 12,
                padding: 12,
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.secondary}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>{t('repostedFrom')}</span>
                <AvatarLink handle={openPost.original_post.author_handle} avatarUrl={openPost.original_post.author_avatar_url} isPro={openPost.original_post.author_is_pro} showProBadge={openPost.original_post.author_show_pro_badge} />
              </div>
              {openPost.original_post.title && (
                <div style={{ 
                  fontSize: 14, 
                  color: tokens.colors.text.primary,
                  fontWeight: 600,
                  marginBottom: 6,
                }}>
                  {openPost.original_post.title}
                </div>
              )}
              <div style={{ 
                fontSize: 13, 
                color: tokens.colors.text.secondary,
                lineHeight: 1.5,
              }}>
                {removeImagesFromContent(openPost.original_post.content).slice(0, 200)}
                {openPost.original_post.content.length > 200 && '...'}
              </div>
              {/* 原始帖子图片预览 */}
              {openPost.original_post.images && openPost.original_post.images.length > 0 && (
                <div style={{ 
                  marginTop: 10, 
                  display: 'flex', 
                  gap: 6,
                  flexWrap: 'wrap',
                }}>
                  {openPost.original_post.images.slice(0, 4).map((imgUrl, idx) => (
                    <div
                      key={idx}
                      style={{
                        width: 80,
                        height: 80,
                        borderRadius: tokens.radius.md,
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}
                    >
                      <img
                        src={imgUrl}
                        alt="Post image"
                        width={80}
                        height={80}
                        loading="lazy"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    </div>
                  ))}
                  {openPost.original_post.images.length > 4 && (
                    <span style={{ fontSize: 12, color: tokens.colors.text.tertiary, alignSelf: 'center' }}>
                      +{openPost.original_post.images.length - 4}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 翻译/原文切换按钮 - 有翻译内容或翻译标题时显示 */}
          {(translatedContent || translatedListPosts[openPost.id]?.title || translating) && (
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                onClick={() => setShowingOriginal(!showingOriginal)}
                disabled={translating}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.tertiary,
                  color: tokens.colors.text.secondary,
                  cursor: translating ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {translating ? (
                  <>{t('translating')}</>
                ) : showingOriginal ? (
                  <>{t('viewTranslation')}</>
                ) : (
                  <>{t('viewOriginal')}</>
                )}
              </button>
              {!showingOriginal && (
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                  {t('translatedByAI')}
                </span>
              )}
            </div>
          )}

          {/* 自定义投票组件 */}
          {openPost.poll_id && (
            <CustomPollCard
              poll={customPoll}
              loading={loadingCustomPoll}
              userVotes={customPollUserVotes}
              selectedOptions={selectedPollOptions}
              onSelectOption={(index) => {
                if (customPoll?.type === 'single') {
                  setSelectedPollOptions([index])
                } else {
                  setSelectedPollOptions(prev =>
                    prev.includes(index)
                      ? prev.filter(i => i !== index)
                      : [...prev, index]
                  )
                }
              }}
              onSubmitVote={() => submitCustomPollVote(openPost.id)}
              votingInProgress={votingCustomPoll}
              language={language}
              t={t}
            />
          )}

          <PostDetailActions
            postId={openPost.id}
            authorId={openPost.author_id}
            currentUserId={currentUserId}
            userReaction={openPost.user_reaction}
            likeCount={openPost.like_count}
            dislikeCount={openPost.dislike_count}
            isBookmarked={userBookmarks[openPost.id] || false}
            bookmarkCount={bookmarkCounts[openPost.id] || 0}
            accessToken={accessToken}
            onToggleReaction={toggleReaction}
            onBookmark={handleBookmark}
            onOpenBookmarkFolder={openBookmarkFolderModal}
            onRepost={(id) => setShowRepostModal(id)}
            showToast={showToast}
            t={t}
          />

          {/* 评论区 */}
          <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.colors.border.secondary}`, paddingTop: 16 }}>
            <CommentsModal
              postId={openPost.id}
              comments={comments}
              loadingComments={loadingComments}
              currentUserId={currentUserId}
              newComment={newComment}
              setNewComment={setNewComment}
              submittingComment={submittingComment}
              onSubmitComment={submitComment}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              replyContent={replyContent}
              setReplyContent={setReplyContent}
              submittingReply={submittingReply}
              onSubmitReply={submitReply}
              commentLikeLoading={commentLikeLoading}
              onToggleCommentLike={toggleCommentLike}
              onToggleCommentDislike={toggleCommentDislike}
              deletingCommentId={deletingCommentId}
              onDeleteComment={deleteComment}
              expandedReplies={expandedReplies}
              setExpandedReplies={setExpandedReplies}
              translatedComments={translatedComments}
            />
          </div>
        </PostModal>
      )}

      {/* 编辑帖子弹窗 */}
      {editingPost && (
        <EditPostModal
          title={editTitle}
          content={editContent}
          onTitleChange={setEditTitle}
          onContentChange={setEditContent}
          onSave={handleSaveEdit}
          onCancel={() => setEditingPost(null)}
          saving={savingEdit}
          t={t}
        />
      )}

      {/* 转发弹窗 */}
      {showRepostModal && (
        <RepostModal
          postId={showRepostModal}
          comment={repostComment}
          onCommentChange={setRepostComment}
          onRepost={handleRepost}
          onCancel={() => {
            setShowRepostModal(null)
            setRepostComment('')
          }}
          loading={repostLoading[showRepostModal] || false}
          t={t}
        />
      )}

      {/* 收藏夹选择弹窗 */}
      <BookmarkModal
        isOpen={showBookmarkModal}
        onClose={() => {
          setShowBookmarkModal(false)
          setBookmarkingPostId(null)
        }}
        onSelect={handleBookmarkToFolder}
        postId={bookmarkingPostId || ''}
      />
    </SectionErrorBoundary>
  )
}