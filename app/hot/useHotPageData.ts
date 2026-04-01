'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { formatTimeAgo } from '@/lib/utils/date'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { localizedLabel } from '@/lib/utils/format'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { logger } from '@/lib/logger'
import type { Trader, Post, Comment } from './types'

interface UseHotPageDataOptions {
  initialPosts?: Post[]
}

export function useHotPageData(options: UseHotPageDataOptions = {}) {
  const { t, language } = useLanguage()
  const localizedName = (zh: string, en?: string | null) => localizedLabel(zh, en, language)
  const { showToast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { accessToken, authChecked, email, userId: currentUserId } = useAuthSession()
  const loggedIn = authChecked && !!accessToken

  // Translation state
  const [translatedContent, setTranslatedContent] = useState<string | null>(null)
  const [showingOriginal, setShowingOriginal] = useState(true)
  const [translating, setTranslating] = useState(false)
  const [translationCache, setTranslationCache] = useState<Record<string, string>>({})
  const [translatedListPosts, setTranslatedListPosts] = useState<Record<string, { title?: string; body?: string }>>({})
  const [translatingList, setTranslatingList] = useState(false)
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})
  const [_traders, setTraders] = useState<Trader[]>([])
  const [_loadingTraders, setLoadingTraders] = useState(true)
  const [posts, setPosts] = useState<Post[]>(options.initialPosts || [])
  const [loadingPosts, setLoadingPosts] = useState(!options.initialPosts || options.initialPosts.length === 0)

  // Tabbed sections state
  const [activeHotTab, setActiveHotTab] = useState<'posts' | 'groups'>('posts')

  // Groups data for the groups tab
  const [groups, setGroups] = useState<{ id: string; name: string; name_en?: string | null; member_count: number }[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)

  const latestPostTime = useRef<string>('')

  // Post detail modal state
  const [openPost, setOpenPost] = useState<Post | null>(null)
  const [comments, setComments] = useState<Comment[]>([])
  const [loadingComments, setLoadingComments] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [submittingComment, setSubmittingComment] = useState(false)

  // Comment pagination
  const COMMENTS_PER_PAGE = 10
  const [commentsOffset, setCommentsOffset] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(true)
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)

  // Suppress unused variable warning
  void currentUserId

  // Load trader data
  useEffect(() => {
    const load = async () => {
      setLoadingTraders(true)
      try {
        const { data, error: supabaseError } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, handle, roi, arena_score, followers, win_rate')
          .not('arena_score', 'is', null)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')
          .order('arena_score', { ascending: false })
          .limit(30)

        if (supabaseError) {
          logger.error('Trader load error:', supabaseError)
          setTraders([])
          return
        }

        const seen = new Set<string>()
        const uniqueData = (data || []).filter(row => {
          const key = `${row.source}:${row.source_trader_id}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, 10)

        // Use handle from leaderboard_ranks directly (no trader_sources lookup needed)
        const isAddr = (v: string) => /^0x[0-9a-fA-F]{10,}$/.test(v)
        const fmtAddr = (v: string) => `${v.slice(0, 6)}...${v.slice(-4)}`

        setTraders(uniqueData.map(item => {
          const h = (item as Record<string, unknown>).handle as string | null
          const sid = item.source_trader_id || ''
          const displayHandle = h && !isAddr(h) ? h : h ? fmtAddr(h) : (sid ? fmtAddr(sid) : null)
          return {
            id: sid,
            handle: displayHandle,
            roi: typeof item.roi === 'string' ? parseFloat(item.roi) : (item.roi || 0),
            win_rate: typeof item.win_rate === 'string' ? parseFloat(item.win_rate) : (item.win_rate || 0),
            followers: item.followers || 0,
            source: item.source || 'binance',
          }
        }))
      } catch (error) {
        logger.error('Trader load error:', error)
        setTraders([])
      } finally {
        setLoadingTraders(false)
      }
    }
    load()
  }, [])

  // Load hot posts from cache API
  const loadPosts = useCallback(async () => {
    setLoadingPosts(true)
    try {
      const headers: Record<string, string> = {}
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`
      }
      const res = await fetch(`/api/posts?sort_by=hot_score&sort_order=desc&limit=30`, { headers })
      const json = await res.json()
      const data = json.posts || json.data?.posts || []

      if (data.length > 0) {
        const postsData: Post[] = data.map((post: Record<string, unknown>) => {
          const createdAt = new Date(post.created_at as string)
          const diffMs = Date.now() - createdAt.getTime()
          const timeStr = formatTimeAgo(post.created_at as string, language as 'zh' | 'en')
          const groupName = (post.group_name as string) || t('generalDiscussion')
          const groupNameEn = (post.group_name_en as string) || t('generalDiscussionEn')

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
            group_en: groupNameEn,
            group_id: (post.group_id as string) || undefined,
            title: (post.title as string) || t('noTitle'),
            author: (post.author_handle as string) || 'user',
            author_handle: post.author_handle as string,
            time: timeStr,
            body: (post.content as string) || '',
            comments: (post.comment_count as number) || 0,
            likes: (post.like_count as number) || 0,
            dislikes: (post.dislike_count as number) || 0,
            hotScore,
            views: (post.view_count as number) || 0,
            created_at: post.created_at as string,
            user_reaction: (post.user_reaction as 'up' | 'down' | null) || null,
          }
        })
        setPosts(postsData)
        if (postsData.length > 0 && postsData[0].created_at) {
          latestPostTime.current = postsData[0].created_at
        }
      } else {
        setPosts([])
      }
    } catch (e) {
      logger.error('Failed to load posts:', e)
      setPosts([])
      showToast(t('loadHotPostsFailed'), 'error')
    } finally {
      setLoadingPosts(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [showToast, language, accessToken])

  useEffect(() => {
    loadPosts()
    const interval = setInterval(loadPosts, 180000)
    return () => clearInterval(interval)
  }, [loadPosts])

  // Load groups when groups tab is active
  useEffect(() => {
    if (activeHotTab !== 'groups') return
    const loadGroups = async () => {
      setLoadingGroups(true)
      try {
        const res = await fetch('/api/groups?sort_by=activity&limit=30')
        const json = await res.json()
        const data = json.data?.groups || json.groups || json.data || []
        setGroups(data.map((g: Record<string, unknown>) => ({
          id: (g.id as string) || '',
          name: (g.name as string) || '',
          name_en: (g.name_en as string | null) || null,
          member_count: (g.member_count as number) || 0,
        })))
      } catch (error) {
        logger.error('Groups load error:', error)
        setGroups([])
      } finally {
        setLoadingGroups(false)
      }
    }
    loadGroups()
  }, [activeHotTab])

  const hotPosts = useMemo(() => {
    const sorted = [...posts].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0))
    return sorted
  }, [posts])

  // Hot tags
  const getHotTag = useCallback((post: Post, _rank: number): { label: string; color: string } | null => {
    const createdAt = post.created_at ? new Date(post.created_at) : null
    const hoursAgo = createdAt ? (Date.now() - createdAt.getTime()) / 3600000 : 999
    const score = post.hotScore ?? 0
    const commentCount = post.comments ?? 0

    if (score >= 95 && commentCount >= 150) {
      return { label: t('hotPageTagBoom'), color: 'var(--color-accent-error)' }
    }
    if (score >= 80 && hoursAgo < 24) {
      return { label: t('hotPageTagHot'), color: 'var(--color-chart-orange)' }
    }
    if (hoursAgo < 6) {
      return { label: t('hotPageTagNew'), color: 'var(--color-chart-blue)' }
    }
    return null
  }, [t])

  const visibleHot = useMemo(() => {
    // Show all posts for everyone — non-logged users get full feed
    // Login prompt shown via CTA banner, not content gating
    return hotPosts
  }, [hotPosts])

  // Load comments (initial)
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
      logger.error('[HotPage] Load comments failed:', err)
      setComments([])
      setHasMoreComments(false)
      showToast(t('loadCommentsFailed'), 'error')
    } finally {
      setLoadingComments(false)
    }
  }, [showToast, t])

  // Load more comments
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
      logger.error('[HotPage] Load more comments failed:', err)
    } finally {
      setLoadingMoreComments(false)
    }
  }, [openPost, commentsOffset, loadingMoreComments, hasMoreComments])

  // Detect Chinese text
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
      if (translatedListPosts[p.id]?.title && translatedListPosts[p.id]?.body) return false
      if (!p.title && !p.body) return false
      const titleIsChinese = isChineseText(p.title || '')
      const bodyIsChinese = isChineseText(p.body || '')
      return targetLang === 'en' ? (titleIsChinese || bodyIsChinese) : (!titleIsChinese || !bodyIsChinese)
    })

    if (needsTranslation.length === 0) return

    setTranslatingList(true)

    try {
      const items: Array<{ id: string; text: string; contentType: 'post_title' | 'post_content'; contentId: string }> = []

      needsTranslation.slice(0, 10).forEach(post => {
        if (post.title && !translatedListPosts[post.id]?.title) {
          items.push({
            id: `${post.id}_title`,
            text: post.title,
            contentType: 'post_title',
            contentId: post.id,
          })
        }
        if (post.body && !translatedListPosts[post.id]?.body) {
          items.push({
            id: `${post.id}_body`,
            text: post.body.slice(0, 500),
            contentType: 'post_content',
            contentId: post.id,
          })
        }
      })

      if (items.length === 0) return

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
      // Translation failed, silent
    } finally {
      setTranslatingList(false)
    }
  }, [translatingList, translatedListPosts, isChineseText])

  // Translate list when posts load or language changes
  useEffect(() => {
    if (posts.length > 0) {
      translateListPosts(posts, language as 'zh' | 'en')
    }
  }, [posts, language, translateListPosts])

  // Translate post content (with cache)
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
        showToast(data.error || t('translationFailed'), 'error')
      }
    } catch {
      showToast(t('translationServiceError'), 'error')
    } finally {
      setTranslating(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable ref t excluded to avoid re-creating callback
  }, [translationCache, showToast])

  // Track whether this modal was opened via navigation
  const openedViaNav = useRef(false)

  // Open post detail
  const handleOpenPost = useCallback((post: Post, fromUrlRestore = false) => {
    setOpenPost(post)
    setComments([])
    setTranslatedContent(null)
    setShowingOriginal(true)
    loadComments(post.id)

    if (!fromUrlRestore) {
      const params = new URLSearchParams(searchParams.toString())
      params.set('post', post.id)
      openedViaNav.current = true
      router.push(`/hot?${params.toString()}`, { scroll: false })
    }

    if (post.body) {
      const isChinese = isChineseText(post.body)
      const needsTranslation = (language === 'en' && isChinese) || (language === 'zh' && !isChinese)

      if (needsTranslation) {
        translateContent(post.id, post.body, (language === 'zh' ? 'zh' : 'en') as 'zh' | 'en')
      }
    }
  }, [loadComments, language, isChineseText, translateContent, searchParams, router])

  // Close post detail
  const handleClosePost = useCallback(() => {
    setOpenPost(null)
    openedViaNav.current = false
    const params = new URLSearchParams(searchParams.toString())
    params.delete('post')
    const newUrl = params.toString() ? `/hot?${params.toString()}` : '/hot'
    router.replace(newUrl, { scroll: false })
  }, [searchParams, router])

  // Post modal: URL restore, ESC key, body scroll lock, and browser back button
  useEffect(() => {
    const postId = searchParams.get('post')
    if (postId && posts.length > 0 && !openPost) {
      const post = posts.find(p => p.id === postId)
      if (post) {
        handleOpenPost(post, true)
      }
    }

    if (!openPost) return

    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClosePost()
      }
    }

    const handlePopState = () => {
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
  }, [searchParams, posts, openPost, handleOpenPost, handleClosePost])

  // Re-translate when language changes
  useEffect(() => {
    if (openPost && openPost.body) {
      const isChinese = isChineseText(openPost.body)
      const needsTranslation = (language === 'en' && isChinese) || (language === 'zh' && !isChinese)

      setTranslatedContent(null)
      setShowingOriginal(true)

      if (needsTranslation) {
        translateContent(openPost.id, openPost.body, (language === 'zh' ? 'zh' : 'en') as 'zh' | 'en')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-translate when language changes; openPost and translateContent are stable refs
  }, [language])

  // Submit comment
  const submitComment = useCallback(async (postId: string) => {
    if (!accessToken) {
      showToast(t('pleaseLoginFirst'), 'warning')
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
        if (response.status === 401) {
          showToast(t('sessionExpired'), 'error')
        } else if (response.status === 403) {
          showToast(t('permissionDenied'), 'error')
        } else if (response.status >= 500) {
          showToast(t('serverErrorRetry'), 'error')
        } else {
          const json = await response.json().catch(() => null)
          showToast(json?.error?.message || t('postCommentFailed'), 'error')
        }
        return
      }

      const json = await response.json()
      if (json.success && json.data?.comment) {
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
        showToast(json.error?.message || t('postCommentFailed'), 'error')
      }
    } catch (err) {
      logger.error('[HotPage] Submit comment failed:', err)
      showToast(t('networkErrorRetry'), 'error')
    } finally {
      setSubmittingComment(false)
    }
  }, [accessToken, newComment, openPost?.id, showToast, t])

  // Toggle reaction (like/dislike)
  const toggleReaction = useCallback(async (postId: string, reactionType: 'up' | 'down') => {
    if (!accessToken) {
      showToast(t('pleaseLoginFirst'), 'warning')
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
      logger.error('[HotPage] Reaction failed:', err)
      showToast(t('actionFailedRetry'), 'error')
    }
  }, [accessToken, openPost?.id, showToast, t])

  return {
    // Language
    t,
    language,
    localizedName,
    email,

    // Auth
    loggedIn,
    accessToken,

    // Posts
    loadingPosts,
    hotPosts,
    visibleHot,
    expandedPosts,
    setExpandedPosts,
    translatedListPosts,
    getHotTag,
    handleOpenPost,

    // Tabs
    activeHotTab,
    setActiveHotTab,

    // Groups
    groups,
    loadingGroups,

    // Post detail modal
    openPost,
    comments,
    loadingComments,
    hasMoreComments,
    loadingMoreComments,
    newComment,
    setNewComment,
    submittingComment,
    translatedContent,
    showingOriginal,
    setShowingOriginal,
    translating,
    handleClosePost,
    submitComment,
    toggleReaction,
    loadMoreComments,
  }
}
