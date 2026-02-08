'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text } from '@/app/components/base'
import Card from '@/app/components/ui/Card'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getCsrfHeaders } from '@/lib/api/client'

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
  category: 'crypto' | 'macro' | 'defi' | 'regulation' | 'market'
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
  { key: 'crypto', label: '加密货币', label_en: 'Crypto' },
  { key: 'macro', label: '宏观经济', label_en: 'Macro' },
  { key: 'defi', label: 'DeFi', label_en: 'DeFi' },
  { key: 'regulation', label: '监管政策', label_en: 'Regulation' },
  { key: 'market', label: '市场动态', label_en: 'Market' },
]

const IMPORTANCE_CONFIG = {
  breaking: { color: '#ef4444', label: '突发', label_en: 'Breaking' },
  important: { color: '#f97316', label: '重要', label_en: 'Important' },
  normal: { color: '#6b7280', label: '一般', label_en: 'Normal' },
}

const CATEGORY_COLORS: Record<string, string> = {
  crypto: '#f59e0b',
  macro: '#3b82f6',
  defi: '#10b981',
  regulation: '#8b5cf6',
  market: '#06b6d4',
}

export default function FlashNewsPage() {
  const { language } = useLanguage()
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
      if (category !== 'all') params.append('category', category)

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
    } catch {
      showToast(language === 'zh' ? '获取快讯失败' : 'Failed to load news', 'error')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [showToast, language])

  // Initial load + category change
  useEffect(() => {
    setCurrentPage(1)
    setNews([])
    setHasMore(true)
    fetchNews(1, selectedCategory)
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
      // silent fail
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
  }, [news, language]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const date = new Date(timestamp)
    const diff = Date.now() - date.getTime()
    if (diff < 24 * 60 * 60 * 1000) {
      return date.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category)
    setCurrentPage(1)
  }

  return (
    <Box style={{ background: tokens.colors.bg.primary, minHeight: '100vh', color: tokens.colors.text.primary }}>
      <TopNav />
      <Box style={{ maxWidth: '800px', margin: '0 auto', padding: `${tokens.spacing[4]} ${tokens.spacing[3]}` }}>
        {/* Header */}
        <Box style={{ marginBottom: tokens.spacing[6] }}>
          <Text style={{ fontSize: tokens.typography.fontSize['3xl'], fontWeight: tokens.typography.fontWeight.black, marginBottom: tokens.spacing[2], letterSpacing: '-0.5px' }}>
            {language === 'zh' ? '快讯中心' : 'Flash News'}
          </Text>
          <Text style={{ color: tokens.colors.text.secondary, fontSize: tokens.typography.fontSize.md, lineHeight: tokens.typography.lineHeight.relaxed }}>
            {language === 'zh'
              ? '实时跟踪加密货币、宏观经济、金融市场动态'
              : 'Real-time updates on crypto, macro, and financial markets'}
          </Text>
        </Box>

        {/* Category Filter */}
        <Box style={{ marginBottom: tokens.spacing[5], display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2] }}>
          {CATEGORIES.map((cat) => {
            const isActive = selectedCategory === cat.key
            return (
              <button
                key={cat.key}
                onClick={() => handleCategoryChange(cat.key)}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  borderRadius: tokens.radius.lg,
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                  background: isActive ? tokens.gradient.primary : tokens.glass.bg.light,
                  backdropFilter: isActive ? 'none' : tokens.glass.blur.sm,
                  WebkitBackdropFilter: isActive ? 'none' : tokens.glass.blur.sm,
                  color: isActive ? '#fff' : tokens.colors.text.secondary,
                  border: isActive ? 'none' : tokens.glass.border.light,
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.base}`,
                  boxShadow: isActive ? `0 4px 12px ${tokens.colors.accent.primary}40` : 'none',
                  outline: 'none',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = tokens.glass.bg.medium
                    e.currentTarget.style.color = tokens.colors.text.primary
                    e.currentTarget.style.transform = 'translateY(-1px)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.background = tokens.glass.bg.light
                    e.currentTarget.style.color = tokens.colors.text.secondary
                    e.currentTarget.style.transform = 'translateY(0)'
                  }
                }}
              >
                {language === 'zh' ? cat.label : cat.label_en}
              </button>
            )
          })}
        </Box>

        {/* News Timeline */}
        <div style={{ transition: 'opacity 0.3s ease', opacity: loading ? 0.5 : 1 }}>
          {loading && news.length === 0 ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[5], color: tokens.colors.text.secondary }}>
              <Text>{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
            </Box>
          ) : news.length === 0 ? (
            <div className="empty-state" style={{ padding: '80px 24px' }}>
              <div className="empty-state-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <p className="empty-state-title">{language === 'zh' ? '暂无快讯' : 'No news yet'}</p>
              <p className="empty-state-message">{language === 'zh' ? '快讯将在有新消息时自动更新' : 'News will appear here as they come in'}</p>
            </div>
          ) : (
            <Box>
              <Box style={{ marginBottom: tokens.spacing[5] }}>
                {news.map((item, index) => {
                  const impConfig = IMPORTANCE_CONFIG[item.importance]
                  const catColor = CATEGORY_COLORS[item.category] || tokens.colors.text.secondary
                  const content = getNewsContent(item)

                  return (
                    <Box
                      key={item.id}
                      style={{
                        display: 'flex',
                        marginBottom: tokens.spacing[4],
                        borderLeft: index === 0 ? 'none' : `2px solid ${tokens.colors.border.primary}`,
                        paddingLeft: index === 0 ? '0' : tokens.spacing[3],
                        position: 'relative',
                      }}
                    >
                      {index > 0 && (
                        <Box style={{
                          position: 'absolute', left: '-7px', top: tokens.spacing[3],
                          width: '12px', height: '12px', borderRadius: '50%',
                          background: impConfig.color, border: `2.5px solid ${tokens.colors.bg.primary}`,
                          boxShadow: `0 0 8px ${impConfig.color}60`,
                          transition: `box-shadow ${tokens.transition.base}`,
                        }} />
                      )}

                      <Box style={{ flex: 1 }}>
                        <Card variant="glass" style={{
                          padding: tokens.spacing[4],
                          borderRadius: tokens.radius.lg,
                          position: 'relative', overflow: 'hidden',
                          transition: `all ${tokens.transition.base}`,
                          boxShadow: tokens.shadow.sm,
                        }}>
                          {item.importance !== 'normal' && (
                            <Box style={{
                              position: 'absolute', top: 0, left: 0,
                              background: impConfig.color, color: 'white',
                              padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                              fontSize: '12px', fontWeight: '600',
                              borderRadius: `0 0 ${tokens.radius.sm} 0`,
                            }}>
                              {language === 'zh' ? impConfig.label : impConfig.label_en}
                            </Box>
                          )}

                          <Box style={{ paddingTop: item.importance !== 'normal' ? tokens.spacing[4] : '0' }}>
                            <Box style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              marginBottom: tokens.spacing[2],
                            }}>
                              <Text style={{ color: tokens.colors.text.tertiary, fontSize: '14px', fontWeight: '500' }}>
                                {formatPublishedTime(item.published_at)}
                              </Text>
                              <Box style={{
                                background: catColor, color: 'white',
                                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                                borderRadius: tokens.radius.sm, fontSize: '12px', fontWeight: '600',
                              }}>
                                {CATEGORIES.find(c => c.key === item.category)?.[language === 'zh' ? 'label' : 'label_en']}
                              </Box>
                            </Box>

                            <Text style={{
                              fontSize: '16px', fontWeight: '600', lineHeight: '1.5',
                              marginBottom: tokens.spacing[2], color: tokens.colors.text.primary,
                            }}>
                              {getNewsTitle(item)}
                            </Text>

                            {content && (
                              <Text style={{
                                color: translatedContent[item.id] ? tokens.colors.accent?.translated || tokens.colors.text.secondary : tokens.colors.text.secondary,
                                lineHeight: '1.5', marginBottom: tokens.spacing[2], fontSize: '14px',
                              }}>
                                {content}
                                {translatedContent[item.id] && (
                                  <span style={{
                                    fontSize: 10, fontWeight: 500, marginLeft: 6,
                                    padding: '1px 6px', borderRadius: '4px',
                                    background: `${tokens.colors.accent?.translated || '#6b7280'}15`,
                                    color: tokens.colors.accent?.translated || '#6b7280',
                                    verticalAlign: 'middle',
                                  }}>
                                    {language === 'zh' ? '自动翻译' : 'Auto-translated'}
                                  </span>
                                )}
                              </Text>
                            )}

                            <Box style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              flexWrap: 'wrap', gap: tokens.spacing[2],
                            }}>
                              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}>
                                <Text style={{ color: tokens.colors.text.tertiary, fontSize: '12px', fontWeight: '500' }}>
                                  {language === 'zh' ? '来源:' : 'Source:'}
                                </Text>
                                {item.source_url ? (
                                  <a
                                    href={item.source_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      color: tokens.colors.accent.primary, textDecoration: 'none',
                                      fontSize: '12px', fontWeight: '500',
                                    }}
                                  >
                                    {item.source}
                                  </a>
                                ) : (
                                  <Text style={{ color: tokens.colors.text.secondary, fontSize: '12px', fontWeight: '500' }}>
                                    {item.source}
                                  </Text>
                                )}
                              </Box>

                              {item.tags && item.tags.length > 0 && (
                                <Box style={{ display: 'flex', gap: tokens.spacing[1], flexWrap: 'wrap' }}>
                                  {item.tags.slice(0, 3).map((tag, tagIndex) => (
                                    <Box key={tagIndex} style={{
                                      background: tokens.colors.bg.tertiary, color: tokens.colors.text.tertiary,
                                      padding: `2px ${tokens.spacing[1]}`, borderRadius: tokens.radius.sm,
                                      fontSize: '10px', fontWeight: '500',
                                    }}>
                                      #{tag}
                                    </Box>
                                  ))}
                                </Box>
                              )}
                            </Box>
                          </Box>
                        </Card>
                      </Box>
                    </Box>
                  )
                })}
              </Box>

              {/* Infinite scroll sentinel */}
              <div ref={sentinelRef} style={{ height: 1 }} />
              {loadingMore && (
                <Box style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}>
                  <Text size="sm" color="tertiary">{language === 'zh' ? '加载中...' : 'Loading...'}</Text>
                </Box>
              )}
              {!hasMore && news.length > 0 && (
                <Box style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                  <Text size="sm" color="tertiary">{language === 'zh' ? '没有更多了' : 'No more news'}</Text>
                </Box>
              )}
            </Box>
          )}
        </div>
      </Box>
    </Box>
  )
}
