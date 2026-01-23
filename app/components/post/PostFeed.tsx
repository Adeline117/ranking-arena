'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { tokens } from '@/lib/design-tokens'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '../icons'
import { useLanguage } from '../Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import { formatTimeAgo } from '@/lib/utils/date'
import { type PollChoice, type PostWithUserState, getPollWinner } from '@/lib/types'
import { useToast } from '../ui/Toast'
import { useDialog } from '../ui/Dialog'
import { getCsrfHeaders } from '@/lib/api/client'
import BookmarkModal from '../ui/BookmarkModal'

// 本地类型（扩展后端类型）
type Post = PostWithUserState

type Comment = {
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

// 默认显示的回复数量
const REPLIES_PREVIEW_COUNT = 2

const ARENA_PURPLE = '#8b6fa8'
// 翻译文本颜色使用主题令牌，会根据明暗模式自动切换

// 内容渲染函数 - 将文本中的URL转换为可点击链接，Markdown图片转换为图片元素
function renderContentWithLinks(text: string) {
  if (!text) return null
  
  // 先处理 Markdown 图片语法 ![alt](url)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  
  // 分割内容，保留图片和链接
  const parts: { type: 'text' | 'image' | 'link'; content: string; url?: string }[] = []
  const lastIndex = 0
  let match
  
  // 先找出所有图片
  const imageMatches: { start: number; end: number; alt: string; url: string }[] = []
  while ((match = imageRegex.exec(text)) !== null) {
    imageMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: match[1],
      url: match[2],
    })
  }
  
  // 构建内容片段
  let currentIndex = 0
  for (const img of imageMatches) {
    // 图片前的文本
    if (img.start > currentIndex) {
      const beforeText = text.slice(currentIndex, img.start)
      // 处理这段文本中的链接
      const linkParts = beforeText.split(urlRegex)
      linkParts.forEach((part, i) => {
        if (urlRegex.test(part)) {
          urlRegex.lastIndex = 0
          parts.push({ type: 'link', content: part, url: part })
        } else if (part) {
          parts.push({ type: 'text', content: part })
        }
      })
    }
    // 图片
    parts.push({ type: 'image', content: img.alt, url: img.url })
    currentIndex = img.end
  }
  
  // 最后一个图片后的文本
  if (currentIndex < text.length) {
    const afterText = text.slice(currentIndex)
    const linkParts = afterText.split(urlRegex)
    linkParts.forEach((part, i) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        parts.push({ type: 'link', content: part, url: part })
      } else if (part) {
        parts.push({ type: 'text', content: part })
      }
    })
  }
  
  // 如果没有图片，直接处理链接
  if (imageMatches.length === 0) {
    const linkParts = text.split(urlRegex)
    return linkParts.map((part, index) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              color: ARENA_PURPLE,
              textDecoration: 'underline',
              wordBreak: 'break-all',
            }}
          >
            {part}
          </a>
        )
      }
      return part
    })
  }
  
  // 渲染所有片段
  return parts.map((part, index) => {
    if (part.type === 'image') {
      return (
        <img
          key={index}
          src={part.url}
          alt={part.content || 'image'}
          onClick={(e) => {
            e.stopPropagation()
            window.open(part.url, '_blank')
          }}
          style={{
            maxWidth: '100%',
            maxHeight: 300,
            borderRadius: 8,
            cursor: 'pointer',
            display: 'inline-block',
            verticalAlign: 'middle',
            margin: '4px 6px',
          }}
        />
      )
    }
    if (part.type === 'link') {
      return (
        <a
          key={index}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: ARENA_PURPLE,
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part.content}
        </a>
      )
    }
    return <span key={index}>{part.content}</span>
  })
}

function pollLabel(choice: PollChoice | 'tie', t: (key: keyof typeof import('@/lib/i18n').translations.zh) => string) {
  if (choice === 'bull') return t('bullish')
  if (choice === 'bear') return t('bearish')
  return t('wait')
}

function pollColor(choice: PollChoice | 'tie') {
  if (choice === 'bull') return '#7CFFB2'
  if (choice === 'bear') return '#FF7C7C'
  return '#A9A9A9'
}

