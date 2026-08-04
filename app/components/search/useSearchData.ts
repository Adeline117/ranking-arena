'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import {
  initializeHistory,
  addToHistory,
  removeFromHistory,
  clearHistory,
} from '@/lib/services/search-history'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { jwtSubject } from '@/lib/auth/token-subject'
import type { UnifiedSearchResponse, UnifiedSearchResult } from '@/app/api/search/route'
import { logger } from '@/lib/logger'
import { features } from '@/lib/features'
import {
  requestBatchTranslation,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'
import { mapHotPosts, type HotPostSource } from './hot-posts'

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
  translationSource: string | null
  hotScore: number
  rank: number
  view_count?: number
}

type SearchTranslationDescriptor = {
  id: string
  source: string
}

type SearchTranslationScope = {
  key: string
  targetLang: TranslationTargetLanguage
  accessToken: string
  descriptors: SearchTranslationDescriptor[]
}

type ActiveSearchTranslation = {
  key: string
  accessToken: string
  sequence: number
  controller: AbortController
  promise: Promise<void>
}

type ActiveHotPostsRequest = {
  scopeKey: string
  sequence: number
  controller: AbortController
}

const MAX_TRANSLATION_SNAPSHOTS = 8

function detectedTranslationSourceLanguage(text: string): TranslationTargetLanguage | null {
  if (/[가-힯ᄀ-ᇿ㄰-㆏]/.test(text)) return 'ko'
  if (/[぀-ヿㇰ-ㇿ]/.test(text)) return 'ja'
  const chineseCharacterCount = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  const nonWhitespaceLength = text.replace(/\s/g, '').length || 1
  if (chineseCharacterCount / nonWhitespaceLength > 0.1) return 'zh'
  if (/[A-Za-z]/.test(text)) return 'en'
  return null
}

