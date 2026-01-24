'use client'

import { useEffect, useMemo, useState, useCallback, useRef, Suspense } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import MarketPanel from '@/app/components/home/MarketPanel'
import Card from '@/app/components/ui/Card'
import RankingTableCompact from '@/app/components/ranking/RankingTableCompact'
import { Box, Text } from '@/app/components/base'
import { CommentIcon, ThumbsUpIcon, ThumbsDownIcon } from '@/app/components/icons'
import { useToast } from '@/app/components/ui/Toast'
import { formatTimeAgo } from '@/lib/utils/date'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { getCsrfHeaders } from '@/lib/api/client'
import { renderContentWithLinks } from '@/lib/utils/content'

// Use design tokens for brand color
const ARENA_PURPLE = '#8b6fa8' // fallback, prefer tokens.colors.accent.brand

// 本地 Trader 类型
type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
  source?: string
}
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

type Post = {
  id: string
  group: string
  group_id?: string
  title: string
  author: string
  author_handle?: string
  time: string
  body: string
  comments: number
  likes: number
  dislikes?: number
  hotScore: number
  views: number
  created_at?: string
  user_reaction?: 'up' | 'down' | null
}

type Comment = {
  id: string
  content: string
  user_id: string
  author_handle?: string
  author_avatar_url?: string
  created_at: string
  replies?: Comment[]
}

