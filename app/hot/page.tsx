'use client'

import { useEffect, useMemo, useState, useCallback, Suspense } from 'react'
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
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { usePostComments, usePostReaction } from '@/lib/hooks/usePostInteraction'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'

const ARENA_PURPLE = '#8b6fa8'

// Render text with clickable links
function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)

  return parts.map((part, index) => {
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

type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
  source?: string
}

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

function HotContent() {
  const { t, language } = useLanguage()
  const { showToast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()

  // --- Unified Auth (Single Source of Truth) ---
  const { email, isLoggedIn, userId, accessToken, authChecked } = useAuthSession()

  // Translation state
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})

  // Data state
  const [traders, setTraders] = useState<Trader[]>([])
  const [loadingTraders, setLoadingTraders] = useState(true)
  const [posts, setPosts] = useState<Post[]>([])
  const [loadingPosts, setLoadingPosts] = useState(true)

  // Post detail modal state (URL-driven)
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const [newComment, setNewComment] = useState('')

  // --- Unified Post Interactions (Server ACK) ---
  const {
    comments,
    loading: loadingComments,
    loadingMore: loadingMoreComments,
    hasMore: hasMoreComments,
    submitState,
    submitError,
    loadComments,
    loadMore: loadMoreComments,
    submitComment: submitCommentHook,
    reset: resetComments,
  } = usePostComments({ postId: openPost?.id ?? null })

  const { toggleReaction } = usePostReaction()

  // Load traders
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const response = await fetch('/api/traders?timeRange=90D')
        const json = await response.json()
        const tradersData = json.traders || json.data || []
        if (tradersData.length > 0) {
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
      } catch {
        setTraders([])
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  // Load hot posts from database
  useEffect(() => {
    const loadPosts = async () => {
      setLoadingPosts(true)
      try {
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
          setPosts([])
          setLoadingPosts(false)
          return
        }

        if (data && data.length > 0) {
          const postsData: Post[] = data.map((post) => {
            const createdAt = new Date(post.created_at)
            const now = new Date()
            const diffMs = now.getTime() - createdAt.getTime()
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
            const diffDays = Math.floor(diffHours / 24)

            let timeStr = ''
            if (diffDays > 0) timeStr = `${diffDays}d`
            else if (diffHours > 0) timeStr = `${diffHours}h`
            else timeStr = `${Math.floor(diffMs / (1000 * 60))}m`

            const groupsData = post.groups as { name?: string } | { name?: string }[] | null
            const groupName = Array.isArray(groupsData) ? groupsData[0]?.name : groupsData?.name

            return {
              id: post.id,
              group: groupName || '综合讨论',
              group_id: post.group_id || undefined,
              title: post.title || '无标题',
              author: post.author_handle || '匿名',
              author_handle: post.author_handle,
              time: timeStr,
              body: post.content || '',
              comments: post.comment_count || 0,
              likes: post.like_count || 0,
              dislikes: post.dislike_count || 0,
              hotScore: post.hot_score ||
                (post.view_count || 0) * 0.1 +
                (post.like_count || 0) * 2 +
                (post.comment_count || 0) * 3,
              views: post.view_count || 0,
              created_at: post.created_at,
            }
          })
          setPosts(postsData)
        } else {
          setPosts([])
        }
      } catch {
        setPosts([])
      } finally {
        setLoadingPosts(false)
      }
    }
    loadPosts()
  }, [])

  const hotPosts = useMemo(() => {
    return [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
  }, [posts])

  const visibleHot = useMemo(() => {
    return isLoggedIn ? hotPosts : hotPosts.slice(0, 3)
  }, [isLoggedIn, hotPosts])

  // Chinese text detection
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1
  }, [])

  // Batch translate list posts
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
      const items = needsTranslation.slice(0, 20).map(post => ({
        id: post.id,
        text: post.title || '',
        contentType: 'post_title' as const,
        contentId: post.id,
      }))
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
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
    } catch { /* silent */ } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts, isChineseText])

  useEffect(() => {
    if (posts.length > 0) {
      translateListPosts(posts, language as 'zh' | 'en')
    }
  }, [posts, language, translateListPosts])

  // Translate post content
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
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ text: content, targetLang, contentType: 'post_content', contentId: postId }),
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

  // Open post detail (URL-driven)
  const handleOpenPost = useCallback((post: Post) => {
    setOpenPost(post)
    resetComments()
    setTranslatedContent(null)
    setShowingOriginal(true)
    setNewComment('')
    loadComments(post.id)

    // Update URL with post ID
    const params = new URLSearchParams(searchParams.toString())
    params.set('post', post.id)
    router.replace(`/hot?${params.toString()}`, { scroll: false })

    // Prevent body scroll
    document.body.style.overflow = 'hidden'

    // Auto-translate if needed
    if (post.body) {
      const isChinese = isChineseText(post.body)
      const needsTranslation = (language === 'en' && isChinese) || (language === 'zh' && !isChinese)
      if (needsTranslation) translateContent(post.id, post.body, language)
    }
  }, [loadComments, resetComments, language, isChineseText, translateContent, searchParams, router])

  // Close post detail (URL-driven)
  const handleClosePost = useCallback(() => {
    setOpenPost(null)
    resetComments()
    document.body.style.overflow = ''

    const params = new URLSearchParams(searchParams.toString())
    params.delete('post')
    const newUrl = params.toString() ? `/hot?${params.toString()}` : '/hot'
    router.replace(newUrl, { scroll: false })
  }, [searchParams, router, resetComments])

  // Escape key closes modal
  useEffect(() => {
    if (!openPost) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClosePost()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openPost, handleClosePost])

  // Restore modal from URL on load
  useEffect(() => {
    const postId = searchParams.get('post')
    if (postId && posts.length > 0 && !openPost) {
      const post = posts.find(p => p.id === postId)
      if (post) handleOpenPost(post)
    }
  }, [searchParams, posts, openPost, handleOpenPost])

  // Re-translate on language change
  useEffect(() => {
    if (openPost && openPost.body) {
      const isChinese = isChineseText(openPost.body)
      const needsTranslation = (language === 'en' && isChinese) || (language === 'zh' && !isChinese)
      setTranslatedContent(null)
      setShowingOriginal(true)
      if (needsTranslation) translateContent(openPost.id, openPost.body, language)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language])

  // Submit comment (server ACK via unified hook)
  const handleSubmitComment = useCallback(async (postId: string) => {
    if (!newComment.trim()) return
    if (!isLoggedIn) {
      showToast(t('pleaseLoginFirst') || '请先登录', 'warning')
      return
    }

    const comment = await submitCommentHook(newComment, {
      onSuccess: () => {
        setNewComment('')
        // Update local post comment count
        setPosts(prev => prev.map(p =>
          p.id === postId ? { ...p, comments: p.comments + 1 } : p
        ))
        if (openPost?.id === postId) {
          setOpenPost(prev => prev ? { ...prev, comments: prev.comments + 1 } : null)
        }
      }
    })

    if (!comment && submitError) {
      showToast(submitError, 'error')
    }
  }, [newComment, isLoggedIn, submitCommentHook, submitError, openPost?.id, showToast, t])

  // Toggle reaction (server ACK via unified hook)
  const handleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!isLoggedIn) {
      showToast(t('pleaseLoginFirst') || '请先登录', 'warning')
      return
    }

    await toggleReaction(postId, reactionType, {
      onSuccess: (result) => {
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, likes: result.like_count, dislikes: result.dislike_count, user_reaction: result.reaction }
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
      },
      onError: (err) => showToast(err, 'error'),
    })
  }, [isLoggedIn, toggleReaction, openPost?.id, showToast, t])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" className="container-padding" px={4} py={6} style={{ maxWidth: 1200, margin: '0 auto' }}>
        <Box className="hot-grid" style={{ display: 'grid', gridTemplateColumns: '260px 1fr 280px', gap: tokens.spacing[4] }}>
          {/* Left: Top 10 */}
          <Box as="section">
            <Card title={t('top10')}>
              <RankingTableCompact traders={traders} loading={loadingTraders} loggedIn={isLoggedIn} />
            </Card>
          </Box>

          {/* Center: Hot Posts */}
          <Box as="section">
            <Card title={t('hotList')}>
              <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[3] }}>
                {isLoggedIn ? t('loggedInShowAllHot') : t('notLoggedInShowLimitedHot')}
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
                        style={{ cursor: 'pointer' }}
                        onClick={() => handleOpenPost(p)}
                        onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = tokens.colors.bg.primary }}
                      >
                        <Box className="hot-post-meta" style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2], flexWrap: 'wrap' }}>
                          <Text className="hot-post-rank" size="sm" weight="black" style={{ color: rank <= 3 ? tokens.colors.accent.warning : tokens.colors.text.secondary }}>
                            #{rank}
                          </Text>
                          {/* Group name as clickable link */}
                          {p.group_id ? (
                            <Link
                              href={`/groups/${p.group_id}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: ARENA_PURPLE, fontSize: tokens.typography.fontSize.xs, textDecoration: 'none' }}
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
                          {/* Author name as clickable link */}
                          {p.author_handle ? (
                            <Link
                              href={`/u/${p.author_handle}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.xs, textDecoration: 'none', fontWeight: 600 }}
                            >
                              {p.author}
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
                </Box>
              )}

              {!isLoggedIn && posts.length > 3 && (
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

          {/* Right: Market */}
          <Box as="section">
            <MarketPanel />
          </Box>
        </Box>
      </Box>

      {/* Post Detail Modal (URL-driven) */}
      {openPost && (
        <div
          onClick={handleClosePost}
          role="dialog"
          aria-modal="true"
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
            {/* Close button */}
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

            {/* Group name (clickable link) */}
            <div style={{ fontSize: 12 }}>
              {openPost.group_id ? (
                <Link href={`/groups/${openPost.group_id}`} style={{ color: ARENA_PURPLE, textDecoration: 'none' }}>
                  {openPost.group}
                </Link>
              ) : (
                <span style={{ color: ARENA_PURPLE }}>{openPost.group}</span>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 950, lineHeight: 1.25 }}>{openPost.title}</div>
            </div>

            {/* Author (clickable link) + meta */}
            <div style={{ marginTop: 8, fontSize: 12, color: tokens.colors.text.tertiary, display: 'flex', alignItems: 'center', gap: 6 }}>
              {openPost.author_handle ? (
                <Link href={`/u/${openPost.author_handle}`} style={{ color: tokens.colors.text.secondary, textDecoration: 'none', fontWeight: 600 }}>
                  {openPost.author}
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

            {/* Content */}
            <div translate="no" style={{ marginTop: 12, fontSize: 14, color: tokens.colors.text.primary, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
              {showingOriginal
                ? renderContentWithLinks(openPost.body || '')
                : renderContentWithLinks(translatedContent || openPost.body || '')
              }
            </div>

            {/* Translation toggle */}
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
                  {translating ? (language === 'zh' ? '翻译中...' : 'Translating...')
                    : showingOriginal ? (language === 'zh' ? '查看翻译' : 'View Translation')
                    : (language === 'zh' ? '查看原文' : 'View Original')}
                </button>
                {!showingOriginal && (
                  <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                    {language === 'zh' ? '由 AI 翻译' : 'Translated by AI'}
                  </span>
                )}
              </div>
            )}

            {/* Reactions (server ACK) */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${tokens.colors.border.secondary}`, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <button
                onClick={() => handleReaction(openPost.id, 'up')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', border: 'none', borderRadius: 8,
                  background: openPost.user_reaction === 'up' ? `${tokens.colors.accent.success}20` : tokens.colors.bg.tertiary,
                  color: openPost.user_reaction === 'up' ? tokens.colors.accent.success : tokens.colors.text.secondary,
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                <ThumbsUpIcon size={14} /> {openPost.likes}
              </button>
              <button
                onClick={() => handleReaction(openPost.id, 'down')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', border: 'none', borderRadius: 8,
                  background: openPost.user_reaction === 'down' ? `${tokens.colors.accent.error}20` : tokens.colors.bg.tertiary,
                  color: openPost.user_reaction === 'down' ? tokens.colors.accent.error : tokens.colors.text.secondary,
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                <ThumbsDownIcon size={14} />
              </button>
            </div>

            {/* Comments Section (unified hook, server ACK) */}
            <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.colors.border.secondary}`, paddingTop: 16 }}>
              <div style={{ fontWeight: 950, marginBottom: 12 }}>
                {t('comments')} ({openPost.comments})
              </div>

              {/* Comment input */}
              <div style={{ marginBottom: 16 }}>
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder={isLoggedIn ? (t('writeComment') || '写下你的评论...') : '请先登录后发表评论'}
                  disabled={!isLoggedIn || submitState === 'sending'}
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
                {isLoggedIn && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => handleSubmitComment(openPost.id)}
                      disabled={!newComment.trim() || submitState === 'sending'}
                      style={{
                        padding: '8px 16px',
                        background: newComment.trim() && submitState !== 'sending' ? ARENA_PURPLE : 'rgba(139, 111, 168, 0.3)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 8,
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: newComment.trim() && submitState !== 'sending' ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {submitState === 'sending' ? (language === 'zh' ? '发送中...' : 'Sending...') : (language === 'zh' ? '发表评论' : 'Submit')}
                    </button>
                    {submitState === 'error' && submitError && (
                      <span style={{ fontSize: 12, color: tokens.colors.accent.error }}>{submitError}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Comments list */}
              {loadingComments ? (
                <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>
                  {language === 'zh' ? '加载评论中...' : 'Loading comments...'}
                </div>
              ) : comments.length === 0 ? (
                <div style={{ color: tokens.colors.text.tertiary, fontSize: 13 }}>
                  {language === 'zh' ? '暂无评论，来发表第一条评论吧' : 'No comments yet. Be the first!'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {comments.filter(Boolean).map((comment) => (
                    <div
                      key={comment.id}
                      style={{
                        padding: 12,
                        background: tokens.colors.bg.primary,
                        borderRadius: 8,
                        border: `1px solid ${comment._status === 'failed' ? tokens.colors.accent.error : tokens.colors.border.primary}`,
                        opacity: comment._status === 'sending' ? 0.6 : 1,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        {/* Comment author as clickable link */}
                        {comment.author_handle ? (
                          <Link
                            href={`/u/${comment.author_handle}`}
                            style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary, textDecoration: 'none' }}
                          >
                            {comment.author_handle}
                          </Link>
                        ) : (
                          <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.text.secondary }}>
                            {language === 'zh' ? '匿名' : 'Anonymous'}
                          </span>
                        )}
                        <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                          {formatTimeAgo(comment.created_at)}
                        </span>
                        {comment._status === 'sending' && (
                          <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                            {language === 'zh' ? '发送中...' : 'Sending...'}
                          </span>
                        )}
                        {comment._status === 'failed' && (
                          <span style={{ fontSize: 11, color: tokens.colors.accent.error }}>
                            {language === 'zh' ? '发送失败' : 'Failed'}
                          </span>
                        )}
                      </div>
                      <div translate="no" style={{ fontSize: 13, color: tokens.colors.text.primary, lineHeight: 1.6 }}>
                        {renderContentWithLinks(comment.content || '')}
                      </div>
                    </div>
                  ))}

                  {/* Load more comments */}
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
                        width: '100%',
                        marginTop: 4,
                      }}
                    >
                      {loadingMoreComments
                        ? (language === 'zh' ? '加载中...' : 'Loading...')
                        : (language === 'zh' ? '加载更多评论' : 'Load more comments')}
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
