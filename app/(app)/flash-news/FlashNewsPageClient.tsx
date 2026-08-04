'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { formatTimeAgo } from '@/lib/utils/date'
import { Box, Text } from '@/app/components/base'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { jwtSubject } from '@/lib/auth/token-subject'
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorState from '@/app/components/ui/ErrorState'
import { apiFetch } from '@/lib/utils/api-fetch'
import {
  readBatchTranslationResponse,
  TRANSLATION_REQUEST_TIMEOUT_MS,
  type BatchTranslationItem,
  type TranslationTargetLanguage,
} from '@/lib/translations/translation-client-contract'
import CategoryFilter from './components/CategoryFilter'
import NewsCard from './components/NewsCard'
import NewsTimelineSkeleton from './components/NewsTimelineSkeleton'

interface FlashNews {
  id: string
  title: string
  title_zh?: string
  title_en?: string
  title_ja?: string
  title_ko?: string
  content?: string
  content_zh?: string
  content_en?: string
  content_ja?: string
  content_ko?: string
  source: string
  source_url?: string
  category:
    | 'crypto'
    | 'macro'
    | 'defi'
    | 'regulation'
    | 'market'
    | 'btc_eth'
    | 'altcoin'
    | 'exchange'
  importance: 'breaking' | 'important' | 'normal'
  tags: string[]
  published_at: string
  created_at: string
}

