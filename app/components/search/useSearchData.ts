'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  initializeHistory,
  addToHistory,
  removeFromHistory,
  clearHistory,
} from '@/lib/services/search-history'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import type { UnifiedSearchResponse, UnifiedSearchResult } from '@/app/api/search/route'
import { logger } from '@/lib/logger'
import { features } from '@/lib/features'

// Module-level cache for trending searches (5-min TTL)
let _trendingCache: { data: TrendingSearchItem[]; ts: number } | null = null
const TRENDING_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

export interface TrendingSearchItem {
  query: string
  searchCount: number
  rank: number
  category?: 'trader' | 'token' | 'general'
}

export interface HotPost {
  id: string
  title: string
  hotScore: number
  rank: number
  view_count?: number
}

export function useSearchData(open: boolean, query: string) {
  const { t, language } = useLanguage()
  const { userId, isLoggedIn, authChecked } = useAuthSession()
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [hotPosts, setHotPosts] = useState<HotPost[]>([])
  const [trendingSearches, setTrendingSearches] = useState<TrendingSearchItem[]>([])
  const [trendingLoading, setTrendingLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchData, setSearchData] = useState<UnifiedSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({})
  const [translating, setTranslating] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Flatten results for keyboard navigation
  const flatResults: UnifiedSearchResult[] = useMemo(() => searchData
    ? [
        ...searchData.results.traders,
        ...(features.social ? searchData.results.posts : []),
        ...searchData.results.library,
        ...(features.social ? searchData.results.users : []),
        ...(features.social ? (searchData.results.groups || []) : []),
      ]
    : [], [searchData])

  // Load search history
  useEffect(() => {
    if (!authChecked) return
    const loadHistory = async () => {
      const history = await initializeHistory(userId ?? undefined)
      setSearchHistory(history)
    }
    loadHistory()
  }, [authChecked, userId, isLoggedIn])

  // Load trending searches (with module-level 5-min cache)
  const loadTrendingSearches = useCallback(async () => {
    if (!open) return
    if (_trendingCache && Date.now() - _trendingCache.ts < TRENDING_CACHE_TTL) {
      setTrendingSearches(_trendingCache.data)
      return
    }
    setTrendingLoading(true)
    try {
      const response = await fetch('/api/search?type=trending')
      if (response.ok) {
        const result = await response.json()
        const data = result.data || result
        const trending = data.trending || []
        const fallback = data.fallback || ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE']
        let items: TrendingSearchItem[]
        if (trending.length >= 3) {
          items = trending.slice(0, 8)
        } else {
          items = fallback.slice(0, 8).map((q: string, index: number) => ({
            query: q,
            searchCount: 100 - index * 10,
            rank: index + 1,
            category: /^[A-Z]{2,6}$/.test(q) ? 'token' as const : 'general' as const,
          }))
        }
        _trendingCache = { data: items, ts: Date.now() }
        setTrendingSearches(items)
      }
    } catch (e) {
      logger.error('Failed to load trending searches:', e)
      const fallback = ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE']
      const items = fallback.map((q, index) => ({
        query: q, searchCount: 100 - index * 10, rank: index + 1, category: 'token' as const,
      }))
      setTrendingSearches(items)
    } finally {
      setTrendingLoading(false)
    }
  }, [open])

  // Load hot posts (only when social feature is enabled)
  const loadHotPosts = useCallback(async () => {
    if (!open || !features.social) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('posts')
        .select('id, title, hot_score, view_count, like_count, comment_count')
        .order('hot_score', { ascending: false, nullsFirst: false })
        .order('view_count', { ascending: false, nullsFirst: false })
        .order('like_count', { ascending: false, nullsFirst: false })
        .limit(10)

      if (error) return

      if (data && data.length > 0) {
        setHotPosts(
          data.map((post, index) => ({
            id: post.id,
            title: post.title || t('noTitle'),
            hotScore:
              post.hot_score ||
              (post.view_count || 0) * 0.1 +
                (post.like_count || 0) * 2 +
                (post.comment_count || 0) * 3,
            rank: index + 1,
            view_count: post.view_count,
          }))
        )
      }
    } catch (e) {
      logger.error('Failed to load hot posts:', e)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable
  }, [open])

  useEffect(() => {
    loadTrendingSearches()
    loadHotPosts()
  }, [loadTrendingSearches, loadHotPosts])

  // Hot post title translation
  useEffect(() => {
    if (hotPosts.length === 0 || translating) return

    const langKey = (id: string) => `${language}:${id}`
    const needsTranslation = hotPosts.some((post) => !translatedTitles[langKey(post.id)])
    if (!needsTranslation) return

    const isCJK = (text: string) => /[\u4e00-\u9fff\u3000-\u303f]/.test(text)
    const postsToTranslate = hotPosts.filter((post) => {
      if (translatedTitles[langKey(post.id)]) return false
      const titleIsCJK = isCJK(post.title)
      if (language === 'zh' && titleIsCJK) return false
      if (language === 'en' && !titleIsCJK) return false
      return true
    })

    if (postsToTranslate.length === 0) {
      const newTranslations = { ...translatedTitles }
      hotPosts.forEach((post) => {
        if (!newTranslations[langKey(post.id)]) newTranslations[langKey(post.id)] = post.title
      })
      setTranslatedTitles(newTranslations)
      return
    }

    const translateTitles = async () => {
      setTranslating(true)
      try {
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: postsToTranslate.map((p) => ({
              id: p.id, text: p.title, contentType: 'post_title', contentId: p.id,
            })),
            targetLang: language === 'zh' ? 'zh' : 'en',
          }),
        })
        if (res.ok) {
          const json = await res.json()
          const results = json.data?.results || {}
          const newTranslations: Record<string, string> = { ...translatedTitles }
          postsToTranslate.forEach((post) => {
            if (results[post.id]?.translatedText)
              newTranslations[langKey(post.id)] = results[post.id].translatedText
          })
          hotPosts.forEach((post) => {
            if (!newTranslations[langKey(post.id)]) newTranslations[langKey(post.id)] = post.title
          })
          setTranslatedTitles(newTranslations)
        }
      } catch (e) {
        logger.error('Failed to translate hot posts:', e)
      } finally {
        setTranslating(false)
      }
    }
    translateTitles()
  }, [language, hotPosts, translatedTitles, translating])

  // Unified search with debounce
  useEffect(() => {
    if (!open || !query.trim() || query.length < 2) {
      setSearchData(null)
      setSearching(false)
      setSelectedIndex(-1)
      if (abortControllerRef.current) abortControllerRef.current.abort()
      return
    }

    const searchTimer = setTimeout(async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setSearchData(null)
        setSearching(false)
        return
      }

      if (abortControllerRef.current) abortControllerRef.current.abort()

      const controller = new AbortController()
      abortControllerRef.current = controller
      setSearching(true)

      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}&limit=10`,
          { signal: controller.signal }
        )
        if (!response.ok) throw new Error('Search failed')
        const json = await response.json()
        const data: UnifiedSearchResponse = json.data || json
        if (!controller.signal.aborted) {
          setSearchData(data)
          setSelectedIndex(-1)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        logger.error('Search error:', error)
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 150)

    return () => {
      clearTimeout(searchTimer)
      if (abortControllerRef.current) abortControllerRef.current.abort()
    }
  }, [query, open])

  const saveToHistory = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return
    const newHistory = await addToHistory(searchQuery, userId ?? undefined)
    setSearchHistory(newHistory)
  }, [userId])

  const handleDeleteHistory = async (term: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const newHistory = await removeFromHistory(term, userId ?? undefined)
    setSearchHistory(newHistory)
  }

  const handleClearAllHistory = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await clearHistory(userId ?? undefined)
    setSearchHistory([])
  }

  return {
    language,
    t,
    searchHistory,
    hotPosts,
    trendingSearches,
    trendingLoading,
    loading,
    searchData,
    searching,
    selectedIndex,
    setSelectedIndex,
    translatedTitles,
    flatResults,
    saveToHistory,
    handleDeleteHistory,
    handleClearAllHistory,
  }
}