function HotContent() {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [loggedIn, setLoggedIn] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  // 翻译相关状态
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})
  // 列表翻译状态
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)
  // 展开/收起状态
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})
  const [_currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  const [posts, setPosts] = useState<Post[]>([])
  const [loadingPosts, setLoadingPosts] = useState(true)

  // Time range removed - sort by real-time hotness only

  // Tabbed sections state
  const [activeHotTab, setActiveHotTab] = useState<'posts' | 'traders' | 'groups'>('posts')

  // Groups data for the groups tab
  const [groups, setGroups] = useState<{ id: string; name: string; member_count: number }[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)

  // New content polling state
  const [newPostCount, setNewPostCount] = useState(0)
  const latestPostTime = useRef<string>('')

  // 帖子详情弹窗状态
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)
  
  // 评论分页状态
  const COMMENTS_PER_PAGE = 10
  const [commentsOffset, setCommentsOffset] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(true)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setLoggedIn(!!data.user)
      setCurrentUserId(data.user?.id ?? null)
    })
    supabase.auth.getSession().then(({ data }) => {
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  // 加载交易员数据 - 直接查询 trader_sources 表
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const { data, error: supabaseError } = await supabase
          .from('trader_sources')
          .select('source, source_trader_id, handle, avatar_url, roi, arena_score')
          .order('arena_score', { ascending: false, nullsFirst: false })
          .limit(10)

        if (supabaseError) {
          setTraders([])
          showToast(language === 'zh' ? '加载交易员数据失败' : 'Failed to load traders', 'error')
          return
        }

        setTraders((data || []).map(item => ({
          id: item.source_trader_id || '',
          handle: item.handle || item.source_trader_id || null,
          roi: item.roi || 0,
          win_rate: 0,
          followers: 0,
          source: item.source || 'binance',
        })))
      } catch (_error) {
        setTraders([])
        showToast(language === 'zh' ? '加载交易员数据失败' : 'Failed to load traders', 'error')
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  // 从缓存 API 加载热榜帖子
  const loadPosts = useCallback(async () => {
    setLoadingPosts(true)
    try {
      const res = await fetch(`/api/posts?sort_by=hot_score&sort_order=desc&limit=20`)
      const json = await res.json()
      const data = json.posts || json.data?.posts || []

      if (data.length > 0) {
        const postsData: Post[] = data.map((post: Record<string, unknown>) => {
          const createdAt = new Date(post.created_at as string)
          const diffMs = Date.now() - createdAt.getTime()
          const diffHours = Math.floor(diffMs / 3600000)
          const diffDays = Math.floor(diffHours / 24)

          let timeStr = ''
          if (diffDays > 0) timeStr = `${diffDays}d`
          else if (diffHours > 0) timeStr = `${diffHours}h`
          else timeStr = `${Math.floor(diffMs / 60000)}m`

          const groupName = (post.group_name as string) || '综合讨论'

          const hotScore = (post.hot_score as number) || (() => {
            const hours = diffMs / 3600000
            return ((post.like_count as number) || 0) * 3 +
              ((post.comment_count as number) || 0) * 5 +
              ((post.view_count as number) || 0) * 0.1 -
              Math.log(hours + 2) * 2
          })()

          return {
            id: post.id as string,
            group: groupName,
            group_id: (post.group_id as string) || undefined,
            title: (post.title as string) || '无标题',
            author: (post.author_handle as string) || '匿名',
            author_handle: post.author_handle as string,
            time: timeStr,
            body: (post.content as string) || '',
            comments: (post.comment_count as number) || 0,
            likes: (post.like_count as number) || 0,
            hotScore,
            views: (post.view_count as number) || 0,
            created_at: post.created_at as string,
          }
        })
        setPosts(postsData)
        // Set latestPostTime from the most recent post
        if (postsData.length > 0 && postsData[0].created_at) {
          latestPostTime.current = postsData[0].created_at
        }
        setNewPostCount(0)
      } else {
        setPosts([])
      }
    } catch (e) {
      console.error('Failed to load posts:', e)
      setPosts([])
      showToast(language === 'zh' ? '加载热榜失败' : 'Failed to load hot posts', 'error')
    } finally {
      setLoadingPosts(false)
    }
  }, [showToast, language])

  useEffect(() => {
    loadPosts()
  }, [loadPosts])

  // Load groups when groups tab is active
  useEffect(() => {
    if (activeHotTab !== 'groups') return
    const loadGroups = async () => {
      setLoadingGroups(true)
      try {
        const res = await fetch('/api/groups?sort_by=activity&limit=10')
        const json = await res.json()
        const data = json.groups || json.data || []
        setGroups(data.map((g: Record<string, unknown>) => ({
          id: (g.id as string) || '',
          name: (g.name as string) || '',
          member_count: (g.member_count as number) || 0,
        })))
      } catch {
        setGroups([])
      } finally {
        setLoadingGroups(false)
      }
    }
    loadGroups()
  }, [activeHotTab])

  // New content polling (every 60s)
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!latestPostTime.current) return
      try {
        const res = await fetch(`/api/posts?sort_by=hot_score&sort_order=desc&limit=1&after=${latestPostTime.current}`)
        const json = await res.json()
        const data = json.posts || json.data?.posts || []
        if (data.length > 0) {
          setNewPostCount(prev => prev + data.length)
        }
      } catch {
        // Silent fail for polling
      }
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  const visibleHot = useMemo(() => {
    return loggedIn ? hotPosts : hotPosts.slice(0, 20)
  }, [loggedIn, hotPosts])

  // 加载评论（初始加载）
  const loadComments = useCallback(async (postId: string) => {
    try {
      setLoadingComments(true)
      setCommentsOffset(0)
      setHasMoreComments(true)

      const response = await fetch(`/api/posts/${postId}/comments?limit=${COMMENTS_PER_PAGE}&offset=0`)
      const json = await response.json()
      if (response.ok && json.success) {
        const commentsData = json.data?.comments || []
        setComments(commentsData)
        setHasMoreComments(json.meta?.pagination?.has_more ?? false)
        setCommentsOffset(COMMENTS_PER_PAGE)
      } else {
        setComments([])
        setHasMoreComments(false)
      }
    } catch (err) {
      console.error('[HotPage] 加载评论失败:', err)
      setComments([])
      setHasMoreComments(false)
      showToast(language === 'zh' ? '加载评论失败' : 'Failed to load comments', 'error')
    } finally {
      setLoadingComments(false)
    }
  }, [showToast, language])

  // 加载更多评论
  const loadMoreComments = useCallback(async () => {
    if (!openPost || loadingMoreComments || !hasMoreComments) return

    try {
      setLoadingMoreComments(true)
      const response = await fetch(`/api/posts/${openPost.id}/comments?limit=${COMMENTS_PER_PAGE}&offset=${commentsOffset}`)
      const json = await response.json()

      if (response.ok && json.success) {
        const newComments = json.data?.comments || []
        setComments(prev => [...prev, ...newComments])
        setHasMoreComments(json.meta?.pagination?.has_more ?? false)
        setCommentsOffset(prev => prev + COMMENTS_PER_PAGE)
      } else {
        setHasMoreComments(false)
      }
    } catch (err) {
      console.error('[HotPage] 加载更多评论失败:', err)
    } finally {
      setLoadingMoreComments(false)
    }
  }, [openPost, commentsOffset, loadingMoreComments, hasMoreComments])

  // 检测文本是否是中文
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1
  }, [])

  // 批量翻译列表帖子（使用批量API，带缓存）
  const translateListPosts = useCallback(async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
    if (translatingList) return
    
    const needsTranslation = postsToTranslate.filter(p => {
      if (translatedListPosts[p.id]?.title) return false
      if (!p.title) return false
      const titleIsChinese = isChineseText(p.title)
      return targetLang === 'en' ? titleIsChinese : !titleIsChinese
    })
    
    if (needsTranslation.length === 0) return
    
    setTranslatingList(true)
    
    try {
      // 使用批量翻译API
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
            const post = postsToTranslate.find(p => p.id === id)
            updated[id] = { title: result.translatedText, body: post?.body }
          }
          return updated
        })
        
      }
    } catch {
      // 翻译失败，静默处理
    } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts, isChineseText])

  // 当帖子加载或语言变化时翻译列表
  useEffect(() => {
    if (posts.length > 0) {
      translateListPosts(posts, language as 'zh' | 'en')
    }
  }, [posts, language, translateListPosts])

  // 翻译帖子内容（带缓存）
  const translateContent = useCallback(async (postId: string, content: string, targetLang: 'zh' | 'en') => {
    const cacheKey = `${postId}-content-${targetLang}`
    
    if (translationCache[cacheKey]) {
      setTranslatedContent(translationCache[cacheKey])
      setShowingOriginal(false)
      return
    }

    setTranslating(true)
    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getCsrfHeaders()
        },
        body: JSON.stringify({ 
          text: content, 
          targetLang,
          contentType: 'post_content',
          contentId: postId,
        }),
      })
      const data = await response.json()
      
      if (response.ok && data.success && data.data?.translatedText) {
        const translated = data.data.translatedText
        setTranslatedContent(translated)
        setShowingOriginal(false)
        setTranslationCache(prev => ({ ...prev, [cacheKey]: translated }))
      } else {
        showToast(data.error || '翻译失败', 'error')
      }
    } catch {
      showToast('翻译服务出错', 'error')
    } finally {
      setTranslating(false)
    }
  }, [translationCache, showToast])

  // Track whether this modal was opened via navigation (for back button handling)
  const openedViaNav = useRef(false)

  // 打开帖子详情
  const handleOpenPost = useCallback((post: Post, fromUrlRestore = false) => {
    setOpenPost(post)
    setComments([])
    setTranslatedContent(null)
    setShowingOriginal(true)
    loadComments(post.id)

    // 更新 URL，添加 postId 参数
    if (!fromUrlRestore) {
      const params = new URLSearchParams(searchParams.toString())
      params.set('post', post.id)
      openedViaNav.current = true
      router.push(`/hot?${params.toString()}`, { scroll: false })
    }

    // 自动检测并翻译
    if (post.body) {
      const isChinese = isChineseText(post.body)
      const needsTranslation = (language === 'en' && isChinese) || (language === 'zh' && !isChinese)

      if (needsTranslation) {
        translateContent(post.id, post.body, language)
      }
    }
  }, [loadComments, language, isChineseText, translateContent, searchParams, router])

  // 关闭帖子详情
  const handleClosePost = useCallback(() => {
    setOpenPost(null)
    if (openedViaNav.current) {
      // We pushed a history entry when opening, so go back
      openedViaNav.current = false
      router.back()
    } else {
      // Fallback: direct URL access or restored from URL, use replace
      const params = new URLSearchParams(searchParams.toString())
      params.delete('post')
      const newUrl = params.toString() ? `/hot?${params.toString()}` : '/hot'
      router.replace(newUrl, { scroll: false })
    }
  }, [searchParams, router])

  // 从 URL 参数恢复帖子详情弹窗状态
  useEffect(() => {
    const postId = searchParams.get('post')
    if (postId && posts.length > 0 && !openPost) {
      const post = posts.find(p => p.id === postId)
      if (post) {
        handleOpenPost(post, true) // fromUrlRestore: don't push history again
      }
    }
  }, [searchParams, posts, openPost, handleOpenPost])

  // ESC key handler, body scroll lock, and browser back button support for modal
  useEffect(() => {
    if (!openPost) return
    // Lock body scroll
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClosePost()
      }
    }

    const handlePopState = () => {
      // When user presses back, close modal if URL no longer has post param
      const urlParams = new URLSearchParams(window.location.search)
      if (!urlParams.get('post') && openPost) {
        setOpenPost(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('popstate', handlePopState)

    return () => {
      document.body.style.overflow = prev
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('popstate', handlePopState)
    }
  }, [openPost, handleClosePost])

  // 语言切换时重新翻译当前打开的帖子
  useEffect(() => {
    if (openPost && openPost.body) {
      const isChinese = isChineseText(openPost.body)
      const needsTranslation = (language === 'en' && isChinese) || (language === 'zh' && !isChinese)
      
      // 重置翻译状态
      setTranslatedContent(null)
      setShowingOriginal(true)
      
      if (needsTranslation) {
        translateContent(openPost.id, openPost.body, language)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]) // 只监听语言变化

  // 提交评论
  const submitComment = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(language === 'zh' ? '请先登录' : 'Please log in first', 'warning')
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

      if (!response.ok) {
        // Differentiate error types
        if (response.status === 401) {
          showToast(language === 'zh' ? '登录已过期，请重新登录' : 'Session expired, please log in again', 'error')
        } else if (response.status === 403) {
          showToast(language === 'zh' ? '权限不足' : 'Permission denied', 'error')
        } else if (response.status >= 500) {
          showToast(language === 'zh' ? '服务异常，请稍后重试' : 'Server error, please try again', 'error')
        } else {
          const json = await response.json().catch(() => null)
          showToast(json?.error?.message || (language === 'zh' ? '发表评论失败' : 'Failed to post comment'), 'error')
        }
        return
      }

      const json = await response.json()
      if (json.success && json.data?.comment) {
        setNewComment('')
        // Server ACK received - add comment to state
        setComments(prev => [...prev, json.data.comment])
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comments: p.comments + 1 }
          }
          return p
        }))
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, comments: prev.comments + 1 } : null)
        }
      } else {
        showToast(json.error?.message || (language === 'zh' ? '发表评论失败' : 'Failed to post comment'), 'error')
      }
    } catch (err) {
      console.error('[HotPage] 提交评论失败:', err)
      showToast(language === 'zh' ? '网络异常，请重试' : 'Network error, please retry', 'error')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, openPost?.id, showToast, language])

  // 点赞/踩
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) {
      showToast('请先登录', 'warning')
      return
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
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              likes: result.like_count,
              dislikes: result.dislike_count,
              user_reaction: result.reaction,
            }
          }
          return p
        }))
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? {
            ...prev,
            likes: result.like_count,
            dislikes: result.dislike_count,
            user_reaction: result.reaction,
          } : null)
        }
      }
    } catch (err) {
      console.error('[HotPage] 点赞失败:', err)
      showToast(language === 'zh' ? '操作失败，请重试' : 'Action failed, please retry', 'error')
    }
  }, [accessToken, openPost?.id, showToast, language])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box className="hot-grid">
          {/* 左：排名前十 */}
          <Box as="section">
            <Card title={t('top10')}>
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={loggedIn} />
            </Card>
          </Box>

          {/* 中：热榜 */}
          <Box as="section">
            <Card title={t('hotList')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {loggedIn ? t('loggedInShowAllHot') : t('notLoggedInShowLimitedHot')}
              </Text>

              {/* Tabbed Sections */}
              <Box style={{ display: 'flex', gap: '8px', marginBottom: tokens.spacing[3], flexWrap: 'wrap' }}>
                {([
                  { value: 'posts' as const, label: '热门帖子' },
                  { value: 'traders' as const, label: '热门交易员' },
                  { value: 'groups' as const, label: '热门小组' },
                ]).map((tab) => (
                  <button
                    key={tab.value}
                    onClick={() => setActiveHotTab(tab.value)}
                    style={{
                      padding: '8px 16px',
                      borderRadius: tokens.radius.lg,
                      border: activeHotTab === tab.value ? 'none' : tokens.glass.border.light,
                      background: activeHotTab === tab.value ? tokens.gradient.primary : tokens.glass.bg.light,
                      backdropFilter: tokens.glass.blur.sm,
                      WebkitBackdropFilter: tokens.glass.blur.sm,
                      color: activeHotTab === tab.value ? '#fff' : tokens.colors.text.secondary,
                      fontWeight: activeHotTab === tab.value ? 900 : 600,
                      fontSize: '12px',
                      cursor: 'pointer',
                      transition: tokens.transition.all,
                      boxShadow: activeHotTab === tab.value ? `0 4px 12px ${tokens.colors.accent.primary}40` : 'none',
                    }}
                    onMouseEnter={(e) => {
                      if (activeHotTab !== tab.value) {
                        e.currentTarget.style.background = tokens.glass.bg.medium
                        e.currentTarget.style.color = tokens.colors.text.primary
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (activeHotTab !== tab.value) {
                        e.currentTarget.style.background = tokens.glass.bg.light
                        e.currentTarget.style.color = tokens.colors.text.secondary
                      }
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </Box>

              {/* Tab Content: Hot Posts */}
              {activeHotTab === 'posts' && (
                <>
                  {loadingPosts ? (
                    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                      <Text color="tertiary">{t('loading')}</Text>
                    </Box>
                  ) : visibleHot.length === 0 ? (
                    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                      <Text color="tertiary">{t('noData')}</Text>
                    </Box>
                  ) : (
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3], position: 'relative' }}>
                      {/* New posts polling banner */}
                      {newPostCount > 0 && (
                        <Box
                          onClick={() => {
                            loadPosts()
                          }}
                          style={{
                            position: 'sticky',
                            top: 0,
                            zIndex: 10,
                            background: ARENA_PURPLE,
                            borderRadius: tokens.radius.md,
                            padding: '10px 16px',
                            textAlign: 'center',
                            cursor: 'pointer',
                            color: '#fff',
                            fontWeight: 700,
                            fontSize: '13px',
                          }}
                        >
                          {newPostCount} 条新帖子
                        </Box>
                      )}

                      {visibleHot.map((p, idx) => {
                        const rank = idx + 1
                        return (
                          <Box
                            key={p.id}
                            className="hot-post-item"
                            bg="primary"
                            p={4}
                            radius="md"
                            border="primary"
                            style={{
                              cursor: 'pointer',
                            }}
                            onClick={(e: React.MouseEvent) => {
                              if ((e.target as HTMLElement).closest('a, button, [role="button"], input, textarea, select')) return
                              handleOpenPost(p)
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.background = tokens.colors.bg.secondary
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.background = tokens.colors.bg.primary
                            }}
                          >
                            <Box className="hot-post-meta" style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap', alignItems: 'center' }}>
                              <Text className="hot-post-rank" size="sm" weight="black" style={{ color: rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                                #{rank}
                              </Text>
                              {p.group_id ? (
                                <Link
                                  href={`/groups/${p.group_id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{
                                    fontSize: tokens.typography.fontSize.xs,
                                    color: ARENA_PURPLE,
                                    textDecoration: 'none',
                                    padding: '1px 6px',
                                    background: `${ARENA_PURPLE}15`,
                                    borderRadius: tokens.radius.sm,
                                  }}
                                >
                                  {p.group}
                                </Link>
                              ) : (
                                <Text size="xs" color="secondary">{p.group}</Text>
                              )}
                              <Text size="xs" color="tertiary">{(p.views ?? 0).toLocaleString()} {t('views')}</Text>
                            </Box>
                            <Text className="hot-post-title" size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                              {translatedListPosts[p.id]?.title || p.title}
                            </Text>
                            {(() => {
                              const isExpanded = expandedPosts[p.id]
                              const isLongContent = p.body.length > 100
                              const contentToShow = isExpanded || !isLongContent
                                ? p.body
                                : p.body.slice(0, 100) + '...'
                              return (
                                <>
                                  <Text className="hot-post-body" size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2], lineHeight: 1.5 }}>
                                    {renderContentWithLinks(contentToShow)}
                                  </Text>
                                  {isLongContent && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setExpandedPosts(prev => ({ ...prev, [p.id]: !prev[p.id] }))
                                      }}
                                      style={{
                                        background: 'transparent',
                                        border: 'none',
                                        color: ARENA_PURPLE,
                                        cursor: 'pointer',
                                        fontSize: 12,
                                        marginBottom: tokens.spacing[2],
                                        padding: 0,
                                      }}
                                    >
                                      {isExpanded
                                        ? (language === 'zh' ? '收起' : 'Show less')
                                        : (language === 'zh' ? '展开查看' : 'Show more')}
                                    </button>
                                  )}
                                </>
                              )
                            })()}
                            <Box className="hot-post-footer" style={{ display: 'flex', gap: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary, flexWrap: 'wrap', alignItems: 'center' }}>
                              {p.author_handle ? (
                                <Link
                                  href={`/u/${encodeURIComponent(p.author_handle)}`}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{
                                    fontSize: tokens.typography.fontSize.xs,
                                    color: tokens.colors.text.secondary,
                                    textDecoration: 'none',
                                    fontWeight: 600,
                                  }}
                                >
                                  @{p.author}
                                </Link>
                              ) : (
                                <Text size="xs" color="tertiary">{p.author}</Text>
                              )}
                              <Text size="xs" color="tertiary">{p.time}</Text>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <CommentIcon size={12} /> {p.comments}
                              </span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <ThumbsUpIcon size={12} /> {p.likes}
                              </span>
                            </Box>
                          </Box>
                        )
                      })}

                      {/* Blurred preview cards for anonymous users */}
                      {!loggedIn && hotPosts.length > visibleHot.length && (
                        <>
                          {hotPosts.slice(visibleHot.length, visibleHot.length + 3).map((p, idx) => {
                            const rank = visibleHot.length + idx + 1
                            return (
                              <Box
                                key={`blur-${p.id}`}
                                bg="primary"
                                p={4}
                                radius="md"
                                border="primary"
                                style={{
                                  filter: 'blur(6px)',
                                  pointerEvents: 'none',
                                  opacity: 0.5,
                                }}
                              >
                                <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap', alignItems: 'center' }}>
                                  <Text size="sm" weight="black" style={{ color: tokens.colors.text.secondary }}>
                                    #{rank}
                                  </Text>
                                  <Text size="xs" color="secondary">{p.group}</Text>
                                  <Text size="xs" color="tertiary">{(p.views ?? 0).toLocaleString()} {t('views')}</Text>
                                </Box>
                                <Text size="base" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                                  {p.title}
                                </Text>
                                <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2], lineHeight: 1.5 }}>
                                  {p.body.slice(0, 100)}...
                                </Text>
                                <Box style={{ display: 'flex', gap: tokens.spacing[3], fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
                                  <Text size="xs" color="tertiary">{p.author}</Text>
                                  <Text size="xs" color="tertiary">{p.time}</Text>
                                </Box>
                              </Box>
                            )
                          })}

                          {/* Prominent login CTA */}
                          <Box style={{
                            background: tokens.gradient.primarySubtle,
                            borderRadius: tokens.radius.lg,
                            padding: tokens.spacing[6],
                            textAlign: 'center',
                          }}>
                            <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                              登录查看完整热榜
                            </Text>
                            <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
                              登录后解锁所有热门帖子和交互功能
                            </Text>
                            <Link
                              href="/login"
                              style={{
                                display: 'inline-block',
                                padding: '10px 24px',
                                background: tokens.gradient.primary,
                                color: '#fff',
                                borderRadius: tokens.radius.md,
                                textDecoration: 'none',
                                fontWeight: 700,
                                fontSize: '14px',
                              }}
                            >
                              立即登录
                            </Link>
                          </Box>
                        </>
                      )}
                    </Box>
                  )}
                </>
              )}

              {/* Tab Content: Hot Traders */}
              {activeHotTab === 'traders' && (
                <>
                  {loadingTraders ? (
                    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                      <Text color="tertiary">{t('loading')}</Text>
                    </Box>
                  ) : traders.length === 0 ? (
                    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                      <Text color="tertiary">{t('noData')}</Text>
                    </Box>
                  ) : (
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                      {traders.map((trader, idx) => (
                        <Box
                          key={trader.id}
                          bg="primary"
                          p={4}
                          radius="md"
                          border="primary"
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            if (trader.handle) {
                              router.push(`/trader/${encodeURIComponent(trader.handle)}`)
                            }
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = tokens.colors.bg.secondary
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = tokens.colors.bg.primary
                          }}
                        >
                          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                              <Text size="sm" weight="black" style={{ color: idx < 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                                #{idx + 1}
                              </Text>
                              <Text size="base" weight="bold">
                                {trader.handle || 'Unknown'}
                              </Text>
                              {trader.source && (
                                <Text size="xs" color="tertiary" style={{ textTransform: 'uppercase' }}>
                                  {trader.source}
                                </Text>
                              )}
                            </Box>
                            <Box style={{ display: 'flex', gap: tokens.spacing[4], alignItems: 'center' }}>
                              <Text size="sm" style={{ color: trader.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
                                ROI {trader.roi.toFixed(1)}%
                              </Text>
                              <Text size="xs" color="tertiary">
                                {trader.followers.toLocaleString()} followers
                              </Text>
                            </Box>
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  )}
                </>
              )}

              {/* Tab Content: Hot Groups */}
              {activeHotTab === 'groups' && (
                <>
                  {loadingGroups ? (
                    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                      <Text color="tertiary">{t('loading')}</Text>
                    </Box>
                  ) : groups.length === 0 ? (
                    <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                      <Text color="tertiary">{t('noData')}</Text>
                    </Box>
                  ) : (
                    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                      {groups.map((group, idx) => (
                        <Box
                          key={group.id}
                          bg="primary"
                          p={4}
                          radius="md"
                          border="primary"
                          style={{ cursor: 'pointer' }}
                          onClick={() => router.push(`/groups/${group.id}`)}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = tokens.colors.bg.secondary
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = tokens.colors.bg.primary
                          }}
                        >
                          <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                              <Text size="sm" weight="black" style={{ color: idx < 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                                #{idx + 1}
                              </Text>
                              <Text size="base" weight="bold">
                                {group.name}
                              </Text>
                            </Box>
                            <Text size="xs" color="tertiary">
                              {group.member_count.toLocaleString()} 成员
                            </Text>
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  )}
                </>
              )}
            </Card>
          </Box>

          {/* 右：市场 */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* 帖子详情弹窗 - Portal to body to avoid stacking context issues */}
      {openPost && createPortal(
        <div
          onClick={handleClosePost}
          role="dialog"
          aria-modal="true"
          aria-label={openPost.title}
          style={{
            position: 'fixed',
            inset: 0,
            background: tokens.colors.overlay.dark,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            zIndex: tokens.zIndex.modal,
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
              <button
                onClick={handleClosePost}
                aria-label="Close"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  cursor: 'pointer',
                  fontSize: 20,
                  width: 44,
                  height: 44,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 8,
                }}
              >
                ×
              </button>
            </div>

            {/* Group name - clickable link */}
            {openPost.group_id ? (
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
                {openPost.group}
              </Link>
            ) : (
              <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
                {openPost.group}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{openPost.title}</div>
            </div>

            {/* Author - clickable link */}
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
                  @{openPost.author}
                </Link>
              ) : (
                <span>{openPost.author}</span>
              )}
              <span>·</span>
              <span>{openPost.time}</span>
              <span>·</span>
              <CommentIcon size={12} />
              <span>{openPost.comments}</span>
            </div>

            <div translate="no" style={{ marginTop: 12, fontSize: 14, color: tokens.colors.text.primary, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {showingOriginal
                ? renderContentWithLinks(openPost.body || '')
                : renderContentWithLinks(translatedContent || openPost.body || '')
              }
            </div>

            {/* 翻译/原文切换按钮 */}
            {(translatedContent || translating) && (
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

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${tokens.colors.border.secondary}`, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <button
                onClick={() => toggleReaction(openPost.id, 'up')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  border: 'none',
                  borderRadius: 8,
                  background: openPost.user_reaction === 'up' ? `${tokens.colors.accent.success}20` : tokens.colors.bg.tertiary,
                  color: openPost.user_reaction === 'up' ? tokens.colors.accent.success : tokens.colors.text.secondary,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <ThumbsUpIcon size={14} /> {openPost.likes}
              </button>
              <button
                onClick={() => toggleReaction(openPost.id, 'down')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  border: 'none',
                  borderRadius: 8,
                  background: openPost.user_reaction === 'down' ? `${tokens.colors.accent.error}20` : tokens.colors.bg.tertiary,
                  color: openPost.user_reaction === 'down' ? tokens.colors.accent.error : tokens.colors.text.secondary,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                <ThumbsDownIcon size={14} />
              </button>
            </div>

            {/* 评论区 */}
            <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.colors.border.secondary}`, paddingTop: 16 }}>
              <div style={{ fontWeight: 950, marginBottom: 12 }}>
                {t('comments')} ({openPost.comments})
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
                    padding: 12,
                    borderRadius: 8,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    fontSize: 14,
                    resize: 'vertical',
                    outline: 'none',
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
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: newComment.trim() && !submittingComment ? 'pointer' : 'not-allowed',
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
                  {comments.filter(Boolean).map((comment) => (
                    <div
                      key={comment.id}
                      style={{
                        padding: 12,
                        background: tokens.colors.bg.primary,
                        borderRadius: 8,
                        border: `1px solid ${tokens.colors.border.primary}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        {comment.author_handle ? (
                          <Link
                            href={`/u/${encodeURIComponent(comment.author_handle)}`}
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              color: tokens.colors.text.secondary,
                              textDecoration: 'none',
                            }}
                          >
                            @{comment.author_handle}
                          </Link>
                        ) : (
                          <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary }}>
                            匿名
                          </span>
                        )}
                        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                          {formatTimeAgo(comment.created_at)}
                        </span>
                      </div>
                      <div translate="no" style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
                        {renderContentWithLinks(comment.content || '')}
                      </div>
                    </div>
                  ))}

                  {/* 加载更多评论按钮 */}
                  {hasMoreComments && (
                    <button
                      onClick={loadMoreComments}
                      disabled={loadingMoreComments}
                      style={{
                        padding: '10px 16px',
                        background: 'transparent',
                        border: `1px solid ${tokens.colors.border.primary}`,
                        borderRadius: 8,
                        color: tokens.colors.text.secondary,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: loadingMoreComments ? 'not-allowed' : 'pointer',
                        opacity: loadingMoreComments ? 0.6 : 1,
                        transition: 'all 0.2s ease',
                        width: '100%',
                        marginTop: 4,
                      }}
                      onMouseEnter={(e) => {
                        if (!loadingMoreComments) {
                          e.currentTarget.style.borderColor = tokens.colors.accent.primary
                          e.currentTarget.style.color = tokens.colors.accent.primary
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = tokens.colors.border.primary
                        e.currentTarget.style.color = tokens.colors.text.secondary
                      }}
                    >
                      {loadingMoreComments ? '加载中...' : '加载更多评论'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </Box>
  )
}

export default function HotPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <HotContent />
    </Suspense>
  )
}
