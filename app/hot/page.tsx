'use client'

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import MarketPanel from '@/app/components/Features/MarketPanel'
import Card from '@/app/components/UI/Card'
import RankingTableCompact from '@/app/components/Features/RankingTableCompact'
import { Box, Text } from '@/app/components/Base'
import { CommentIcon, ThumbsUpIcon, ThumbsDownIcon } from '@/app/components/Icons'
import { useToast } from '@/app/components/UI/Toast'
import { formatTimeAgo } from '@/lib/utils/date'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'
import { getCsrfHeaders } from '@/lib/api/client'

// Use design tokens for brand color
const ARENA_PURPLE = '#8b6fa8' // fallback, prefer tokens.colors.accent.brand

// 链接解析函数 - 将文本中的URL转换为可点击链接
function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0 // Reset regex state
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

// 本地 Trader 类型
type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
  source?: string
}
import { useLanguage } from '@/app/components/Utils/LanguageProvider'

type Post = {
  id: string
  group: string
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
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  const [posts, setPosts] = useState<Post[]>([])
  const [loadingPosts, setLoadingPosts] = useState(true)
  
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

  // 加载交易员数据 - 使用统一的 API
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const response = await fetch('/api/traders?timeRange=90D')
        const json = await response.json()
        
        // API 返回格式是 { traders: [...] }
        const tradersData = json.traders || json.data || []
        if (tradersData.length > 0) {
          // 取前10名
          interface TraderResponse {
            id?: string
            source_trader_id?: string
            handle?: string
            roi?: number
            pnl?: number
            win_rate?: number
            max_drawdown?: number
            followers?: number
            source?: string
          }
          const top10 = tradersData.slice(0, 10).map((item: TraderResponse) => ({
            id: item.id || item.source_trader_id || '',
            handle: item.handle || item.source_trader_id || null,
            roi: item.roi || 0,
            pnl: item.pnl || 0,
            win_rate: item.win_rate || 0,
            max_drawdown: item.max_drawdown,
            followers: item.followers || 0,
            source: item.source || 'binance',
          }))
          setTraders(top10)
        } else {
          setTraders([])
        }
      } catch (error) {
        setTraders([])
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  // 从数据库加载热榜帖子
  useEffect(() => {
    const loadPosts = async () => {
      setLoadingPosts(true)
      try {
        // 从数据库获取热门帖子
        const { data, error } = await supabase
          .from('posts')
          .select(`
            id,
            title,
            content,
            author_handle,
            created_at,
            like_count,
            dislike_count,
            comment_count,
            view_count,
            hot_score,
            group_id,
            groups(name)
          `)
          .order('hot_score', { ascending: false, nullsFirst: false })
          .order('view_count', { ascending: false, nullsFirst: false })
          .order('like_count', { ascending: false, nullsFirst: false })
          .limit(20)

        if (error) {
          console.error('Failed to load hot posts:', error)
          setPosts([])
          setLoadingPosts(false)
          return
        }

        if (data && data.length > 0) {
          const postsData: Post[] = data.map((post) => {
            // 计算时间差
            const createdAt = new Date(post.created_at)
            const now = new Date()
            const diffMs = now.getTime() - createdAt.getTime()
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
            const diffDays = Math.floor(diffHours / 24)

            let timeStr = ''
            if (diffDays > 0) {
              timeStr = `${diffDays}d`
            } else if (diffHours > 0) {
              timeStr = `${diffHours}h`
            } else {
              const diffMins = Math.floor(diffMs / (1000 * 60))
              timeStr = `${diffMins}m`
            }

            // groups 是关联查询的结果，可能是对象或数组
            const groupsData = post.groups as { name?: string } | { name?: string }[] | null
            const groupName = Array.isArray(groupsData)
              ? groupsData[0]?.name
              : groupsData?.name

            return {
              id: post.id,
              group: groupName || '综合讨论',
              title: post.title || '无标题',
              author: post.author_handle || '匿名',
              author_handle: post.author_handle,
              time: timeStr,
              body: post.content || '',
              comments: post.comment_count || 0,
              likes: post.like_count || 0,
              hotScore: post.hot_score || 
                (post.view_count || 0) * 0.1 + 
                (post.like_count || 0) * 2 + 
                (post.comment_count || 0) * 3,
              views: post.view_count || 0,
            }
          })
          setPosts(postsData)
        } else {
          setPosts([])
        }
      } catch (e) {
        console.error('Failed to load posts:', e)
        setPosts([])
      } finally {
        setLoadingPosts(false)
      }
    }
    
    loadPosts()
  }, [])

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  const visibleHot = useMemo(() => {
    return loggedIn ? hotPosts : hotPosts.slice(0, 3) // 未登录只显示前3条
  }, [loggedIn, hotPosts])

  // 加载评论（初始加载）
  const loadComments = useCallback(async (postId: string) => {
    try {
      setLoadingComments(true)
      setCommentsOffset(0)
      setHasMoreComments(true)
      
      const response = await fetch(`/api/posts/${postId}/comments?limit=${COMMENTS_PER_PAGE}&offset=0`)
      const data = await response.json()
      if (response.ok) {
        setComments(data.comments || [])
        setHasMoreComments(data.pagination?.has_more ?? false)
        setCommentsOffset(COMMENTS_PER_PAGE)
      } else {
        setComments([])
        setHasMoreComments(false)
      }
    } catch (err) {
      console.error('[HotPage] 加载评论失败:', err)
      setComments([])
      setHasMoreComments(false)
    } finally {
      setLoadingComments(false)
    }
  }, [])

  // 加载更多评论
  const loadMoreComments = useCallback(async () => {
    if (!openPost || loadingMoreComments || !hasMoreComments) return
    
    try {
      setLoadingMoreComments(true)
      const response = await fetch(`/api/posts/${openPost.id}/comments?limit=${COMMENTS_PER_PAGE}&offset=${commentsOffset}`)
      const data = await response.json()
      
      if (response.ok) {
        const newComments = data.comments || []
        setComments(prev => [...prev, ...newComments])
        setHasMoreComments(data.pagination?.has_more ?? false)
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

  // 打开帖子详情
  const handleOpenPost = useCallback((post: Post) => {
    setOpenPost(post)
    setComments([])
    setTranslatedContent(null)
    setShowingOriginal(true)
    loadComments(post.id)

    // 更新 URL，添加 postId 参数
    const params = new URLSearchParams(searchParams.toString())
    params.set('post', post.id)
    router.replace(`/hot?${params.toString()}`, { scroll: false })

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
    // 移除 URL 中的 postId 参数
    const params = new URLSearchParams(searchParams.toString())
    params.delete('post')
    const newUrl = params.toString() ? `/hot?${params.toString()}` : '/hot'
    router.replace(newUrl, { scroll: false })
  }, [searchParams, router])

  // 从 URL 参数恢复帖子详情弹窗状态
  useEffect(() => {
    const postId = searchParams.get('post')
    if (postId && posts.length > 0 && !openPost) {
      const post = posts.find(p => p.id === postId)
      if (post) {
        handleOpenPost(post)
      }
    }
  }, [searchParams, posts, openPost, handleOpenPost])

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
  }, [language]) // 只监听语言变化

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
        setNewComment('')
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
        showToast(json.error || '发表评论失败', 'error')
      }
    } catch (err) {
      console.error('[HotPage] 提交评论失败:', err)
      showToast('发表评论失败', 'error')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, openPost?.id, showToast])

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
    }
  }, [accessToken, openPost?.id, showToast])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box className="hot-grid" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
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
              
              {loadingPosts ? (
                <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  <Text color="tertiary">{t('loading')}</Text>
                </Box>
              ) : visibleHot.length === 0 ? (
                <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
                  <Text color="tertiary">{t('noData')}</Text>
                </Box>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
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
                        onClick={() => handleOpenPost(p)}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = tokens.colors.bg.secondary
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = tokens.colors.bg.primary
                        }}
                      >
                        <Box className="hot-post-meta" style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap' }}>
                          <Text className="hot-post-rank" size="sm" weight="black" style={{ color: rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                            #{rank}
                          </Text>
                          <Text size="xs" color="secondary">{p.group}</Text>
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
                          <Text size="xs" color="tertiary">{p.author}</Text>
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
                </Box>
              )}
              
              {!loggedIn && posts.length > 3 && (
                <Box style={{ marginTop: tokens.spacing[4], padding: tokens.spacing[3], textAlign: 'center' }}>
                  <Text size="sm" color="secondary">
                    {t('wantToSeeAllHotList')}
                    <Link href="/login" style={{ color: tokens.colors.accent.primary, textDecoration: 'none', marginLeft: tokens.spacing[1] }}>
                      {t('loginArrow')} →
                    </Link>
                  </Text>
                </Box>
              )}
            </Card>
          </Box>

          {/* 右：市场 */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* 帖子详情弹窗 */}
      {openPost && (
        <div
          onClick={handleClosePost}
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

            <div style={{ fontSize: 12, color: ARENA_PURPLE }}>
              {openPost.group}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{openPost.title}</div>
            </div>

            <div style={{ marginTop: 8, fontSize: 12, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 6 }}>
              {openPost.author} · {openPost.time} · <CommentIcon size={12} /> {openPost.comments}
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
                        <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary }}>
                          {comment.author_handle || '匿名'}
                        </span>
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
        </div>
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