interface FlashNewsResponse {
  news: FlashNews[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
}

type FlashNewsTranslationScope = {
  viewerKey: string
  sessionGeneration: number
  userId: string | null
  accessToken: string
  targetLang: TranslationTargetLanguage
  generation: number
}

type ActiveFlashNewsTranslation = {
  key: string
  sequence: number
  scope: FlashNewsTranslationScope
  controller: AbortController
  promise: Promise<void>
}

type CachedFlashNewsTranslation = {
  source: string
  targetLang: TranslationTargetLanguage
  translatedText: string
}

type FlashNewsTranslationOwner = Omit<FlashNewsTranslationScope, 'generation'>

type FlashNewsTranslationDescriptor = {
  id: string
  source: string
}

const FLASH_NEWS_TRANSLATION_BATCH_SIZE = 20

function pretranslatedContent(
  item: FlashNews,
  targetLang: TranslationTargetLanguage
): string | undefined {
  switch (targetLang) {
    case 'zh':
      return item.content_zh
    case 'en':
      return item.content_en
    case 'ja':
      return item.content_ja
    case 'ko':
      return item.content_ko
  }
}

function translationSource(item: FlashNews, targetLang: TranslationTargetLanguage): string | null {
  if (pretranslatedContent(item, targetLang)) return null
  return typeof item.content === 'string' && item.content.trim() ? item.content : null
}

function sameTranslationScope(
  left: FlashNewsTranslationScope,
  right: FlashNewsTranslationScope
): boolean {
  return (
    left.viewerKey === right.viewerKey &&
    left.sessionGeneration === right.sessionGeneration &&
    left.userId === right.userId &&
    left.accessToken === right.accessToken &&
    left.targetLang === right.targetLang &&
    left.generation === right.generation
  )
}

const CATEGORIES = [
  { key: 'all', label: '全部', label_en: 'All' },
  { key: 'btc_eth', label: 'BTC/ETH', label_en: 'BTC/ETH' },
  { key: 'altcoin', label: '山寨币', label_en: 'Altcoins' },
  { key: 'defi', label: 'DeFi', label_en: 'DeFi' },
  { key: 'macro', label: '宏观/监管', label_en: 'Macro/Regulation' },
  { key: 'exchange', label: '交易所', label_en: 'Exchanges' },
]

const IMPORTANCE_CONFIG = {
  breaking: { color: 'var(--color-accent-error)', label: '突发', label_en: 'Breaking' },
  important: { color: 'var(--color-score-below)', label: '重要', label_en: 'Important' },
  normal: { color: 'var(--color-score-low)', label: '一般', label_en: 'Normal' },
}

const CATEGORY_COLORS: Record<string, string> = {
  btc_eth: 'var(--color-score-average)',
  altcoin: 'var(--color-enterprise-gradient-start)',
  defi: 'var(--color-score-great)',
  macro: 'var(--color-score-profitability)',
  exchange: 'var(--color-score-legendary)',
  // Legacy mappings
  crypto: 'var(--color-score-average)',
  regulation: 'var(--color-score-profitability)',
  market: 'var(--color-enterprise-gradient-start)',
}

// Map DB category values to display categories
const CATEGORY_DISPLAY_MAP: Record<string, string> = {
  // Legacy DB values
  crypto: 'btc_eth',
  market: 'altcoin',
  regulation: 'macro',
  // New values map to themselves
  btc_eth: 'btc_eth',
  altcoin: 'altcoin',
  defi: 'defi',
  macro: 'macro',
  exchange: 'exchange',
}

const CATEGORY_COLORS_MAPPED: Record<string, string> = {
  ...CATEGORY_COLORS,
  // Ensure legacy values also get colors via their mapped display category
  crypto: CATEGORY_COLORS.btc_eth,
  market: CATEGORY_COLORS.altcoin,
  regulation: CATEGORY_COLORS.macro,
}

export default function FlashNewsPageClient() {
  const { language, t } = useLanguage()
  const { showToast } = useToast()
  const auth = useAuthSession()
  const { authChecked, isLoggedIn, accessToken } = auth
  const viewerKey = auth.viewerKey ?? (auth.userId ? `user:${auth.userId}` : 'anon')
  const sessionGeneration = auth.sessionGeneration ?? 0
  const userId = auth.userId ?? null
  const normalizedUserId = typeof userId === 'string' ? userId.trim().toLowerCase() : ''
  const translationAccessToken =
    authChecked &&
    isLoggedIn &&
    normalizedUserId.length > 0 &&
    viewerKey === `user:${userId}` &&
    Number.isSafeInteger(auth.sessionGeneration) &&
    auth.sessionGeneration >= 0 &&
    typeof accessToken === 'string' &&
    accessToken.trim().length > 0 &&
    jwtSubject(accessToken)?.trim().toLowerCase() === normalizedUserId
      ? accessToken
      : null

  const [news, setNews] = useState<FlashNews[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [hasMore, setHasMore] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [loadMoreFailure, setLoadMoreFailure] = useState<{
    page: number
    category: string
  } | null>(null)
  const [_pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  })
  const sentinelRef = useRef<HTMLDivElement>(null)
  const initialRequestIdRef = useRef(0)
  const loadingMoreRef = useRef(false)
  // "N new" buffer — polled items are held here instead of shifting the list
  // under the reader; revealed only when the pill is clicked.
  const [buffered, setBuffered] = useState<FlashNews[]>([])
  // Client-side view filters (server has no keyword search endpoint).
  const [breakingOnly, setBreakingOnly] = useState(false)
  const [query, setQuery] = useState('')
  // Latest set of loaded ids, kept in a ref so the poll closure can dedup
  // without re-subscribing every render.
  const newsIdsRef = useRef<Set<string>>(new Set())
  // Translation cache for content: { [newsId]: translatedContent }
  const [translatedContent, setTranslatedContent] = useState<Record<string, string>>({})
  const [translatingIds, setTranslatingIds] = useState<Set<string>>(new Set())
  const translatedContentRef = useRef(translatedContent)
  translatedContentRef.current = translatedContent
  const translatingIdsRef = useRef(translatingIds)
  translatingIdsRef.current = translatingIds
  const translationCacheRef = useRef(new Map<string, CachedFlashNewsTranslation>())
  const translationOwnerRef = useRef<FlashNewsTranslationOwner>({
    viewerKey,
    sessionGeneration,
    userId,
    accessToken: translationAccessToken ?? '',
    targetLang: language,
  })
  const translationMountedRef = useRef(false)
  const translationGenerationRef = useRef(0)
  const translationSequenceRef = useRef(0)
  const activeTranslationRef = useRef<ActiveFlashNewsTranslation | null>(null)
  const translationAuthRef = useRef({
    viewerKey,
    sessionGeneration,
    userId,
    accessToken: translationAccessToken,
    isLoggedIn,
    language,
  })
  translationAuthRef.current = {
    viewerKey,
    sessionGeneration,
    userId,
    accessToken: translationAccessToken,
    isLoggedIn,
    language,
  }
  const previousTranslationScopeRef = useRef(translationAuthRef.current)
  const currentNewsTranslationSourcesRef = useRef(new Map<string, string>())

  const currentSources = new Map<string, string>()
  const ambiguousSourceIds = new Set<string>()
  for (const item of news) {
    const source = translationSource(item, language)
    if (!source) continue
    const previous = currentSources.get(item.id)
    if (previous !== undefined && previous !== source) ambiguousSourceIds.add(item.id)
    else currentSources.set(item.id, source)
  }
  for (const id of ambiguousSourceIds) currentSources.delete(id)
  currentNewsTranslationSourcesRef.current = currentSources

  // Render-time fail-empty: effects clear storage after commit, so also gate
  // every visible translation by its exact viewer/token/language owner and the
  // current source text. This prevents even one paint of a previous scope or
  // previous content revision.
  const owner = translationOwnerRef.current
  const translationOwnerIsCurrent =
    isLoggedIn &&
    Boolean(translationAccessToken) &&
    owner.viewerKey === viewerKey &&
    owner.sessionGeneration === sessionGeneration &&
    owner.userId === userId &&
    owner.accessToken === translationAccessToken &&
    owner.targetLang === language
  const visibleTranslatedContent: Record<string, string> = {}
  if (translationOwnerIsCurrent) {
    for (const [id, source] of currentSources) {
      const cached = translationCacheRef.current.get(id)
      if (
        cached?.source === source &&
        cached.targetLang === language &&
        translatedContent[id] === cached.translatedText
      ) {
        visibleTranslatedContent[id] = cached.translatedText
      }
    }
  }

  const abortActiveTranslation = useCallback(() => {
    const active = activeTranslationRef.current
    if (active && !active.controller.signal.aborted) {
      active.controller.abort(
        new DOMException('Flash news translation scope changed', 'AbortError')
      )
    }
    activeTranslationRef.current = null
  }, [])

  const cancelActiveTranslation = useCallback(() => {
    const hadActive = activeTranslationRef.current !== null || translatingIdsRef.current.size > 0
    abortActiveTranslation()
    translationSequenceRef.current += 1
    if (hadActive) {
      const empty = new Set<string>()
      translatingIdsRef.current = empty
      setTranslatingIds(empty)
    }
  }, [abortActiveTranslation])

  const captureTranslationScope = useCallback(
    (token: string, targetLang: TranslationTargetLanguage): FlashNewsTranslationScope => ({
      viewerKey: translationAuthRef.current.viewerKey,
      sessionGeneration: translationAuthRef.current.sessionGeneration,
      userId: translationAuthRef.current.userId,
      accessToken: token,
      targetLang,
      generation: translationGenerationRef.current,
    }),
    []
  )

  const translationScopeIsCurrent = useCallback((scope: FlashNewsTranslationScope): boolean => {
    const current = translationAuthRef.current
    return (
      translationMountedRef.current &&
      current.isLoggedIn &&
      current.viewerKey === scope.viewerKey &&
      current.sessionGeneration === scope.sessionGeneration &&
      current.userId === scope.userId &&
      current.accessToken === scope.accessToken &&
      current.language === scope.targetLang &&
      translationGenerationRef.current === scope.generation
    )
  }, [])

  useEffect(() => {
    translationMountedRef.current = true
    return () => {
      translationMountedRef.current = false
      translationGenerationRef.current += 1
      abortActiveTranslation()
    }
  }, [abortActiveTranslation])

  useEffect(() => {
    const previous = previousTranslationScopeRef.current
    const current = translationAuthRef.current
    if (
      previous.viewerKey === current.viewerKey &&
      previous.sessionGeneration === current.sessionGeneration &&
      previous.userId === current.userId &&
      previous.accessToken === current.accessToken &&
      previous.isLoggedIn === current.isLoggedIn &&
      previous.language === current.language
    ) {
      return
    }

    previousTranslationScopeRef.current = { ...current }
    translationGenerationRef.current += 1
    abortActiveTranslation()
    translationCacheRef.current.clear()
    translationOwnerRef.current = {
      viewerKey: current.viewerKey,
      sessionGeneration: current.sessionGeneration,
      userId: current.userId,
      accessToken: current.accessToken ?? '',
      targetLang: current.language,
    }
    translatedContentRef.current = {}
    translatingIdsRef.current = new Set()
    setTranslatedContent({})
    setTranslatingIds(new Set())
  }, [
    abortActiveTranslation,
    isLoggedIn,
    language,
    sessionGeneration,
    translationAccessToken,
    userId,
    viewerKey,
  ])

  const fetchNews = useCallback(
    async (page = 1, category = 'all', append = false): Promise<boolean> => {
      if (append && loadingMoreRef.current) return false
      const requestId = append ? null : ++initialRequestIdRef.current
      const isCurrentInitialRequest = () => append || requestId === initialRequestIdRef.current

      try {
        if (append) {
          loadingMoreRef.current = true
          setLoadingMore(true)
          setLoadMoreFailure(null)
        } else {
          setLoading(true)
          setLoadError(false)
        }
        const params = new URLSearchParams({ page: page.toString(), limit: '20' })
        if (category !== 'all') {
          params.append('category', category)
        }

        // apiFetch bounds a stuck browser request at 15 seconds. A first-load
        // skeleton must always resolve to data, a genuine empty, or an error.
        const raw = await apiFetch<
          FlashNewsResponse | { data?: FlashNewsResponse; success?: boolean }
        >(`/api/flash-news?${params}`)
        if (!isCurrentInitialRequest()) return false
        // API wraps in { success, data: { news, pagination } }
        const wrapped = raw as { data?: FlashNewsResponse }
        const data = wrapped.data || (raw as FlashNewsResponse)
        if (
          !data ||
          !Array.isArray(data.news) ||
          !data.pagination ||
          typeof data.pagination.hasNext !== 'boolean'
        ) {
          throw new Error('Malformed flash news response')
        }
        const newsList = data.news
        const pag = data.pagination
        if (append) {
          setNews((prev) => {
            const knownIds = new Set(prev.map((item) => item.id))
            return [...prev, ...newsList.filter((item) => !knownIds.has(item.id))]
          })
        } else {
          setNews(newsList)
        }
        setPagination(pag)
        setHasMore(pag.hasNext)
        if (!append) setLastUpdated(new Date())
        return true
      } catch {
        if (!isCurrentInitialRequest()) return false
        if (append) {
          setLoadMoreFailure({ page, category })
        } else {
          setLoadError(true)
        }
        showToast(t('flashNewsFetchFailed'), 'error')
        return false
      } finally {
        if (append) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        } else if (isCurrentInitialRequest()) {
          setLoading(false)
        }
      }
    },
    [showToast, t]
  )

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Keep the id ref in sync with the rendered list for the poll dedup.
  useEffect(() => {
    newsIdsRef.current = new Set(news.map((n) => n.id))
  }, [news])

