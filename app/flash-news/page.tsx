'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { formatTimeAgo } from '@/lib/utils/date'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'
import EmptyState from '@/app/components/ui/EmptyState'
import CategoryFilter from './components/CategoryFilter'
import NewsCard from './components/NewsCard'
import NewsTimelineSkeleton from './components/NewsTimelineSkeleton'

interface FlashNews {
  id: string
  title: string
  title_zh?: string
  title_en?: string
  content?: string
  content_zh?: string
  content_en?: string
  source: string
  source_url?: string
  category: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market' | 'btc_eth' | 'altcoin' | 'exchange'
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


export default function FlashNewsPage() {
  const { language, t } = useLanguage()
  const { showToast } = useToast()

  const [news, setNews] = useState<FlashNews[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [hasMore, setHasMore] = useState(true)
  const [_pagination, setPagination] = useState({
    page: 1, limit: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false,
  })
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Translation cache for content: { [newsId]: translatedContent }
  const [translatedContent, setTranslatedContent] = useState<Record<string, string>>({})
  const [translatingIds, setTranslatingIds] = useState<Set<string>>(new Set())

  const fetchNews = useCallback(async (page = 1, category = 'all', append = false) => {
    try {
      if (append) setLoadingMore(true); else setLoading(true)
      const params = new URLSearchParams({ page: page.toString(), limit: '20' })
      if (category !== 'all') {
        params.append('category', category)
      }

      const response = await fetch(`/api/flash-news?${params}`)
      if (!response.ok) throw new Error('Failed to fetch news')

      const raw = await response.json()
      // API wraps in { success, data: { news, pagination } }
      const data: FlashNewsResponse = raw.data || raw
      const newsList = data.news || []
      const pag = data.pagination || { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false }
      if (append) {
        setNews(prev => [...prev, ...newsList])
      } else {
        setNews(newsList)
      }
      setPagination(pag)
      setHasMore(pag.hasNext)
      if (!append) setLastUpdated(new Date())
    } catch {
      showToast(t('flashNewsFetchFailed'), 'error')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [showToast, language])

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  // Initial load + category change
  useEffect(() => {
    setCurrentPage(1)
    setNews([])
    setHasMore(true)
    fetchNews(1, selectedCategory)
  }, [fetchNews, selectedCategory])

  // Auto-refresh: poll only when page is visible (saves bandwidth when tab is hidden)
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const start = () => { if (!interval) interval = setInterval(() => fetchNews(1, selectedCategory), 120000) }
    const stop = () => { if (interval) { clearInterval(interval); interval = null } }
    const onVisibility = () => { document.hidden ? stop() : start() }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [fetchNews, selectedCategory])

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    if (!sentinelRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && !loadingMore) {
          const nextPage = currentPage + 1
          setCurrentPage(nextPage)
          fetchNews(nextPage, selectedCategory, true)
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [hasMore, loading, loadingMore, currentPage, selectedCategory, fetchNews])

  // Translate content for items that need it
  const translateNewsContent = useCallback(async (items: FlashNews[]) => {
    const targetLang = language as 'zh' | 'en'
    const needsTranslation = items.filter(item => {
      if (!item.content) return false
      if (translatedContent[item.id]) return false
      if (translatingIds.has(item.id)) return false
      // If we have a pre-translated version, no need
      if (targetLang === 'zh' && item.content_zh) return false
      if (targetLang === 'en' && item.content_en) return false
      return true
    }).slice(0, 5) // batch max 5

    if (needsTranslation.length === 0) return

    const newTranslatingIds = new Set(translatingIds)
    needsTranslation.forEach(item => newTranslatingIds.add(item.id))
    setTranslatingIds(newTranslatingIds)

    try {
      const batchItems = needsTranslation.map(item => ({
        id: item.id,
        text: (item.content || '').slice(0, 500),
        contentType: 'flash_news' as const,
        contentId: item.id,
      }))

      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ items: batchItems, targetLang }),
      })

      const data = await response.json()
      if (response.ok && data.success && data.data?.results) {
        const results = data.data.results as Record<string, { translatedText: string }>
        setTranslatedContent(prev => {
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
      setTranslatingIds(prev => {
        const next = new Set(prev)
        needsTranslation.forEach(item => next.delete(item.id))
        return next
      })
    }
  }, [language, translatedContent, translatingIds])

  // Trigger translation when news or language changes
  useEffect(() => {
    if (news.length > 0) {
      translateNewsContent(news)
    }
  }, [news, language]) // eslint-disable-line react-hooks/exhaustive-deps -- translateNewsContent changes on every render; only trigger on news/language change

  // Clear translation cache on language change
  useEffect(() => {
    setTranslatedContent({})
  }, [language])

  const getNewsTitle = (item: FlashNews) => {
    if (language === 'zh') return item.title_zh || item.title
    return item.title_en || item.title
  }

  const getNewsContent = (item: FlashNews) => {
    if (!item.content) return null
    // Use pre-translated fields first
    if (language === 'zh' && item.content_zh) return item.content_zh
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

  return (
    <Box style={{ background: tokens.colors.bg.primary, minHeight: '100vh', color: tokens.colors.text.primary }}>
      <TopNav />
      <Box style={{ maxWidth: '800px', margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[4]}` }}>
        {/* Header */}
        <Box style={{ marginBottom: tokens.spacing[5] }}>
          <Text style={{ fontSize: tokens.typography.fontSize['3xl'], fontWeight: tokens.typography.fontWeight.black, marginBottom: tokens.spacing[1], letterSpacing: '-0.5px' }}>
            {t('flashNewsCenter')}
          </Text>
          <Text style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.md, lineHeight: tokens.typography.lineHeight.relaxed }}>
            {t('flashNewsDesc')}
          </Text>
          {lastUpdated && (
            <Text style={{ color: tokens.colors.text.tertiary, fontSize: tokens.typography.fontSize.xs, marginTop: tokens.spacing[1] }}>
              {t('flashNewsLastUpdated')}
              {lastUpdated.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </Text>
          )}
        </Box>

        {/* Category Filter */}
        <CategoryFilter
          categories={CATEGORIES}
          selectedCategory={selectedCategory}
          onCategoryChange={handleCategoryChange}
          language={language}
        />

        {/* News Timeline */}
        <div style={{ transition: 'opacity 0.3s ease', opacity: loading ? 0.5 : 1 }}>
          {loading && news.length === 0 ? (
            <NewsTimelineSkeleton />
          ) : news.length === 0 ? (
            <EmptyState
              icon={
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              }
              title={t('flashNewsNoNews')}
              description={t('flashNewsNoNewsDesc')}
            />
          ) : (
            <Box>
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                {news.map((item) => (
                  <NewsCard
                    key={item.id}
                    item={item}
                    language={language}
                    categories={CATEGORIES}
                    categoryDisplayMap={CATEGORY_DISPLAY_MAP}
                    categoryColors={CATEGORY_COLORS_MAPPED}
                    importanceConfig={IMPORTANCE_CONFIG}
                    getNewsTitle={getNewsTitle}
                    getNewsContent={getNewsContent}
                    translatedContent={translatedContent}
                    formatPublishedTime={formatPublishedTime}
                  />
                ))}
              </Box>

              {/* Infinite scroll sentinel */}
              <div ref={sentinelRef} style={{ height: 1 }} />
              {loadingMore && (
                <Box style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                    <Box style={{
                      width: 16, height: 16, borderRadius: '50%',
                      border: `2px solid var(--color-accent-primary)`,
                      borderTopColor: 'transparent',
                      animation: 'spin 0.6s linear infinite',
                    }} />
                    <Text size="sm" color="tertiary">{t('loading')}</Text>
                  </Box>
                </Box>
              )}
              {!hasMore && news.length > 0 && (
                <Box style={{
                  textAlign: 'center', padding: tokens.spacing[4],
                  borderTop: `1px solid ${tokens.colors.border.primary}`,
                  marginTop: tokens.spacing[2],
                }}>
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
