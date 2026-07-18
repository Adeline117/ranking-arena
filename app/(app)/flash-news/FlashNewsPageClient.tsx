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
import EmptyState from '@/app/components/ui/EmptyState'
import ErrorState from '@/app/components/ui/ErrorState'
import { apiFetch } from '@/lib/utils/api-fetch'
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
  const { isLoggedIn, accessToken } = useAuthSession()

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
      if (!isLoggedIn || !accessToken) return
      const targetLang = language as 'zh' | 'en' | 'ja' | 'ko'
      const needsTranslation = items
        .filter((item) => {
          if (!item.content) return false
          if (translatedContent[item.id]) return false
          if (translatingIds.has(item.id)) return false
          // If we have a pre-translated version for this language, no need
          if (targetLang === 'zh' && item.content_zh) return false
          if (targetLang === 'en' && item.content_en) return false
          if (targetLang === 'ja' && item.content_ja) return false
          if (targetLang === 'ko' && item.content_ko) return false
          return true
        })
        .slice(0, 5) // batch max 5

      if (needsTranslation.length === 0) return

      const newTranslatingIds = new Set(translatingIds)
      needsTranslation.forEach((item) => newTranslatingIds.add(item.id))
      setTranslatingIds(newTranslatingIds)

      try {
        const batchItems = needsTranslation.map((item) => ({
          id: item.id,
          text: (item.content || '').slice(0, 500),
          contentType: 'flash_news' as const,
          contentId: item.id,
        }))

        const response = await fetch('/api/translate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            ...getCsrfHeaders(),
          },
          body: JSON.stringify({ items: batchItems, targetLang }),
        })

        const data = await response.json()
        if (response.ok && data.success && data.data?.results) {
          const results = data.data.results as Record<string, { translatedText: string }>
          setTranslatedContent((prev) => {
            const updated = { ...prev }
            for (const [id, result] of Object.entries(results)) {
              updated[id] = result.translatedText
            }
            return updated
          })
        }
      } catch {
        // Translation is best-effort; original text remains visible
      } finally {
        setTranslatingIds((prev) => {
          const next = new Set(prev)
          needsTranslation.forEach((item) => next.delete(item.id))
          return next
        })
      }
    },
    [language, translatedContent, translatingIds, isLoggedIn, accessToken]
  )

  // Trigger translation when news or language changes
  useEffect(() => {
    if (news.length > 0) {
      translateNewsContent(news)
    }
  }, [news, language, isLoggedIn]) // eslint-disable-line react-hooks/exhaustive-deps -- translateNewsContent changes on every render; only trigger on news/language/auth change

  // Clear translation cache on language change
  useEffect(() => {
    setTranslatedContent({})
  }, [language])

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
    if (translatedContent[item.id]) return translatedContent[item.id]
    // Fallback to original
    return item.content
  }

  const formatPublishedTime = (timestamp: string) => {
    return formatTimeAgo(timestamp, language === 'zh' ? 'zh' : 'en')
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
    <NewsCard
      key={item.id}
      item={item}
      categoryDisplayMap={CATEGORY_DISPLAY_MAP}
      categoryColors={CATEGORY_COLORS_MAPPED}
      importanceConfig={IMPORTANCE_CONFIG}
      getNewsTitle={getNewsTitle}
      getNewsContent={getNewsContent}
      translatedContent={translatedContent}
      formatPublishedTime={formatPublishedTime}
    />
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
            style={{
              flex: '1 1 200px',
              minWidth: 0,
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
            onClick={() => setBreakingOnly((v) => !v)}
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: breakingOnly
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
              background: breakingOnly ? 'var(--color-accent-error)' : tokens.glass.bg.light,
              color: breakingOnly ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
              border: breakingOnly ? 'none' : tokens.glass.border.light,
              cursor: 'pointer',
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
        <div style={{ transition: 'opacity 0.3s ease', opacity: loading ? 0.5 : 1 }}>
          {loading && news.length === 0 ? (
            <NewsTimelineSkeleton />
          ) : loadError && news.length === 0 ? (
            <ErrorState
              title={t('flashNewsFetchFailed')}
              description={t('loadFailedRetryShort')}
              retry={() => void fetchNews(1, selectedCategory)}
              variant="compact"
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