function needsTranslation(source: string, targetLang: TranslationTargetLanguage): boolean {
  return detectedTranslationSourceLanguage(source) !== targetLang
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function useSearchData(open: boolean, query: string) {
  const { t, language } = useLanguage()
  const auth = useAuthSession()
  const { userId, isLoggedIn, authChecked, accessToken, viewerKey, sessionGeneration } = auth
  const noTitle = t('noTitle')
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [hotPostSources, setHotPostSources] = useState<HotPostSource[]>([])
  const [trendingSearches, setTrendingSearches] = useState<TrendingSearchItem[]>([])
  const [trendingLoading, setTrendingLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchData, setSearchData] = useState<UnifiedSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [isOffline, setIsOffline] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [translationCacheRevision, setTranslationCacheRevision] = useState(0)
  const [translationLoadingKey, setTranslationLoadingKey] = useState<string | null>(null)
  const translationCacheRef = useRef(new Map<string, Record<string, string>>())
  const activeTranslationRef = useRef<ActiveSearchTranslation | null>(null)
  const translationSequenceRef = useRef(0)
  const translationMountedRef = useRef(false)
  const committedTranslationScopeRef = useRef<SearchTranslationScope | null>(null)
  const hotPostsMountedRef = useRef(false)
  const hotPostsSequenceRef = useRef(0)
  const activeHotPostsRequestRef = useRef<ActiveHotPostsRequest | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Keep the raw result as authority so a language/t() change remaps fallback
  // titles synchronously, without waiting for a second network response.
  const hotPosts: HotPost[] = useMemo(
    () => mapHotPosts(hotPostSources, noTitle),
    [hotPostSources, noTitle]
  )
  const hotPostsLoadScopeKey = open && features.social ? JSON.stringify([language, noTitle]) : null

  const translationDescriptors = hotPosts.flatMap<SearchTranslationDescriptor>((post) =>
    post.translationSource?.trim() ? [{ id: post.id, source: post.translationSource }] : []
  )
  const resultIdentity = JSON.stringify(
    hotPosts.map((post) => [
      post.id,
      post.title,
      post.translationSource,
      post.hotScore,
      post.rank,
      post.view_count ?? null,
    ])
  )
  const hasUnambiguousResultIds = new Set(hotPosts.map((post) => post.id)).size === hotPosts.length
  const translationScope: SearchTranslationScope | null =
    open &&
    query.trim().length < 2 &&
    authChecked &&
    isLoggedIn &&
    typeof userId === 'string' &&
    viewerKey === `user:${userId}` &&
    jwtSubject(accessToken)?.toLowerCase() === userId.toLowerCase() &&
    Number.isSafeInteger(sessionGeneration) &&
    sessionGeneration >= 0 &&
    typeof accessToken === 'string' &&
    accessToken.trim() &&
    translationDescriptors.length > 0 &&
    translationDescriptors.length <= 20 &&
    hasUnambiguousResultIds
      ? {
          key: JSON.stringify([
            'search-hot-post-title',
            viewerKey,
            sessionGeneration,
            userId,
            language,
            query,
            resultIdentity,
          ]),
          targetLang: language,
          accessToken,
          descriptors: translationDescriptors,
        }
      : null
  const translationScopeKey = translationScope?.key ?? null

  const translatedTitles = useMemo(() => {
    if (!translationScope) return {}
    return translationCacheRef.current.get(translationScope.key) ?? {}
    // The revision makes writes to the ref-backed, bounded cache observable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationCacheRevision, translationScopeKey])
  const translating = translationScope !== null && translationLoadingKey === translationScope.key

  // Async publication must follow the last committed render, not a speculative
  // concurrent render. An equivalent new object with the same key is immaterial.
  useEffect(() => {
    committedTranslationScopeRef.current = translationScope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, translationScopeKey])

  // Flatten results for keyboard navigation
  const flatResults: UnifiedSearchResult[] = useMemo(
    () =>
      searchData
        ? [
            ...searchData.results.traders,
            ...(features.social ? searchData.results.posts : []),

            ...(features.social ? searchData.results.users : []),
            ...(features.social ? searchData.results.groups || [] : []),
          ]
        : [],
    [searchData]
  )

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
            category: /^[A-Z]{2,6}$/.test(q) ? ('token' as const) : ('general' as const),
          }))
        }
        _trendingCache = { data: items, ts: Date.now() }
        setTrendingSearches(items)
      }
    } catch (e) {
      logger.error('Failed to load trending searches:', e)
      const fallback = ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE']
      const items = fallback.map((q, index) => ({
        query: q,
        searchCount: 100 - index * 10,
        rank: index + 1,
        category: 'token' as const,
      }))
      setTrendingSearches(items)
    } finally {
      setTrendingLoading(false)
    }
  }, [open])

  useEffect(() => {
    loadTrendingSearches()
  }, [loadTrendingSearches])

  useEffect(() => {
    hotPostsMountedRef.current = true
    return () => {
      hotPostsMountedRef.current = false
      hotPostsSequenceRef.current += 1
      const active = activeHotPostsRequestRef.current
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new DOMException('Search hot posts unmounted', 'AbortError'))
      }
      activeHotPostsRequestRef.current = null
    }
  }, [])

  // Bind every load to the exact open/language/fallback-label generation.
  // A transport may ignore abort, so sequence and active-scope checks also
  // prevent old data and old finally blocks from mutating the current view.
  useEffect(() => {
    const scopeKey = hotPostsLoadScopeKey
    const previous = activeHotPostsRequestRef.current
    if (previous && !previous.controller.signal.aborted) {
      previous.controller.abort(new DOMException('Search hot posts superseded', 'AbortError'))
    }
    activeHotPostsRequestRef.current = null

    if (!scopeKey) {
      setLoading(false)
      return
    }

    const controller = new AbortController()
    const sequence = ++hotPostsSequenceRef.current
    activeHotPostsRequestRef.current = { scopeKey, sequence, controller }
    setLoading(true)

    void (async () => {
      try {
        const response = await fetch(
          '/api/posts?sort_by=hot_score&sort_order=desc&limit=10&offset=0',
          { signal: controller.signal }
        )
        if (!response.ok) return

        const result = await response.json()
        const posts = result.data?.posts
        const active = activeHotPostsRequestRef.current
        if (
          !Array.isArray(posts) ||
          !hotPostsMountedRef.current ||
          active?.sequence !== sequence ||
          active.scopeKey !== scopeKey
        ) {
          return
        }
        setHotPostSources(posts as HotPostSource[])
      } catch (error) {
        const active = activeHotPostsRequestRef.current
        if (
          !isAbortError(error) &&
          hotPostsMountedRef.current &&
          active?.sequence === sequence &&
          active.scopeKey === scopeKey
        ) {
          logger.error('Failed to load hot posts:', error)
        }
      } finally {
        const active = activeHotPostsRequestRef.current
        if (
          hotPostsMountedRef.current &&
          active?.sequence === sequence &&
          active.scopeKey === scopeKey
        ) {
          activeHotPostsRequestRef.current = null
          setLoading(false)
        }
      }
    })()

    return () => {
      const active = activeHotPostsRequestRef.current
      if (active?.sequence === sequence) {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException('Search hot posts scope changed', 'AbortError'))
        }
        activeHotPostsRequestRef.current = null
      }
    }
  }, [hotPostsLoadScopeKey])

  useEffect(() => {
    const translationCache = translationCacheRef.current
    translationMountedRef.current = true
    return () => {
      translationMountedRef.current = false
      translationSequenceRef.current += 1
      const active = activeTranslationRef.current
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(new DOMException('Search translation unmounted', 'AbortError'))
      }
      activeTranslationRef.current = null
      translationCache.clear()
    }
  }, [])

  // Hot-post title translation. Every published value is owned by one exact
  // viewer/token/language/query/result/source scope; stale work can never cross it.
  useEffect(() => {
    const scope = committedTranslationScopeRef.current
    if (!scope) {
      const active = activeTranslationRef.current
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(
          new DOMException('Search translation scope became unavailable', 'AbortError')
        )
      }
      activeTranslationRef.current = null
      setTranslationLoadingKey(null)
      return
    }

    if (translationCacheRef.current.has(scope.key)) {
      const active = activeTranslationRef.current
      if (active && active.key !== scope.key && !active.controller.signal.aborted) {
        active.controller.abort(
          new DOMException('Search translation superseded by cached scope', 'AbortError')
        )
        activeTranslationRef.current = null
      }
      setTranslationLoadingKey(null)
      return
    }

    const descriptors = scope.descriptors.filter(({ source }) =>
      needsTranslation(source, scope.targetLang)
    )
    if (descriptors.length === 0) {
      translationCacheRef.current.set(scope.key, {})
      setTranslationCacheRevision((revision) => revision + 1)
      setTranslationLoadingKey(null)
      return
    }

    const existing = activeTranslationRef.current
    if (existing?.key === scope.key && existing.accessToken === scope.accessToken) return
    if (existing && !existing.controller.signal.aborted) {
      existing.controller.abort(new DOMException('Search translation superseded', 'AbortError'))
    }

    const controller = new AbortController()
    const sequence = ++translationSequenceRef.current
    setTranslationLoadingKey(scope.key)

    const promise = (async () => {
      try {
        const items: BatchTranslationItem[] = descriptors.map(({ id, source }) => ({
          id,
          text: source,
          contentType: 'post_title',
          contentId: id,
          targetLang: scope.targetLang,
        }))
        const receipt = await requestBatchTranslation(items, scope.targetLang, {
          accessToken: scope.accessToken,
          csrfHeaders: getCsrfHeaders(),
          signal: controller.signal,
        })

        const active = activeTranslationRef.current
        if (
          !translationMountedRef.current ||
          active?.sequence !== sequence ||
          committedTranslationScopeRef.current?.key !== scope.key
        ) {
          return
        }

        const next: Record<string, string> = {}
        for (const descriptor of descriptors) {
          const translatedText = receipt.results[descriptor.id].translatedText
          if (translatedText.trim() === descriptor.source.trim()) {
            throw new Error('Search translation returned an original-text echo')
          }
          next[`${scope.targetLang}:${descriptor.id}`] = translatedText
        }

        translationCacheRef.current.set(scope.key, next)
        while (translationCacheRef.current.size > MAX_TRANSLATION_SNAPSHOTS) {
          const oldestKey = translationCacheRef.current.keys().next().value
          if (typeof oldestKey !== 'string') break
          translationCacheRef.current.delete(oldestKey)
        }
        setTranslationCacheRevision((revision) => revision + 1)
      } catch (error) {
        if (!isAbortError(error)) logger.error('Failed to translate hot posts:', error)
      } finally {
        const active = activeTranslationRef.current
        if (active?.sequence === sequence) {
          activeTranslationRef.current = null
          setTranslationLoadingKey((key) => (key === scope.key ? null : key))
        }
      }
    })()

    activeTranslationRef.current = {
      key: scope.key,
      accessToken: scope.accessToken,
      sequence,
      controller,
      promise,
    }

    return () => {
      const active = activeTranslationRef.current
      if (active?.sequence === sequence) {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException('Search translation scope changed', 'AbortError'))
        }
        activeTranslationRef.current = null
      }
    }
  }, [accessToken, translationScopeKey])

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
        setIsOffline(true)
        return
      }
      setIsOffline(false)

      if (abortControllerRef.current) abortControllerRef.current.abort()

      const controller = new AbortController()
      abortControllerRef.current = controller
      setSearching(true)

      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=10`, {
          signal: controller.signal,
        })
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

  const saveToHistory = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim()) return
      const newHistory = await addToHistory(searchQuery, userId ?? undefined)
      setSearchHistory(newHistory)
    },
    [userId]
  )

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
    isOffline,
    selectedIndex,
    setSelectedIndex,
    translatedTitles,
    translating,
    flatResults,
    saveToHistory,
    handleDeleteHistory,
    handleClearAllHistory,
  }
}
