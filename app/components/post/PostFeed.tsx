'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../icons'
import { useLanguage } from '../Providers/LanguageProvider'
// Note: supabase import removed - using REST API instead
import { formatTimeAgo } from '@/lib/utils/date'
import { type PollChoice, type PostWithUserState } from '@/lib/types'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { getCsrfHeaders } from '@/lib/api/client'
import { DynamicBookmarkModal as BookmarkModal, DynamicCommentsModal as CommentsModal } from '../ui/dynamic'
import { useUnifiedAuth } from '@/lib/hooks/useUnifiedAuth'
import { usePostStore, type PostData } from '@/lib/stores/postStore'
import { renderContentWithLinks, ARENA_PURPLE } from '@/lib/utils/content'
import { usePostComments, type Comment } from './hooks/usePostComments'
import { SectionErrorBoundary } from '../Utils/ErrorBoundary'
import { PostSkeleton } from '../ui/Skeleton'

// 本地类型（扩展后端类型）
type Post = PostWithUserState



// Sort buttons component to avoid duplication
function SortButtons({ sortType, setSortType, language }: {
  sortType: SortType
  setSortType: (type: SortType) => void
  language: string
}): React.ReactNode {
  const getSortButtonStyle = (isActive: boolean) => ({
    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
    borderRadius: tokens.radius.md,
    border: `1px solid ${isActive ? ARENA_PURPLE : tokens.colors.border.primary}`,
    background: isActive ? 'rgba(139, 111, 168, 0.15)' : tokens.colors.bg.primary,
    color: isActive ? tokens.colors.text.primary : tokens.colors.text.secondary,
    fontSize: tokens.typography.fontSize.xs,
    fontWeight: isActive ? 700 : 400,
    cursor: 'pointer',
  })

  return (
    <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
      <button onClick={() => setSortType('time')} style={getSortButtonStyle(sortType === 'time')}>
        {language === 'zh' ? '最新' : 'Latest'}
      </button>
      <button onClick={() => setSortType('likes')} style={getSortButtonStyle(sortType === 'likes')}>
        {language === 'zh' ? '最热' : 'Hot'}
      </button>
    </div>
  )
}

function AvatarLink({ handle, avatarUrl, isPro, showProBadge = true }: { handle?: string | null; avatarUrl?: string | null; isPro?: boolean; showProBadge?: boolean }) {
  if (!handle) return null
  const href = `/u/${encodeURIComponent(handle)}`
  const shouldShowBadge = isPro && showProBadge
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        textDecoration: 'none',
        color: tokens.colors.text.primary,
        flexShrink: 0,
        maxWidth: 120,
      }}
      title="进入交易者主页"
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: tokens.radius.md,
          display: 'grid',
          placeItems: 'center',
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          fontWeight: tokens.typography.fontWeight.black,
          fontSize: tokens.typography.fontSize.xs,
          transition: `all ${tokens.transition.base}`,
          overflow: 'hidden',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'scale(1.1)'
          e.currentTarget.style.boxShadow = tokens.shadow.sm
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)'
          e.currentTarget.style.boxShadow = tokens.shadow.none
        }}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt={handle} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          (handle?.[0] || 'U').toUpperCase()
        )}
      </span>
      <span style={{ fontWeight: 850, fontSize: 12, color: tokens.colors.text.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{handle}</span>
      {shouldShowBadge && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: 'var(--color-pro-badge-bg)',
            boxShadow: '0 0 4px var(--color-pro-badge-shadow)',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="#fff">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
        </span>
      )}
    </Link>
  )
}