function AvatarLink({ handle, avatarUrl }: { handle?: string | null; avatarUrl?: string | null }) {
  if (!handle) return null
  const href = `/u/${encodeURIComponent(handle)}`
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        textDecoration: 'none',
        color: tokens.colors.text.primary,
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
      <span style={{ fontWeight: 850, fontSize: 12, color: tokens.colors.text.secondary }}>{handle}</span>
    </Link>
  )
}

type SortType = 'time' | 'likes'

export default function PostFeed(props: { variant?: 'compact' | 'full'; groupId?: string; authorHandle?: string; initialPostId?: string | null; showSortButtons?: boolean } = {}) {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const { showDangerConfirm } = useDialog()
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortType, setSortType] = useState<SortType>('time')
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [editingPost, setEditingPost] = useState<Post | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const processingRef = useRef<Set<string>>(new Set())
  const abortControllerRef = useRef<AbortController | null>(null)
  // 评论相关状态
  const [replyingTo, setReplyingTo] = useState<{ commentId: string; handle: string } | null>(null)
  const [replyContent, setReplyContent] = useState('')
  const [submittingReply, setSubmittingReply] = useState(false)
  const [commentLikeLoading, setCommentLikeLoading] = useState<Record<string, boolean>>({})
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({})
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
  const [userReposts, setUserReposts] = useState<Record<string, boolean>>({})
  const [bookmarkCounts, setBookmarkCounts] = useState<Record<string, number>>({})
  const [repostCounts, setRepostCounts] = useState<Record<string, number>>({})
  // 收藏夹选择弹窗状态
  const [showBookmarkModal, setShowBookmarkModal] = useState(false)
  const [bookmarkingPostId, setBookmarkingPostId] = useState<string | null>(null)

  // 获取用户 token 和 ID
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

      const params = new URLSearchParams()
      params.set('limit', '20')
      // 根据排序类型设置排序方式
      if (sortType === 'likes') {
        params.set('sort_by', 'like_count')
      } else if (props.authorHandle) {
        // 个人主页按时间排序
        params.set('sort_by', 'created_at')
      } else if (props.groupId) {
        // 小组页面按时间排序
        params.set('sort_by', 'created_at')
      } else {
        // 推荐页面按热度排序
        params.set('sort_by', 'hot_score')
      }
      params.set('sort_order', 'desc')
      
      if (props.groupId) params.set('group_id', props.groupId)
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

      // API 返回格式: { success: true, data: { posts: [...] } }
      const loadedPosts = data.data?.posts || []
      setPosts(loadedPosts)
      
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
  }, [props.groupId, props.authorHandle, accessToken, sortType])
  
  // 组件卸载时取消所有请求
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [])

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

  // 加载评论
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
        // API 返回格式：{ success: true, data: { comments: [...] } }
        setComments(json.data?.comments || [])
      } else {
        setComments([])
      }
    } catch (err) {
      setComments([])
    } finally {
      setLoadingComments(false)
    }
  }, [accessToken])

  // 点赞/踩
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
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

        // 如果弹窗打开，也更新弹窗中的帖子
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? {
            ...prev,
            like_count: result.like_count,
            dislike_count: result.dislike_count,
            user_reaction: result.reaction,
          } : null)
        }
      }
    } catch (err) {
      // 错误已在 showToast 中处理
    } finally {
      setTimeout(() => processingRef.current.delete(key), 300)
    }
  }, [accessToken, openPost?.id])

  // 投票
  const toggleVote = useCallback(async (postId: string, choice: PollChoice) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
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
      }
    } catch (err) {
      // 错误已在 showToast 中处理
    } finally {
      setTimeout(() => processingRef.current.delete(key), 300)
    }
  }, [accessToken, openPost?.id])

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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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

  // 提交评论
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

      const json = await response.json()

      if (response.ok && json.success) {
        const result = json.data
        setComments(prev => [...prev, result.comment])
        setNewComment('')
        
        // 更新评论计数
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: p.comment_count + 1 }
          }
          return p
        }))
        
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, comment_count: prev.comment_count + 1 } : null)
        }
      } else {
        showToast(json.error || '发表评论失败', 'error')
      }
    } catch (err) {
      // 错误已在 showToast 中处理
      showToast('发表评论失败', 'error')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, openPost?.id, showToast])

  // 评论点赞
  const toggleCommentLike = useCallback(async (commentId: string) => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
    }

    if (commentLikeLoading[commentId]) return
    setCommentLikeLoading(prev => ({ ...prev, [commentId]: true }))

    try {
      const response = await fetch(`/api/posts/${openPost?.id}/comments/like`, {
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
        // 更新评论的点赞状态
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
        // 处理API错误
        if (response.status === 429) {
          showToast('操作太快，稍等一下', 'warning')
        } else if (response.status === 401) {
          showToast('登录已过期', 'warning')
        } else {
          showToast(json.error || '点赞失败', 'error')
        }
      }
    } catch (err) {
      // 错误已在 showToast 中处理
      showToast('网络错误', 'error')
    } finally {
      setCommentLikeLoading(prev => ({ ...prev, [commentId]: false }))
    }
  }, [accessToken, openPost?.id, commentLikeLoading, showToast])

  // 提交回复
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
        // 添加回复到对应评论
        setComments(prev => prev.map(c => {
          if (c.id === parentId) {
            return {
              ...c,
              replies: [...(c.replies || []), newReply],
            }
          }
          return c
        }))
        setReplyContent('')
        setReplyingTo(null)
        // 展开该评论的回复
        setExpandedReplies(prev => ({ ...prev, [parentId]: true }))
        
        // 更新评论计数
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: p.comment_count + 1 }
          }
          return p
        }))
        
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, comment_count: prev.comment_count + 1 } : null)
        }
        
        showToast('已回复', 'success')
      } else {
        showToast(json.error || '回复失败', 'error')
      }
    } catch (err) {
      console.error('[PostFeed] 回复失败:', err)
      showToast('回复失败', 'error')
    } finally {
      setSubmittingReply(false)
    }
  }, [accessToken, replyContent, openPost?.id, showToast])

  // 删除评论
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  
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
        // 从列表中移除评论（包括顶级评论和嵌套回复）
        setComments(prev => prev.map(c => {
          // 如果是顶级评论被删除，直接过滤
          if (c.id === commentId) return null
          // 如果是嵌套回复被删除，过滤掉回复
          if (c.replies && c.replies.length > 0) {
            return {
              ...c,
              replies: c.replies.filter(r => r.id !== commentId)
            }
          }
          return c
        }).filter(Boolean) as Comment[])
        
        // 更新评论计数
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: Math.max(0, p.comment_count - 1) }
          }
          return p
        }))
        
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, comment_count: Math.max(0, prev.comment_count - 1) } : null)
        }
        
        showToast('已删除', 'success')
      } else {
        showToast(json.error || '删除评论失败', 'error')
      }
    } catch (err) {
      // 错误已在 showToast 中处理
      showToast('删除评论失败', 'error')
    } finally {
      setDeletingCommentId(null)
    }
  }, [accessToken, openPost?.id, showDangerConfirm, showToast])

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
    } catch (err) {
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
      
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
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

  // 批量翻译帖子标题（使用批量API，减少请求次数）
  const translateListPosts = useCallback(async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
    if (translatingList) return
    
    // 过滤出需要翻译的帖子
    const needsTranslation = postsToTranslate.filter(p => {
      const alreadyTranslated = translatedListPosts[p.id]?.title
      if (alreadyTranslated) return false
      if (!p.title) return false
      
      const titleIsChinese = isChineseText(p.title)
      // 中文标题 + 目标英文 = 需要翻译 | 英文标题 + 目标中文 = 需要翻译
      return targetLang === 'en' ? titleIsChinese : !titleIsChinese
    })
    
    if (needsTranslation.length === 0) return
    
    setTranslatingList(true)
    
    try {
      // 使用批量翻译API（最多20个）
      const items = needsTranslation.slice(0, 20).map(post => ({
        id: post.id,
        text: post.title || '',
        contentType: 'post_title' as const,
        contentId: post.id,
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
        
        setTranslatedListPosts(prev => {
          const updated = { ...prev }
          for (const [id, result] of Object.entries(results)) {
            updated[id] = { title: result.translatedText }
          }
          return updated
        })
        
      }
    } catch {
      // 批量翻译失败，静默处理
    } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts, isChineseText])

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
  }, [loadComments, language, isChineseText, translateContent, translatedListPosts, translateListPosts])

  if (loading) {
    return (
      <div style={{
        padding: tokens.spacing[6],
        textAlign: 'center',
        color: tokens.colors.text.tertiary,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[3],
      }}>
        <div style={{
          width: 24,
          height: 24,
          border: `2px solid ${tokens.colors.border.primary}`,
          borderTopColor: tokens.colors.accent.primary,
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />
        <span>{t('loading')}</span>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        padding: tokens.spacing[6],
        textAlign: 'center',
        color: tokens.colors.text.tertiary,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[3],
      }}>
        <div style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[2] }}>
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
        {/* 排序按钮 */}
        {props.showSortButtons && (
          <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
            <button
              onClick={() => setSortType('time')}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${sortType === 'time' ? ARENA_PURPLE : tokens.colors.border.primary}`,
                background: sortType === 'time' ? 'rgba(139, 111, 168, 0.15)' : tokens.colors.bg.primary,
                color: sortType === 'time' ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: sortType === 'time' ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              {language === 'zh' ? '最新' : 'Latest'}
            </button>
            <button
              onClick={() => setSortType('likes')}
              style={{
                padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${sortType === 'likes' ? ARENA_PURPLE : tokens.colors.border.primary}`,
                background: sortType === 'likes' ? 'rgba(139, 111, 168, 0.15)' : tokens.colors.bg.primary,
                color: sortType === 'likes' ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: sortType === 'likes' ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              {language === 'zh' ? '最热' : 'Hot'}
            </button>
          </div>
        )}
        <div style={{
          padding: tokens.spacing[6],
          textAlign: 'center',
          color: tokens.colors.text.tertiary,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[2],
        }}>
          <span style={{ fontSize: tokens.typography.fontSize.lg }}>
            {language === 'zh' ? '📝' : '📝'}
          </span>
          <span>{language === 'zh' ? '暂无帖子' : 'No posts yet'}</span>
          <span style={{ fontSize: tokens.typography.fontSize.xs }}>
            {language === 'zh' ? '成为第一个发帖的人吧！' : 'Be the first to post!'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* 排序按钮 */}
      {props.showSortButtons && (
        <div style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
          <button
            onClick={() => setSortType('time')}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${sortType === 'time' ? ARENA_PURPLE : tokens.colors.border.primary}`,
              background: sortType === 'time' ? 'rgba(139, 111, 168, 0.15)' : tokens.colors.bg.primary,
              color: sortType === 'time' ? tokens.colors.text.primary : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: sortType === 'time' ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            最新
          </button>
          <button
            onClick={() => setSortType('likes')}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${sortType === 'likes' ? ARENA_PURPLE : tokens.colors.border.primary}`,
              background: sortType === 'likes' ? 'rgba(139, 111, 168, 0.15)' : tokens.colors.bg.primary,
              color: sortType === 'likes' ? tokens.colors.text.primary : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: sortType === 'likes' ? 700 : 400,
              cursor: 'pointer',
            }}
          >
            最热
          </button>
        </div>
      )}
      <div>
        {/* 只在个人主页（有 authorHandle）时才将置顶帖子排在最上面 */}
        {(props.authorHandle ? [...posts].sort((a, b) => {
          // 置顶帖子优先（仅在个人主页生效）
          if (a.is_pinned && !b.is_pinned) return -1
          if (!a.is_pinned && b.is_pinned) return 1
          return 0
        }) : posts).map((p) => {
          const poll = { bull: p.poll_bull, bear: p.poll_bear, wait: p.poll_wait }
          const winner = p.poll_enabled ? getPollWinner(poll) : 'tie'
          const label = pollLabel(winner, t)
          const color = pollColor(winner)

          return (
            <div
              key={p.id}
              onClick={(e: React.MouseEvent) => {
                // Don't hijack clicks on interactive elements (links, buttons, etc.)
                if ((e.target as HTMLElement).closest('a, button, [role="button"], input, textarea, select')) return
                handleOpenPost(p)
              }}
              style={{
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
                e.currentTarget.style.background = tokens.colors.bg.secondary
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                {p.group_id ? (
                  <Link
                    href={`/groups/${p.group_id}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      fontSize: 12,
                      color: ARENA_PURPLE,
                      textDecoration: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    {p.group_name || '小组'}
                  </Link>
                ) : null}
                <AvatarLink handle={p.author_handle} avatarUrl={p.author_avatar_url} />
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
                    投票
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
                    {p.images.length}图
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
                    <AvatarLink handle={p.original_post.author_handle} avatarUrl={p.original_post.author_avatar_url} />
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
                  {formatTimeAgo(p.created_at)}
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
                    置顶
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
                      {p.is_pinned ? '取消置顶' : '置顶'}
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
                      编辑
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
                      删除
                    </button>
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

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
                {openPost.group_name}
              </Link>
            ) : (
              <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
                {openPost.group_name}
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
            <AvatarLink handle={openPost.author_handle} avatarUrl={openPost.author_avatar_url} />
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
                {openPost.author_handle}
              </Link>
            ) : (
              <span>{openPost.author_handle || '匿名'}</span>
            )}
            <span>·</span>
            <span>{formatTimeAgo(openPost.created_at)}</span>
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
                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>转发自</span>
                <AvatarLink handle={openPost.original_post.author_handle} avatarUrl={openPost.original_post.author_avatar_url} />
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
              text={userBookmarks[openPost.id] ? '已收藏' : '收藏'}
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
                title="选择收藏夹"
              >
                ▼
              </button>
            )}
            {/* 转发 */}
            <Action
              icon={<span style={{ fontSize: 14 }}>↗</span>}
              text="转发"
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
            <div style={{ fontWeight: 950, marginBottom: 12 }}>
              {t('comments')} ({openPost.comment_count})
            </div>

            {/* 评论输入框 */}
            <div style={{ marginBottom: 16 }}>
              <textarea
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={accessToken ? t('writeComment') : '请先登录后发表评论'}
                disabled={!accessToken || submittingComment}
                style={{
                  width: '100%',
                  minHeight: 80,
                  resize: 'vertical',
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  outline: 'none',
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              />
              {accessToken && (
                <button
                  onClick={() => submitComment(openPost.id)}
                  disabled={!newComment.trim() || submittingComment}
                  style={{
                    marginTop: 8,
                    padding: '8px 16px',
                    background: newComment.trim() && !submittingComment ? ARENA_PURPLE : 'rgba(139, 111, 168, 0.3)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: newComment.trim() && !submittingComment ? 'pointer' : 'not-allowed',
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {submittingComment ? '发送中...' : '发表评论'}
                </button>
              )}
            </div>

            {/* 评论列表 */}
            {loadingComments ? (
              <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>加载评论中...</div>
            ) : comments.length === 0 ? (
              <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>暂无评论，来发表第一条评论吧</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {comments.filter(Boolean).map((comment) => {
                  const replies = comment.replies || []
                  const isExpanded = expandedReplies[comment.id]
                  const displayedReplies = isExpanded ? replies : replies.slice(0, REPLIES_PREVIEW_COUNT)
                  const hasMoreReplies = replies.length > REPLIES_PREVIEW_COUNT
                  
                  return (
                    <div
                      key={comment.id}
                      style={{
                        padding: 12,
                        background: tokens.colors.bg.secondary,
                        borderRadius: 8,
                        border: `1px solid ${tokens.colors.border.primary}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <AvatarLink handle={comment.author_handle || '匿名'} avatarUrl={comment.author_avatar_url} />
                        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                          {formatTimeAgo(comment.created_at)}
                        </span>
                        {/* 删除按钮 - 仅评论作者可见 */}
                        {currentUserId && comment.user_id === currentUserId && (
                          <button
                            onClick={() => openPost && deleteComment(openPost.id, comment.id)}
                            disabled={deletingCommentId === comment.id}
                            style={{
                              marginLeft: 'auto',
                              background: 'transparent',
                              border: 'none',
                              color: tokens.colors.text.tertiary,
                              cursor: deletingCommentId === comment.id ? 'not-allowed' : 'pointer',
                              fontSize: 11,
                              padding: '2px 6px',
                              borderRadius: 4,
                              opacity: deletingCommentId === comment.id ? 0.5 : 1,
                            }}
                            onMouseEnter={(e) => {
                              if (deletingCommentId !== comment.id) {
                                e.currentTarget.style.color = '#ff4d4d'
                                e.currentTarget.style.background = 'rgba(255,77,77,0.1)'
                              }
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.color = tokens.colors.text.tertiary
                              e.currentTarget.style.background = 'transparent'
                            }}
                          >
                            {deletingCommentId === comment.id ? '删除中...' : '删除'}
                          </button>
                        )}
                      </div>
                      <div translate="no" style={{ 
                        fontSize: 13, 
                        color: translatedComments[comment.id] 
                          ? tokens.colors.accent.translated 
                          : tokens.colors.text.primary, 
                        lineHeight: 1.6 
                      }}>
                        {renderContentWithLinks(translatedComments[comment.id] || comment.content || '')}
                      </div>
                      
                      {/* 评论操作栏：点赞和回复 */}
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 16 }}>
                        <button
                          onClick={() => toggleCommentLike(comment.id)}
                          disabled={commentLikeLoading[comment.id]}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: comment.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
                            cursor: 'pointer',
                            fontSize: 12,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 8px',
                            borderRadius: 4,
                            transition: 'all 0.2s',
                          }}
                          onMouseEnter={(e) => {
                            if (!comment.user_liked) {
                              e.currentTarget.style.color = ARENA_PURPLE
                              e.currentTarget.style.background = 'rgba(139,111,168,0.1)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!comment.user_liked) {
                              e.currentTarget.style.color = tokens.colors.text.tertiary
                              e.currentTarget.style.background = 'transparent'
                            }
                          }}
                        >
                          <ThumbsUpIcon size={12} />
                          <span style={{ fontWeight: comment.user_liked ? 700 : 400 }}>
                            {comment.like_count || 0}
                          </span>
                        </button>
                        
                        <button
                          onClick={() => {
                            if (!accessToken) {
                              showToast('请先登录', 'warning')
                              return
                            }
                            setReplyingTo(replyingTo?.commentId === comment.id 
                              ? null 
                              : { commentId: comment.id, handle: comment.author_handle || '匿名' })
                            setReplyContent('')
                          }}
                          style={{
                            background: replyingTo?.commentId === comment.id ? 'rgba(139,111,168,0.1)' : 'transparent',
                            border: 'none',
                            color: replyingTo?.commentId === comment.id ? ARENA_PURPLE : tokens.colors.text.tertiary,
                            cursor: 'pointer',
                            fontSize: 12,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 8px',
                            borderRadius: 4,
                            transition: 'all 0.2s',
                          }}
                          onMouseEnter={(e) => {
                            if (replyingTo?.commentId !== comment.id) {
                              e.currentTarget.style.color = ARENA_PURPLE
                              e.currentTarget.style.background = 'rgba(139,111,168,0.1)'
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (replyingTo?.commentId !== comment.id) {
                              e.currentTarget.style.color = tokens.colors.text.tertiary
                              e.currentTarget.style.background = 'transparent'
                            }
                          }}
                        >
                          <CommentIcon size={12} />
                          回复
                        </button>
                      </div>
                      
                      {/* 回复输入框 */}
                      {replyingTo?.commentId === comment.id && (
                        <div style={{ marginTop: 12, padding: 12, background: tokens.colors.bg.primary, borderRadius: 8 }}>
                          <div style={{ fontSize: 12, color: tokens.colors.text.tertiary, marginBottom: 8 }}>
                            回复 @{replyingTo.handle}
                          </div>
                          <textarea
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                            placeholder="写下你的回复..."
                            disabled={submittingReply}
                            style={{
                              width: '100%',
                              minHeight: 60,
                              resize: 'vertical',
                              padding: 10,
                              borderRadius: 8,
                              border: `1px solid ${tokens.colors.border.primary}`,
                              background: tokens.colors.bg.secondary,
                              color: tokens.colors.text.primary,
                              outline: 'none',
                              fontSize: 13,
                              lineHeight: 1.5,
                            }}
                          />
                          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                            <button
                              onClick={() => {
                                setReplyingTo(null)
                                setReplyContent('')
                              }}
                              style={{
                                padding: '6px 12px',
                                background: 'transparent',
                                color: tokens.colors.text.secondary,
                                border: `1px solid ${tokens.colors.border.primary}`,
                                borderRadius: 6,
                                cursor: 'pointer',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              取消
                            </button>
                            <button
                              onClick={() => openPost && submitReply(openPost.id, comment.id)}
                              disabled={!replyContent.trim() || submittingReply}
                              style={{
                                padding: '6px 12px',
                                background: replyContent.trim() && !submittingReply ? ARENA_PURPLE : 'rgba(139, 111, 168, 0.3)',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 6,
                                cursor: replyContent.trim() && !submittingReply ? 'pointer' : 'not-allowed',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {submittingReply ? '发送中...' : '发送'}
                            </button>
                          </div>
                        </div>
                      )}
                      
                      {/* 嵌套回复 */}
                      {displayedReplies.length > 0 && (
                        <div style={{ marginTop: 12, marginLeft: 16, borderLeft: `2px solid ${tokens.colors.border.primary}`, paddingLeft: 12 }}>
                          {displayedReplies.map((reply) => (
                            <div key={reply.id} style={{ marginBottom: 10 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary }}>
                                  {reply.author_handle || '匿名'}
                                </span>
                                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                                  {formatTimeAgo(reply.created_at)}
                                </span>
                                {/* 删除按钮 - 仅回复作者可见 */}
                                {currentUserId && reply.user_id === currentUserId && (
                                  <button
                                    onClick={() => openPost && deleteComment(openPost.id, reply.id)}
                                    disabled={deletingCommentId === reply.id}
                                    style={{
                                      marginLeft: 'auto',
                                      background: 'transparent',
                                      border: 'none',
                                      color: tokens.colors.text.tertiary,
                                      cursor: deletingCommentId === reply.id ? 'not-allowed' : 'pointer',
                                      fontSize: 11,
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      opacity: deletingCommentId === reply.id ? 0.5 : 1,
                                    }}
                                    onMouseEnter={(e) => {
                                      if (deletingCommentId !== reply.id) {
                                        e.currentTarget.style.color = '#ff4d4d'
                                        e.currentTarget.style.background = 'rgba(255,77,77,0.1)'
                                      }
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.color = tokens.colors.text.tertiary
                                      e.currentTarget.style.background = 'transparent'
                                    }}
                                  >
                                    {deletingCommentId === reply.id ? '...' : '删除'}
                                  </button>
                                )}
                              </div>
                              <div style={{ 
                                fontSize: 13, 
                                color: translatedComments[reply.id] 
                                  ? tokens.colors.accent.translated 
                                  : tokens.colors.text.primary 
                              }}>
                                {renderContentWithLinks(translatedComments[reply.id] || reply.content || '')}
                              </div>
                              {/* 回复的点赞按钮 */}
                              <div style={{ marginTop: 4 }}>
                                <button
                                  onClick={() => toggleCommentLike(reply.id)}
                                  disabled={commentLikeLoading[reply.id]}
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    color: reply.user_liked ? ARENA_PURPLE : tokens.colors.text.tertiary,
                                    cursor: 'pointer',
                                    fontSize: 11,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 3,
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    transition: 'all 0.2s',
                                  }}
                                  onMouseEnter={(e) => {
                                    if (!reply.user_liked) {
                                      e.currentTarget.style.color = ARENA_PURPLE
                                    }
                                  }}
                                  onMouseLeave={(e) => {
                                    if (!reply.user_liked) {
                                      e.currentTarget.style.color = tokens.colors.text.tertiary
                                    }
                                  }}
                                >
                                  <ThumbsUpIcon size={10} />
                                  {reply.like_count || 0}
                                </button>
                              </div>
                            </div>
                          ))}
                          
                          {/* 展开/收起更多回复 */}
                          {hasMoreReplies && (
                            <button
                              onClick={() => setExpandedReplies(prev => ({ ...prev, [comment.id]: !isExpanded }))}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: ARENA_PURPLE,
                                cursor: 'pointer',
                                fontSize: 12,
                                fontWeight: 600,
                                padding: '4px 0',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              {isExpanded 
                                ? '收起回复 ▲' 
                                : `查看全部 ${replies.length} 条回复 ▼`}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
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
            <h2 style={{ fontSize: 18, fontWeight: 900, marginBottom: 20, color: tokens.colors.text.primary }}>编辑帖子</h2>
            
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 800, color: tokens.colors.text.primary }}>
                标题
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
                内容
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
                取消
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
                {savingEdit ? '保存中...' : '保存'}
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
              转发到主页
            </h2>
            
            <textarea
              value={repostComment}
              onChange={(e) => setRepostComment(e.target.value)}
              placeholder="添加评论（可选）..."
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
                取消
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
                {repostLoading[showRepostModal] ? '转发中...' : '转发'}
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
    </>
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