  // Initial load + category change
  useEffect(() => {
    setCurrentPage(1)
    setNews([])
    setBuffered([])
    setHasMore(true)
    setLoadError(false)
    setLoadMoreFailure(null)
    void fetchNews(1, selectedCategory)
    return () => {
      // Ignore a superseded category response even if the underlying request
      // finishes after its replacement.
      initialRequestIdRef.current += 1
    }
  }, [fetchNews, selectedCategory])

  // Poll page 1 and stash genuinely-new items in the buffer (never mutate the
  // visible list) so content doesn't jump under the reader.
  const pollForNew = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: '1', limit: '20' })
      if (selectedCategory !== 'all') params.append('category', selectedCategory)
      const response = await fetch(`/api/flash-news?${params}`)
      if (!response.ok) return
      const raw = await response.json()
      const data: FlashNewsResponse = raw.data || raw
      const list = data.news || []
      setBuffered((prev) => {
        const known = new Set<string>([...newsIdsRef.current, ...prev.map((b) => b.id)])
        const fresh = list.filter((item) => !known.has(item.id))
        if (fresh.length === 0) return prev
        return [...fresh, ...prev]
      })
    } catch {
      // Best-effort poll — silent; the manual list stays intact.
    }
  }, [selectedCategory])

  // Reveal buffered items: prepend (deduped) and scroll to top on demand.
  const revealBuffered = useCallback(() => {
    setBuffered((prev) => {
      if (prev.length === 0) return prev
      setNews((cur) => {
        const ids = new Set(cur.map((c) => c.id))
        const add = prev.filter((p) => !ids.has(p.id))
        return [...add, ...cur]
      })
      return []
    })
    setLastUpdated(new Date())
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Auto-refresh: poll only when page is visible (saves bandwidth when tab is hidden)
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const autoRefresh = () => {
      pollForNew()
    }
    const start = () => {
      if (!interval) interval = setInterval(autoRefresh, 120000)
    }
    const stop = () => {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [pollForNew])

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!sentinelRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          hasMore &&
          !loading &&
          !loadingMore &&
          !loadingMoreRef.current &&
          !loadMoreFailure
        ) {
          const nextPage = currentPage + 1
          void fetchNews(nextPage, selectedCategory, true).then((loaded) => {
            // Commit the page cursor only after that exact page loaded. A
            // failed page remains retryable instead of being skipped.
            if (loaded) setCurrentPage(nextPage)
          })
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [currentPage, hasMore, loading, loadingMore, loadMoreFailure, selectedCategory, fetchNews])

  const retryLoadMore = useCallback(() => {
    if (!loadMoreFailure) return
    const failed = loadMoreFailure
    void fetchNews(failed.page, failed.category, true).then((loaded) => {
      if (loaded) setCurrentPage(failed.page)
    })
  }, [fetchNews, loadMoreFailure])

  // Translate content for items that need it
  const translateNewsContent = useCallback(
    async (items: FlashNews[]) => {
      // /api/translate requires auth (Bearer header) — skip silently for anonymous visitors
      const token = translationAccessToken
      const targetLang: TranslationTargetLanguage = language
      if (!isLoggedIn || !token) {
        cancelActiveTranslation()
        return
      }

      const descriptors: FlashNewsTranslationDescriptor[] = []
      const staleIds = new Set<string>()
      const seenSources = new Map<string, string>()
      const ambiguousIds = new Set<string>()
      for (const item of items) {
        const source = translationSource(item, targetLang)
        const priorSource = seenSources.get(item.id)
        if (source && priorSource !== undefined && priorSource !== source) {
          ambiguousIds.add(item.id)
          continue
        }
        if (source) seenSources.set(item.id, source)

        const cached = translationCacheRef.current.get(item.id)
        const cacheMatches =
          source !== null && cached?.source === source && cached.targetLang === targetLang
        if (!cacheMatches) {
          translationCacheRef.current.delete(item.id)
          staleIds.add(item.id)
        }
        if (source && !cacheMatches && !descriptors.some((entry) => entry.id === item.id)) {
          descriptors.push({ id: item.id, source })
        }
      }

      if (ambiguousIds.size > 0) {
        for (const id of ambiguousIds) {
          translationCacheRef.current.delete(id)
          staleIds.add(id)
        }
      }
      const unambiguousDescriptors = descriptors.filter(
        (descriptor) => !ambiguousIds.has(descriptor.id)
      )

      if (staleIds.size > 0) {
        const current = translatedContentRef.current
        let next = current
        for (const id of staleIds) {
          if (!Object.prototype.hasOwnProperty.call(next, id)) continue
          if (next === current) next = { ...current }
          delete next[id]
        }
        if (next !== current) {
          translatedContentRef.current = next
          setTranslatedContent(next)
        }
      }

      if (unambiguousDescriptors.length === 0) {
        cancelActiveTranslation()
        return
      }

      const scope = captureTranslationScope(token, targetLang)
      const requestKey = JSON.stringify({
        targetLang,
        items: unambiguousDescriptors.map(({ id, source }) => [id, source]),
      })
      const existing = activeTranslationRef.current
      if (existing && existing.key === requestKey && sameTranslationScope(existing.scope, scope)) {
        return existing.promise
      }
      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(
          new DOMException('Flash news translation superseded', 'AbortError')
        )
      }

      const controller = new AbortController()
      const sequence = ++translationSequenceRef.current
      const requestedIds = new Set(unambiguousDescriptors.map(({ id }) => id))
      translatingIdsRef.current = requestedIds
      setTranslatingIds(requestedIds)

      const promise = (async () => {
        try {
          const batches: FlashNewsTranslationDescriptor[][] = []
          for (
            let offset = 0;
            offset < unambiguousDescriptors.length;
            offset += FLASH_NEWS_TRANSLATION_BATCH_SIZE
          ) {
            batches.push(
              unambiguousDescriptors.slice(offset, offset + FLASH_NEWS_TRANSLATION_BATCH_SIZE)
            )
          }

          const receipts = await Promise.all(
            batches.map(async (batch) => {
              const outgoingItems = batch.map(({ id, source }) => ({
                id,
                text: source,
                contentType: 'flash_news' as const,
                contentId: id,
              }))
              const payload = await apiFetch<unknown>('/api/translate', {
                method: 'POST',
                cache: 'no-store',
                credentials: 'include',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                  ...getCsrfHeaders(),
                },
                body: JSON.stringify({ items: outgoingItems, targetLang }),
                signal: controller.signal,
                timeoutMs: TRANSLATION_REQUEST_TIMEOUT_MS,
              })

              // The response does not echo contentType. Project the legacy
              // flash_news request into the shared parser's response-only shape;
              // outbound cache namespacing above remains flash_news.
              const parserItems: BatchTranslationItem[] = batch.map(({ id, source }) => ({
                id,
                text: source,
                contentType: 'post_content',
                contentId: id,
                targetLang,
              }))
              const receipt = readBatchTranslationResponse(payload, parserItems)
              if (!receipt) throw new Error('Flash news translation returned an invalid batch')
              return receipt
            })
          )

          const active = activeTranslationRef.current
          if (
            !active ||
            active.sequence !== sequence ||
            !translationScopeIsCurrent(scope) ||
            unambiguousDescriptors.some(
              ({ id, source }) => currentNewsTranslationSourcesRef.current.get(id) !== source
            )
          ) {
            return
          }

          const staged = new Map<string, CachedFlashNewsTranslation>()
          batches.forEach((batch, batchIndex) => {
            const receipt = receipts[batchIndex]
            for (const descriptor of batch) {
              const result = receipt?.results[descriptor.id]
              if (!result || result.translatedText.trim() === descriptor.source.trim()) {
                throw new Error('Flash news translation did not translate every requested item')
              }
              staged.set(descriptor.id, {
                source: descriptor.source,
                targetLang,
                translatedText: result.translatedText,
              })
            }
          })
          if (staged.size !== unambiguousDescriptors.length) {
            throw new Error('Flash news translation lost a requested item')
          }

          const current = translatedContentRef.current
          let next = current
          for (const descriptor of unambiguousDescriptors) {
            const translated = staged.get(descriptor.id)
            if (!translated) throw new Error('Flash news translation staging failed')
            translationCacheRef.current.set(descriptor.id, translated)
            if (next === current) next = { ...current }
            next[descriptor.id] = translated.translatedText
          }
          if (next !== current) {
            translationOwnerRef.current = {
              viewerKey: scope.viewerKey,
              sessionGeneration: scope.sessionGeneration,
              userId: scope.userId,
              accessToken: scope.accessToken,
              targetLang: scope.targetLang,
            }
            translatedContentRef.current = next
            setTranslatedContent(next)
          }
        } catch {
          if (!controller.signal.aborted) {
            controller.abort(new DOMException('Flash news translation batch failed', 'AbortError'))
          }
          // Translation is best-effort; invalid/error responses never replace original text.
        } finally {
          const active = activeTranslationRef.current
          if (active?.sequence === sequence && translationScopeIsCurrent(scope)) {
            activeTranslationRef.current = null
            const empty = new Set<string>()
            translatingIdsRef.current = empty
            setTranslatingIds(empty)
          }
        }
      })()
      activeTranslationRef.current = { key: requestKey, sequence, scope, controller, promise }
      return promise
    },
    [
      cancelActiveTranslation,
      captureTranslationScope,
      isLoggedIn,
      language,
      translationAccessToken,
      translationScopeIsCurrent,
    ]
  )

  // Trigger translation when news or its authenticated language scope changes.
  useEffect(() => {
    void translateNewsContent(news)
  }, [news, translateNewsContent])

  const getNewsTitle = (item: FlashNews) => {
    // Read the current UI language's pre-translated title; fall back to the
    // English title, then the raw original. (U7-5 added ja/ko.)
    if (language === 'zh') return item.title_zh || item.title_en || item.title
    if (language === 'ja') return item.title_ja || item.title_en || item.title
    if (language === 'ko') return item.title_ko || item.title_en || item.title
    return item.title_en || item.title
  }

  const getNewsContent = (item: FlashNews) => {
    if (!item.content) return null
    // Use pre-translated fields first, per current UI language (U7-5 added ja/ko).
    if (language === 'zh' && item.content_zh) return item.content_zh
    if (language === 'ja' && item.content_ja) return item.content_ja
    if (language === 'ko' && item.content_ko) return item.content_ko
    if (language === 'en' && item.content_en) return item.content_en
    // Then use API-translated content
    if (visibleTranslatedContent[item.id]) return visibleTranslatedContent[item.id]
    // Fallback to original
    return item.content
  }

  const formatPublishedTime = (timestamp: string) => {
    const timeLanguage = ({ zh: 'zh' } as Partial<Record<TranslationTargetLanguage, 'zh'>>)[
      language
    ]
    return formatTimeAgo(timestamp, timeLanguage ?? 'en')
  }

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category)
    setCurrentPage(1)
  }

  // Locale for date separators.
  const locale =
    ({ zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' } as Record<string, string>)[language] || 'en-US'

  // Day-separator label: Today / Yesterday / localized date.
  const dayLabelFor = useCallback(
    (iso: string): string => {
      const d = new Date(iso)
      const now = new Date()
      const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
      const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000)
      if (diffDays <= 0) return t('today')
      if (diffDays === 1) return t('yesterday')
      return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
    },
    [t, locale]
  )

  // Client-side view filters: breaking-only + keyword (searches every locale
  // title/content field + tags so it works regardless of display language).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return news.filter((n) => {
      if (breakingOnly && n.importance !== 'breaking') return false
      if (!q) return true
      const hay = [
        n.title,
        n.title_zh,
        n.title_en,
        n.title_ja,
        n.title_ko,
        n.content,
        n.content_zh,
        n.content_en,
        n.content_ja,
        n.content_ko,
        ...(n.tags || []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [news, breakingOnly, query])

  // Pin the most recent breaking items to the top (skip when already breaking-only).
  const pinnedBreaking = useMemo(
    () => (breakingOnly ? [] : filtered.filter((n) => n.importance === 'breaking').slice(0, 3)),
    [filtered, breakingOnly]
  )

  // Remaining items grouped by calendar day for date separators.
  const groupedTimeline = useMemo(() => {
    const pinnedIds = new Set(pinnedBreaking.map((p) => p.id))
    const groups: { key: string; label: string; items: FlashNews[] }[] = []
    for (const item of filtered) {
      if (pinnedIds.has(item.id)) continue
      const d = new Date(item.published_at)
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      let g = groups[groups.length - 1]
      if (!g || g.key !== key) {
        g = { key, label: dayLabelFor(item.published_at), items: [] }
        groups.push(g)
      }
      g.items.push(item)
    }
    return groups
  }, [filtered, pinnedBreaking, dayLabelFor])

  // "N new" pill label. Uses the (reported) flashNewsNewItems key when present,
  // otherwise degrades gracefully to a composed localized string.
  const rawNewLabel = t('flashNewsNewItems')
  const newLabelTemplate =
    rawNewLabel === 'flashNewsNewItems' ? `{count} ${t('latest')}` : rawNewLabel
  const newLabel = newLabelTemplate.replace('{count}', String(buffered.length))

  // Shared NewsCard renderer (long prop list, reused for pinned + timeline).
  const renderCard = (item: FlashNews) => (
    <div key={item.id} aria-busy={translatingIds.has(item.id)}>
      <NewsCard
        item={item}
        categoryDisplayMap={CATEGORY_DISPLAY_MAP}
        categoryColors={CATEGORY_COLORS_MAPPED}
        importanceConfig={IMPORTANCE_CONFIG}
        getNewsTitle={getNewsTitle}
        getNewsContent={getNewsContent}
        translatedContent={visibleTranslatedContent}
        formatPublishedTime={formatPublishedTime}
      />
    </div>
  )

  const DaySeparator = ({ label }: { label: string }) => (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        margin: `${tokens.spacing[4]} 0 ${tokens.spacing[3]}`,
      }}
    >
      <Text
        style={{
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.bold,
          color: tokens.colors.text.tertiary,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Text>
      <Box style={{ flex: 1, height: 1, background: tokens.colors.border.primary }} />
    </Box>
  )

  return (
    <Box
      style={{
        background: tokens.colors.bg.primary,
        minHeight: '100vh',
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        style={{
          maxWidth: '800px',
          margin: '0 auto',
          padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`,
        }}
      >
        {/* Header */}
        <Box style={{ marginBottom: tokens.spacing[5] }}>
          <Text
            as="h1"
            style={{
              fontSize: tokens.typography.fontSize['3xl'],
              fontWeight: tokens.typography.fontWeight.black,
              marginBottom: tokens.spacing[1],
              letterSpacing: '-0.5px',
            }}
          >
            {t('flashNewsCenter')}
          </Text>
          <Text
            style={{
              color: tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.md,
              lineHeight: tokens.typography.lineHeight.relaxed,
            }}
          >
            {t('flashNewsDesc')}
          </Text>
          {lastUpdated && (
            <Text
              style={{
                color: tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.xs,
                marginTop: tokens.spacing[1],
              }}
            >
              {t('flashNewsLastUpdated')}
              {lastUpdated.toLocaleTimeString(
                ({ zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' } as Record<string, string>)[language] ||
                  'en-US',
                { hour: '2-digit', minute: '2-digit', second: '2-digit' }
              )}
            </Text>
          )}
        </Box>

        {/* Category Filter */}
        <CategoryFilter
          categories={CATEGORIES}
          selectedCategory={selectedCategory}
          onCategoryChange={handleCategoryChange}
        />

        {/* Keyword search + breaking-only toggle */}
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[2],
            flexWrap: 'wrap',
            alignItems: 'center',
            marginBottom: tokens.spacing[4],
          }}
        >
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            aria-busy={loading}
            style={{
              flex: '1 1 200px',
              minWidth: 0,
              minHeight: 44,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.glass.bg.light,
              border: tokens.glass.border.light,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          />
          <button
            type="button"
            className="filter-chip"
            data-active={breakingOnly ? 'true' : undefined}
            aria-pressed={breakingOnly}
            aria-busy={loading}
            disabled={loading}
            onClick={() => setBreakingOnly((v) => !v)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              minHeight: 44,
              borderRadius: tokens.radius.lg,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: breakingOnly
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
              background: breakingOnly ? 'var(--color-accent-error)' : tokens.glass.bg.light,
              color: breakingOnly ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              border: breakingOnly ? 'none' : tokens.glass.border.light,
              cursor: loading ? 'wait' : 'pointer',
              opacity: loading ? 0.7 : 1,
              transition: `all ${tokens.transition.base}`,
              display: 'inline-flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
            }}
          >
            {/* Dot + text label = colorblind-safe (color is not the only cue) */}
            <span aria-hidden="true">●</span>
            {t('newsFlash_imp_breaking')}
          </button>
        </Box>

        {/* News Timeline */}
        <div
          aria-busy={loading || loadingMore || translatingIds.size > 0}
          data-testid="flash-news-timeline"
          style={{ transition: 'opacity 0.3s ease', opacity: loading ? 0.5 : 1 }}
        >
          {loading && news.length === 0 ? (
            <NewsTimelineSkeleton />
          ) : loadError && news.length === 0 ? (
            <ErrorState
              title={t('flashNewsFetchFailed')}
              description={t('loadFailedRetryShort')}
              retry={() => void fetchNews(1, selectedCategory)}
              variant="compact"
              retryButtonSize="md"
            />
          ) : news.length === 0 ? (
            <EmptyState
              icon={
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              }
              title={t('flashNewsNoNews')}
              description={t('flashNewsNoNewsDesc')}
            />
          ) : (
            <Box>
              {/* "N new" buffer pill — polled items surface here without shifting
                  the list; clicking reveals them and scrolls to top. */}
              {buffered.length > 0 && (
                <Box
                  style={{
                    position: 'sticky',
                    top: tokens.spacing[3],
                    zIndex: 5,
                    display: 'flex',
                    justifyContent: 'center',
                    marginBottom: tokens.spacing[3],
                    pointerEvents: 'none',
                  }}
                >
                  <button
                    type="button"
                    onClick={revealBuffered}
                    style={{
                      pointerEvents: 'auto',
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 44,
                      gap: tokens.spacing[1],
                      padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                      borderRadius: tokens.radius.full,
                      background: tokens.gradient.primary,
                      color: 'var(--color-on-accent)',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.bold,
                      boxShadow: tokens.shadow.md,
                    }}
                  >
                    <span aria-hidden="true">↑</span>
                    {newLabel}
                  </button>
                </Box>
              )}

              {filtered.length === 0 ? (
                <EmptyState
                  icon={
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <circle cx="11" cy="11" r="7" />
                      <path d="M21 21l-4.35-4.35" />
                    </svg>
                  }
                  title={t('noResults')}
                  description={t('flashNewsNoNewsDesc')}
                />
              ) : (
                <Box style={{ marginBottom: tokens.spacing[5] }}>
                  {/* Pinned breaking group */}
                  {pinnedBreaking.length > 0 && (
                    <Box style={{ marginBottom: tokens.spacing[2] }}>
                      <Box
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: tokens.spacing[2],
                          margin: `0 0 ${tokens.spacing[3]}`,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: tokens.typography.fontSize.xs,
                            fontWeight: tokens.typography.fontWeight.bold,
                            color: 'var(--color-accent-error)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            whiteSpace: 'nowrap',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: tokens.spacing[1],
                          }}
                        >
                          <span aria-hidden="true">●</span>
                          {t('newsFlash_imp_breaking')}
                        </Text>
                        <Box
                          style={{
                            flex: 1,
                            height: 1,
                            background: 'var(--color-accent-error-20, var(--color-border-primary))',
                          }}
                        />
                      </Box>
                      {pinnedBreaking.map((item) => renderCard(item))}
                    </Box>
                  )}

                  {/* Chronological timeline with day separators */}
                  {groupedTimeline.map((group) => (
                    <Box key={group.key}>
                      <DaySeparator label={group.label} />
                      {group.items.map((item) => renderCard(item))}
                    </Box>
                  ))}
                </Box>
              )}

              {/* Infinite scroll sentinel — 仅当有筛选后结果时挂载。否则(搜索无结果/
                  突发-only 空)sentinel 会继续翻页拉取被客户端过滤掉的数据,空态
                  「未找到匹配内容」下方还转「加载中…」spinner,自相矛盾。 */}
              {filtered.length > 0 && !loadMoreFailure && (
                <>
                  <div ref={sentinelRef} style={{ height: 1 }} />
                  {loadingMore && (
                    <Box
                      role="status"
                      aria-live="polite"
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        padding: tokens.spacing[4],
                      }}
                    >
                      <Box
                        style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}
                      >
                        <Box
                          aria-hidden="true"
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            border: `2px solid var(--color-accent-primary)`,
                            borderTopColor: 'transparent',
                            animation: 'spin 0.6s linear infinite',
                          }}
                        />
                        <Text size="sm" color="tertiary">
                          {t('loading')}
                        </Text>
                      </Box>
                    </Box>
                  )}
                </>
              )}
              {loadMoreFailure && (
                <ErrorState
                  title={t('flashNewsFetchFailed')}
                  description={t('loadFailedRetryShort')}
                  retry={retryLoadMore}
                  variant="compact"
                  retryButtonSize="md"
                />
              )}
              {!hasMore && news.length > 0 && (
                <Box
                  style={{
                    textAlign: 'center',
                    padding: tokens.spacing[4],
                    borderTop: `1px solid ${tokens.colors.border.primary}`,
                    marginTop: tokens.spacing[2],
                  }}
                >
                  <Text size="sm" color="tertiary">
                    {t('flashNewsTotal').replace('{count}', String(news.length))}
                  </Text>
                </Box>
              )}
            </Box>
          )}
        </div>
      </Box>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}