type SortType = 'time' | 'likes'

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

  // Listen to feed refresh trigger from store
  const feedRefreshTrigger = usePostStore(s => s.feedRefreshTrigger)
  // Unified auth - single source of truth
  const auth = useUnifiedAuth({
    onUnauthenticated: () => showToast('请先登录', 'warning'),
  })
  const accessToken = auth.accessToken
  const currentUserId = auth.userId
  const [editingPost, setEditingPost] = useState<Post | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const lockRef = useRef<Set<string>>(new Set())
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
    loadComments, submitComment, toggleCommentLike, submitReply, deleteComment } = commentsHook

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
  // Note: bookmarkLoading state tracks loading but value is not currently displayed in UI
  const [, setBookmarkLoading] = useState<Record<string, boolean>>({})
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
          : (data.error?.message || '获取帖子失败')
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
        author_handle: p.author_handle || '匿名',
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
      const errorMessage = err instanceof Error ? err.message : '加载失败'
      setError(errorMessage)
    } finally {
      // 只有在当前请求完成时才更新loading状态
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    }
  }, [props.groupId, props.authorHandle, accessToken, sortType, pageSize])

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
        throw new Error(data.error || '加载更多失败')
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
      console.error('加载更多失败:', err)
    } finally {
      setLoadingMore(false)
    }
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
    showToast(language === 'zh' ? '已刷新' : 'Refreshed', 'success')
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

  useEffect(() => {
    loadPosts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.groupId, props.authorHandle, accessToken, sortType])

  // Listen to feed refresh trigger from store (triggered by TopNav groups click)
  useEffect(() => {
    if (feedRefreshTrigger > 0) {
      loadPosts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRefreshTrigger])

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
          .catch((err) => { console.error('Failed to load comments:', err) })
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
                title: post.title || '无标题',
                content: post.content || '',
                author_id: post.author_id,
                author_handle: post.author_handle || '匿名',
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
                .catch((err) => { console.error('Failed to load comments:', err) })
            }
          } catch (err) {
            console.error('Failed to load single post:', err)
          }
        }
        loadSinglePost()
      }
    }
  }, [props.initialPostId, posts, openPost])

  // 点赞/踩 - per-postId lock (waits for API response before allowing next action)
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    const key = `react-${postId}-${reactionType}`
    if (lockRef.current.has(key)) return
    lockRef.current.add(key)

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
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              like_count: result.like_count,
              dislike_count: result.dislike_count,
              user_reaction: result.reaction,
            }
          }
          return p
        }))

        // Also update canonical store
        usePostStore.getState().updatePostReaction(postId, {
          like_count: result.like_count,
          dislike_count: result.dislike_count,
          reaction: result.reaction,
        })

        // 如果弹窗打开，也更新弹窗中的帖子
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? {
            ...prev,
            like_count: result.like_count,
            dislike_count: result.dislike_count,
            user_reaction: result.reaction,
          } : null)
        }
      } else {
        // FIX: Show error toast when API returns error
        const errorMsg = json.error || json.message || '操作失败'
        showToast(errorMsg, 'error')
      }
    } catch (err) {
      // FIX: Show error toast for network/unexpected errors
      console.error('[PostFeed] toggleReaction error:', err)
      showToast('网络错误，请重试', 'error')
    } finally {
      lockRef.current.delete(key)
    }
  }, [accessToken, openPost?.id, showToast])

  // Built-in poll voting (bull/bear/wait) - preserved for future use
   
  const _toggleVote = useCallback(async (postId: string, choice: PollChoice) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
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
        const errorMsg = json.error || json.message || '投票失败'
        showToast(errorMsg, 'error')
      }
    } catch (err) {
      // FIX: Show error toast for network/unexpected errors
      console.error('[PostFeed] toggleVote error:', err)
      showToast('网络错误，请重试', 'error')
    } finally {
      lockRef.current.delete(key)
    }
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
      showToast('请先登录', 'warning')
      return
    }
    if (selectedPollOptions.length === 0) {
      showToast('请选择至少一个选项', 'warning')
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
        showToast('已投票', 'success')
      } else {
        showToast(data.error || '投票失败', 'error')
      }
    } catch (err) {
      console.error('[PostFeed] 自定义投票失败:', err)
      showToast('投票失败', 'error')
    } finally {
      setVotingCustomPoll(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, selectedPollOptions])

  // 收藏帖子 - 点击收藏到默认收藏夹，已收藏则取消收藏
  const handleBookmark = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

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
        showToast(result.bookmarked ? '已收藏' : '已取消收藏', 'success')
      } else {
        showToast(result.error || '操作失败', 'error')
      }
    } catch (_err) {
      // 错误已在 showToast 中处理
      showToast('网络错误', 'error')
    } finally {
      setBookmarkLoading(prev => ({ ...prev, [postId]: false }))
    }
  }, [accessToken, showToast])

  // 打开收藏夹选择弹窗
  const openBookmarkFolderModal = useCallback((postId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }
    setBookmarkingPostId(postId)
    setShowBookmarkModal(true)
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
        showToast('已收藏', 'success')
      } else {
        showToast(result.error || '操作失败', 'error')
      }
    } catch (_err) {
      // 错误已在 showToast 中处理
      showToast('网络错误', 'error')
    } finally {
      setBookmarkLoading(prev => ({ ...prev, [bookmarkingPostId]: false }))
      setShowBookmarkModal(false)
      setBookmarkingPostId(null)
    }
  }, [accessToken, bookmarkingPostId, showToast])

  // 转发帖子
  const handleRepost = useCallback(async (postId: string, comment?: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    // 检查是否是自己的帖子
    const post = posts.find(p => p.id === postId) || openPost
    if (post?.author_id === currentUserId) {
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
      console.error('[PostFeed] 转发失败:', err)
      showToast('网络错误', 'error')
    } finally {
      setRepostLoading(prev => ({ ...prev, [postId]: false }))
    }
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
      showToast('标题不能为空', 'warning')
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
        showToast('已保存', 'success')
      } else {
        showToast(data.error || '编辑失败', 'error')
      }
    } catch (err) {
      console.error('[PostFeed] 编辑失败:', err)
      showToast('编辑失败', 'error')
    } finally {
      setSavingEdit(false)
    }
  }, [editingPost, accessToken, editTitle, editContent, openPost?.id, showToast])

  // 删除帖子
  const handleDeletePost = useCallback(async (post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    const confirmed = await showDangerConfirm('删除帖子', '确定要删除这篇帖子吗？删除后无法恢复。')
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
        
        showToast('已删除', 'success')
      } else {
        showToast(data.error || '删除失败', 'error')
      }
    } catch (_err) {
      // 错误已在 showToast 中处理
      showToast('删除失败', 'error')
    }
  }, [accessToken, openPost?.id, showDangerConfirm, showToast])

  // 置顶帖子
  const handleTogglePin = useCallback(async (post: Post, e: React.MouseEvent) => {
    e.stopPropagation()
    
    if (!accessToken) {
      showToast('请先登录', 'warning')
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
        showToast(data.error || '操作失败', 'error')
      }
    } catch {
      showToast('操作失败', 'error')
    }
  }, [accessToken, showToast])

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
        showToast(data.error || '翻译失败', 'error')
      }
    } catch {
      showToast('翻译服务出错', 'error')
    } finally {
      setTranslating(false)
    }
  }, [translationCache, showToast, extractImagesFromContent, removeImagesFromContent])

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

  // 当语言变化时翻译列表帖子
  useEffect(() => {
    if (posts.length > 0) {
      translateListPosts(posts, language as 'zh' | 'en')
    }
  }, [language, posts, translateListPosts])

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

  // 当评论加载或语言变化时翻译评论
  useEffect(() => {
    if (comments.length > 0 && openPost) {
      const targetLang = language === 'en' ? 'en' : 'zh'
      translateComments(comments, targetLang)
    }
  }, [comments, language, openPost, translateComments])

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
          {language === 'zh' ? '加载失败' : 'Failed to load'}
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
            color: '#fff',
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
        {props.showSortButtons && <SortButtons sortType={sortType} setSortType={setSortType} language={language} />}
        <div style={{
          padding: tokens.spacing[6],
          textAlign: 'center',
          color: tokens.colors.text.tertiary,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[2],
        }}>
          <span>{language === 'zh' ? '暂无帖子' : 'No posts yet'}</span>
          <span style={{ fontSize: tokens.typography.fontSize.xs }}>
            {language === 'zh' ? '成为第一个发帖的人吧！' : 'Be the first to post!'}
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
            {refreshing ? (language === 'zh' ? '刷新中...' : 'Refreshing...') : (language === 'zh' ? '刷新' : 'Refresh')}
          </button>
        </div>
      )}
      {props.showSortButtons && <SortButtons sortType={sortType} setSortType={setSortType} language={language} />}
      <div style={props.layout === 'masonry' ? { columnGap: 12 } : undefined} className={`stagger-children${props.layout === 'masonry' ? ' post-feed-masonry' : ''}`}>
        {/* 只在个人主页（有 authorHandle）时才将置顶帖子排在最上面 */}
        {(props.authorHandle ? [...posts].sort((a, b) => {
          // 置顶帖子优先（仅在个人主页生效）
          if (a.is_pinned && !b.is_pinned) return -1
          if (!a.is_pinned && b.is_pinned) return 1
          return 0
        }) : posts).map((p) => {
          const isMasonry = props.layout === 'masonry'

          return (
            <div
              key={p.id}
              onClick={(e: React.MouseEvent) => {
                // Don't hijack clicks on interactive elements (links, buttons, etc.)
                if ((e.target as HTMLElement).closest('a, button, [role="button"], input, textarea, select')) return
                handleOpenPost(p)
              }}
              style={isMasonry ? {
                breakInside: 'avoid',
                marginBottom: 10,
                padding: tokens.spacing[2],
                borderRadius: tokens.radius.lg,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                color: tokens.colors.text.primary,
                transition: 'transform 0.2s ease, box-shadow 0.2s ease',
              } : {
                width: '100%',
                textAlign: 'left',
                border: 'none',
                background: 'transparent',
                padding: `${tokens.spacing[3]} 0`,
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                cursor: 'pointer',
                color: tokens.colors.text.primary,
                transition: `background-color ${tokens.transition.base}`,
              }}
              onMouseEnter={(e) => {
                if (isMasonry) {
                  e.currentTarget.style.transform = 'translateY(-2px)'
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(139,111,168,0.15)'
                } else {
                  e.currentTarget.style.background = tokens.colors.bg.secondary
                }
              }}
              onMouseLeave={(e) => {
                if (isMasonry) {
                  e.currentTarget.style.transform = 'translateY(0)'
                  e.currentTarget.style.boxShadow = 'none'
                } else {
                  e.currentTarget.style.background = 'transparent'
                }
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
                {p.group_id ? (
                  <Link
                    href={`/groups/${p.group_id}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      fontSize: 12,
                      color: ARENA_PURPLE,
                      textDecoration: 'none',
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flexShrink: 1,
                      minWidth: 0,
                    }}
                  >
                    {language === 'zh' ? (p.group_name || '小组') : (p.group_name_en || p.group_name || 'Group')}
                  </Link>
                ) : null}
                <AvatarLink handle={p.author_handle} avatarUrl={p.author_avatar_url} isPro={p.author_is_pro} showProBadge={p.author_show_pro_badge} />
              </div>

              <div style={{ marginTop: 6, fontWeight: 950, lineHeight: 1.25, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ color: translatedListPosts[p.id]?.title ? tokens.colors.accent.translated : tokens.colors.text.primary }}>
                  {translatedListPosts[p.id]?.title || p.title}
                </span>
                {/* 自定义投票标识 */}
                {p.poll_id && (
                  <span
                    style={{
                      fontSize: 11,
                      color: ARENA_PURPLE,
                      fontWeight: 700,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'rgba(139,111,168,0.1)',
                    }}
                  >
                    {language === 'zh' ? '投票' : 'Poll'}
                  </span>
                )}
                {/* 图片标识 */}
                {p.images && p.images.length > 0 && (
                  <span
                    style={{
                      fontSize: 11,
                      color: tokens.colors.text.tertiary,
                      fontWeight: 600,
                    }}
                  >
                    {p.images.length} {language === 'zh' ? '图' : 'img'}
                  </span>
                )}
              </div>

              {/* 内容预览 - 移除图片 Markdown 语法 */}
              {p.content && (
                <div style={{ 
                  marginTop: 8, 
                  fontSize: 13, 
                  color: translatedListPosts[p.id]?.body ? tokens.colors.accent.translated : tokens.colors.text.secondary, 
                  lineHeight: 1.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}>
                  {removeImagesFromContent(translatedListPosts[p.id]?.body || p.content).slice(0, 150)}
                </div>
              )}

              {/* 图片预览 - 最多显示4张 */}
              {p.images && p.images.length > 0 && (
                <div style={{ 
                  marginTop: 10, 
                  display: 'flex', 
                  gap: 8,
                  flexWrap: 'wrap',
                }}>
                  {p.images.slice(0, 4).map((imgUrl, idx) => (
                    <div
                      key={idx}
                      style={{
                        width: p.images!.length === 1 ? 200 : 80,
                        height: p.images!.length === 1 ? 150 : 80,
                        borderRadius: 8,
                        overflow: 'hidden',
                        position: 'relative',
                      }}
                    >
                      <img
                        src={imgUrl}
                        alt={`Image ${idx + 1}`}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
                      />
                      {idx === 3 && p.images!.length > 4 && (
                        <div style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'rgba(0,0,0,0.5)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#fff',
                          fontSize: 14,
                          fontWeight: 700,
                        }}>
                          +{p.images!.length - 4}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* 原始帖子引用卡片（转发时显示） */}
              {p.original_post && (
                <div 
                  style={{ 
                    marginTop: 10,
                    padding: 12,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div style={{ marginBottom: 8 }}>
                    <AvatarLink handle={p.original_post.author_handle} avatarUrl={p.original_post.author_avatar_url} isPro={p.original_post.author_is_pro} showProBadge={p.original_post.author_show_pro_badge} />
                  </div>
                  {p.original_post.title && (
                    <div style={{ 
                      fontSize: 13, 
                      color: tokens.colors.text.primary,
                      fontWeight: 600,
                      marginBottom: 4,
                    }}>
                      {p.original_post.title}
                    </div>
                  )}
                  <div style={{ 
                    fontSize: 12, 
                    color: tokens.colors.text.secondary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {removeImagesFromContent(p.original_post.content).slice(0, 100)}
                  </div>
                  {/* 原始帖子图片预览 */}
                  {p.original_post.images && p.original_post.images.length > 0 && (
                    <div style={{ 
                      marginTop: 8, 
                      display: 'flex', 
                      gap: 4,
                    }}>
                      {p.original_post.images.slice(0, 3).map((imgUrl, idx) => (
                        <div
                          key={idx}
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 4,
                            overflow: 'hidden',
                          }}
                        >
                          <img
                            src={imgUrl}
                            alt=""
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                            }}
                          />
                        </div>
                      ))}
                      {p.original_post.images.length > 3 && (
                        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary, alignSelf: 'center' }}>
                          +{p.original_post.images.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginTop: 10, display: 'flex', gap: 10, flexWrap: 'wrap', color: tokens.colors.text.secondary, fontSize: 12, alignItems: 'center' }}>
                <ReactButton
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleReaction(p.id, 'up')
                  }}
                  active={p.user_reaction === 'up'}
                  icon={<ThumbsUpIcon size={14} />}
                  count={p.like_count}
                  showCount={true}
                />
                <ReactButton
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleReaction(p.id, 'down')
                  }}
                  active={p.user_reaction === 'down'}
                  icon={<ThumbsDownIcon size={14} />}
                  count={p.dislike_count}
                  showCount={false}
                />
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CommentIcon size={14} /> {p.comment_count}
                </span>
                <span style={{ color: tokens.colors.text.tertiary }}>
                  {formatTimeAgo(p.created_at, language)}
                </span>
                
                {/* 置顶标识 */}
                {p.is_pinned && (
                  <span style={{
                    fontSize: 11,
                    color: ARENA_PURPLE,
                    fontWeight: 700,
                    padding: '2px 6px',
                    background: 'rgba(139,111,168,0.1)',
                    borderRadius: 4,
                  }}>
                    {language === 'zh' ? '置顶' : 'Pinned'}
                  </span>
                )}
                
                {/* 置顶/编辑/删除按钮 - 仅作者可见 */}
                {currentUserId && p.author_id === currentUserId && (
                  <span style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                    <button
                      onClick={(e) => handleTogglePin(p, e)}
                      style={{
                        background: p.is_pinned ? 'rgba(139,111,168,0.1)' : 'transparent',
                        border: 'none',
                        color: p.is_pinned ? ARENA_PURPLE : tokens.colors.text.tertiary,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = ARENA_PURPLE
                        e.currentTarget.style.background = 'rgba(139,111,168,0.1)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = p.is_pinned ? ARENA_PURPLE : tokens.colors.text.tertiary
                        e.currentTarget.style.background = p.is_pinned ? 'rgba(139,111,168,0.1)' : 'transparent'
                      }}
                    >
                      {p.is_pinned ? (language === 'zh' ? '取消置顶' : 'Unpin') : (language === 'zh' ? '置顶' : 'Pin')}
                    </button>
                    <button
                      onClick={(e) => handleStartEdit(p, e)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.tertiary,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = '#8b6fa8'
                        e.currentTarget.style.background = 'rgba(139,111,168,0.1)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = tokens.colors.text.tertiary
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {language === 'zh' ? '编辑' : 'Edit'}
                    </button>
                    <button
                      onClick={(e) => handleDeletePost(p, e)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.tertiary,
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '2px 6px',
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = '#ff4d4d'
                        e.currentTarget.style.background = 'rgba(255,77,77,0.1)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = tokens.colors.text.tertiary
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {language === 'zh' ? '删除' : 'Delete'}
                    </button>
                  </span>
                )}
              </div>
            </div>
          )
        })}
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
                {language === 'zh' ? '加载更多...' : 'Loading more...'}
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
          {language === 'zh' ? '已经到底啦' : 'No more posts'}
        </div>
      )}

      {openPost && (
        <Modal onClose={() => setOpenPost(null)}>
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
              fontWeight: 950, 
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
              <span>{language === 'zh' ? '匿名' : 'Anonymous'}</span>
            )}
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
                borderRadius: 10,
                border: `1px solid ${tokens.colors.border.secondary}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>{language === 'zh' ? '转发自' : 'Reposted from'}</span>
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
                        borderRadius: 8,
                        overflow: 'hidden',
                        flexShrink: 0,
                      }}
                    >
                      <img
                        src={imgUrl}
                        alt=""
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                        }}
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
                  borderRadius: 6,
                  background: tokens.colors.bg.tertiary,
                  color: tokens.colors.text.secondary,
                  cursor: translating ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {translating ? (
                  <>{language === 'zh' ? '翻译中...' : 'Translating...'}</>
                ) : showingOriginal ? (
                  <>{language === 'zh' ? '查看翻译' : 'View Translation'}</>
                ) : (
                  <>{language === 'zh' ? '查看原文' : 'View Original'}</>
                )}
              </button>
              {!showingOriginal && (
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                  {language === 'zh' ? '由 AI 翻译' : 'Translated by AI'}
                </span>
              )}
            </div>
          )}

          {/* 自定义投票组件 */}
          {openPost.poll_id && (
            <div style={{ 
              marginTop: 16, 
              padding: 16, 
              background: tokens.colors.bg.secondary, 
              borderRadius: 12,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}>
              {loadingCustomPoll ? (
                <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>加载投票中...</div>
              ) : customPoll ? (
                <>
                  <div style={{ fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {customPoll.question || '投票'}
                    {customPoll.endAt && (
                      <span style={{ 
                        fontSize: 11, 
                        color: customPoll.isExpired ? '#ff6b6b' : tokens.colors.text.tertiary,
                        fontWeight: 400,
                      }}>
                        {customPoll.isExpired 
                          ? '（已结束）' 
                          : `（截止：${new Date(customPoll.endAt).toLocaleString('zh-CN')}）`
                        }
                      </span>
                    )}
                    {!customPoll.endAt && (
                      <span style={{ fontSize: 11, color: ARENA_PURPLE, fontWeight: 400 }}>（永久）</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {customPoll.options.map((option, index) => {
                      const isSelected = selectedPollOptions.includes(index)
                      const hasVoted = customPollUserVotes.includes(index)
                      const votePercentage = customPoll.showResults && customPoll.totalVotes && option.votes !== null
                        ? Math.round((option.votes / customPoll.totalVotes) * 100)
                        : 0
                      
                      return (
                        <button
                          key={index}
                          onClick={() => {
                            if (customPoll.isExpired) return
                            if (customPoll.type === 'single') {
                              setSelectedPollOptions([index])
                            } else {
                              setSelectedPollOptions(prev => 
                                prev.includes(index) 
                                  ? prev.filter(i => i !== index)
                                  : [...prev, index]
                              )
                            }
                          }}
                          disabled={customPoll.isExpired}
                          style={{
                            position: 'relative',
                            padding: '10px 14px',
                            borderRadius: 8,
                            border: isSelected || hasVoted
                              ? `2px solid ${ARENA_PURPLE}`
                              : `1px solid ${tokens.colors.border.primary}`,
                            background: tokens.colors.bg.primary,
                            color: tokens.colors.text.primary,
                            cursor: customPoll.isExpired ? 'default' : 'pointer',
                            textAlign: 'left',
                            fontSize: 13,
                            fontWeight: hasVoted ? 600 : 400,
                            overflow: 'hidden',
                          }}
                        >
                          {/* 投票结果进度条 */}
                          {customPoll.showResults && (
                            <div style={{
                              position: 'absolute',
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: `${votePercentage}%`,
                              background: hasVoted 
                                ? 'rgba(139, 111, 168, 0.2)' 
                                : 'rgba(139, 111, 168, 0.1)',
                              transition: 'width 0.3s ease',
                            }} />
                          )}
                          <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span>
                              {customPoll.type === 'multiple' && (
                                <span style={{ marginRight: 8 }}>
                                  {isSelected ? '☑' : '☐'}
                                </span>
                              )}
                              {option.text}
                              {hasVoted && ' ✓'}
                            </span>
                            {customPoll.showResults && option.votes !== null && (
                              <span style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
                                {option.votes} 票 ({votePercentage}%)
                              </span>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                  {/* 投票按钮 */}
                  {!customPoll.isExpired && customPollUserVotes.length === 0 && (
                    <button
                      onClick={() => submitCustomPollVote(openPost.id)}
                      disabled={selectedPollOptions.length === 0 || votingCustomPoll}
                      style={{
                        marginTop: 12,
                        padding: '8px 16px',
                        background: selectedPollOptions.length > 0 && !votingCustomPoll 
                          ? ARENA_PURPLE 
                          : 'rgba(139, 111, 168, 0.3)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 8,
                        cursor: selectedPollOptions.length > 0 && !votingCustomPoll ? 'pointer' : 'not-allowed',
                        fontWeight: 600,
                        fontSize: 13,
                      }}
                    >
                      {votingCustomPoll ? '投票中...' : '提交投票'}
                    </button>
                  )}
                  {/* 总票数 */}
                  {customPoll.showResults && customPoll.totalVotes !== null && (
                    <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.text.tertiary }}>
                      共 {customPoll.totalVotes} 人参与投票
                    </div>
                  )}
                  {/* 未投票提示 */}
                  {!customPoll.showResults && !customPoll.isExpired && (
                    <div style={{ marginTop: 10, fontSize: 12, color: tokens.colors.text.tertiary }}>
                      投票后可查看结果
                    </div>
                  )}
                </>
              ) : (
                <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>暂无投票</div>
              )}
            </div>
          )}

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${tokens.colors.border.secondary}`, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <Action
              icon={<ThumbsUpIcon size={14} />}
              text={t('upvote')}
              onClick={(e) => {
                if (e) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                toggleReaction(openPost.id, 'up')
              }}
              active={openPost.user_reaction === 'up'}
              count={openPost.like_count}
              showCount={true}
            />
            <Action
              icon={<ThumbsDownIcon size={14} />}
              text={t('downvote')}
              onClick={(e) => {
                if (e) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                toggleReaction(openPost.id, 'down')
              }}
              active={openPost.user_reaction === 'down'}
              count={openPost.dislike_count}
              showCount={false}
            />
            {/* 收藏 */}
            <Action
              icon={<span style={{ fontSize: 14 }}>{userBookmarks[openPost.id] ? '★' : '☆'}</span>}
              text={userBookmarks[openPost.id] ? (language === 'zh' ? '已收藏' : 'Saved') : (language === 'zh' ? '收藏' : 'Save')}
              onClick={(e) => {
                if (e) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                handleBookmark(openPost.id)
              }}
              active={userBookmarks[openPost.id]}
              count={bookmarkCounts[openPost.id] || 0}
              showCount={true}
            />
            {/* 选择收藏夹 - 仅在已登录时显示 */}
            {accessToken && (
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  openBookmarkFolderModal(openPost.id)
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: tokens.colors.text.tertiary,
                  cursor: 'pointer',
                  padding: '6px 8px',
                  fontSize: 12,
                  borderRadius: 6,
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                  e.currentTarget.style.color = tokens.colors.text.secondary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = tokens.colors.text.tertiary
                }}
                title={language === 'zh' ? '选择收藏夹' : 'Select folder'}
              >
                ▼
              </button>
            )}
            {/* 转发 */}
            <Action
              icon={<span style={{ fontSize: 14 }}>↗</span>}
              text={language === 'zh' ? '转发' : 'Repost'}
              onClick={(e) => {
                if (e) {
                  e.preventDefault()
                  e.stopPropagation()
                }
                if (openPost.author_id === currentUserId) {
                  showToast('不能转发自己的帖子', 'warning')
                  return
                }
                setShowRepostModal(openPost.id)
              }}
              active={false}
              count={0}
              showCount={false}
            />
          </div>

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
              deletingCommentId={deletingCommentId}
              onDeleteComment={deleteComment}
              expandedReplies={expandedReplies}
              setExpandedReplies={setExpandedReplies}
              translatedComments={translatedComments}
            />
          </div>
        </Modal>
      )}

      {/* 编辑帖子弹窗 */}
      {editingPost && (
        <div
          onClick={() => setEditingPost(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: tokens.zIndex.modal, // 使用 design tokens (400)
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 500,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: 16,
              padding: 24,
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 20, color: tokens.colors.text.primary }}>{language === 'zh' ? '编辑帖子' : 'Edit Post'}</h2>
            
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
                {language === 'zh' ? '标题' : 'Title'}
              </label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: 14,
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
                {language === 'zh' ? '内容' : 'Content'}
              </label>
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={8}
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: 14,
                  outline: 'none',
                  resize: 'vertical',
                  lineHeight: 1.6,
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setEditingPost(null)}
                disabled={savingEdit}
                style={{
                  padding: '10px 20px',
                  borderRadius: 10,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: savingEdit ? 'not-allowed' : 'pointer',
                }}
              >
                {language === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={savingEdit || !editTitle.trim()}
                style={{
                  padding: '10px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: savingEdit || !editTitle.trim() ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                  color: '#fff',
                  fontWeight: 900,
                  fontSize: 14,
                  cursor: savingEdit || !editTitle.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {savingEdit ? (language === 'zh' ? '保存中...' : 'Saving...') : (language === 'zh' ? '保存' : 'Save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 转发弹窗 - 使用 Portal 渲染到 body */}
      {showRepostModal && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => {
            setShowRepostModal(null)
            setRepostComment('')
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: tokens.zIndex.modal, // 使用 design tokens (400)
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 400,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: 16,
              padding: 24,
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 16, color: tokens.colors.text.primary }}>
              {language === 'zh' ? '转发到主页' : 'Repost to Feed'}
            </h2>

            <textarea
              value={repostComment}
              onChange={(e) => setRepostComment(e.target.value)}
              placeholder={language === 'zh' ? '添加评论（可选）...' : 'Add comment (optional)...'}
              style={{
                width: '100%',
                minHeight: 80,
                padding: 12,
                borderRadius: 12,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: 14,
                resize: 'vertical',
                marginBottom: 16,
                outline: 'none',
              }}
              maxLength={280}
            />
            
            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowRepostModal(null)
                  setRepostComment('')
                }}
                style={{
                  padding: '10px 20px',
                  borderRadius: 10,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                {language === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={() => handleRepost(showRepostModal, repostComment)}
                disabled={repostLoading[showRepostModal]}
                style={{
                  padding: '10px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: repostLoading[showRepostModal] ? 'rgba(139,111,168,0.3)' : '#8b6fa8',
                  color: '#fff',
                  fontWeight: 900,
                  fontSize: 14,
                  cursor: repostLoading[showRepostModal] ? 'not-allowed' : 'pointer',
                }}
              >
                {repostLoading[showRepostModal] ? (language === 'zh' ? '转发中...' : 'Reposting...') : (language === 'zh' ? '转发' : 'Repost')}
              </button>
            </div>
          </div>
        </div>,
        document.body
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

function ReactButton({ onClick, active, icon, count, showCount = true }: { onClick: (e: React.MouseEvent) => void; active: boolean; icon: React.ReactNode; count: number; showCount?: boolean }) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)
  const processingRef = useRef(false)

  const handleClick = (e: React.MouseEvent) => {
    if (processingRef.current) return
    processingRef.current = true

    e.preventDefault()
    e.stopPropagation()

    setIsAnimating(true)
    setTimeout(() => {
      setIsAnimating(false)
      processingRef.current = false
    }, 300)

    onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        background: active ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
        border: 'none',
        color: active ? tokens.colors.accent.primary : tokens.colors.text.secondary,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 6,
        transition: 'all 0.2s ease',
        transform: isPressed ? 'scale(0.9)' : 'scale(1)',
        fontWeight: active ? 900 : 400,
        boxShadow: active ? '0 0 0 1px rgba(139, 111, 168, 0.2)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
          e.currentTarget.style.color = '#d6d6d6'
        }
      }}
      onMouseLeave={(e) => {
        setIsPressed(false)
        if (!active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = '#a9a9a9'
        }
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          transition: 'transform 0.2s ease',
          transform: active ? 'scale(1.15)' : isAnimating ? 'scale(1.3)' : 'scale(1)',
        }}
      >
        {icon}
      </span>
      {showCount && count}
    </button>
  )
}

function Action(props: { icon?: React.ReactNode; text: string; onClick: (e?: React.MouseEvent) => void; active?: boolean; count?: number; showCount?: boolean }) {
  const [isPressed, setIsPressed] = useState(false)
  const [isAnimating, setIsAnimating] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsAnimating(true)
    setTimeout(() => setIsAnimating(false), 300)
    props.onClick(e)
  }

  return (
    <button
      onClick={handleClick}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      style={{
        border: 'none',
        background: props.active ? 'rgba(139, 111, 168, 0.15)' : 'transparent',
        color: props.active ? '#8b6fa8' : '#a9a9a9',
        cursor: 'pointer',
        padding: '6px 12px',
        fontSize: 13,
        fontWeight: props.active ? 950 : 700,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderRadius: 8,
        transition: 'all 0.2s ease',
        transform: isPressed ? 'scale(0.95)' : 'scale(1)',
        boxShadow: props.active ? '0 0 0 1px rgba(139, 111, 168, 0.3)' : 'none',
      }}
      onMouseEnter={(e) => {
        if (!props.active) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
          e.currentTarget.style.color = '#d6d6d6'
        }
      }}
      onMouseLeave={(e) => {
        setIsPressed(false)
        if (!props.active) {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = '#a9a9a9'
        }
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          transition: 'transform 0.2s ease',
          transform: props.active ? 'scale(1.1)' : isAnimating ? 'scale(1.2)' : 'scale(1)',
        }}
      >
        {props.icon}
      </span>
      {props.text}
      {props.showCount && props.count !== undefined && ` ${props.count}`}
    </button>
  )
}

function Modal(props: { children: React.ReactNode; onClose: () => void }) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  const modalContent = (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        zIndex: tokens.zIndex.modal,
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 16,
          background: tokens.colors.bg.secondary,
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={props.onClose} style={{ border: 'none', background: 'transparent', color: tokens.colors.text.secondary, cursor: 'pointer', fontSize: 20 }}>
            ×
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )

  if (!mounted) return null
  return createPortal(modalContent, document.body)
}
