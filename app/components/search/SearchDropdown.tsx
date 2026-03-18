'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { supabase } from '@/lib/supabase/client'
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
import { SearchHistory, TrendingSearches, HotPosts } from './SearchSuggestions'
import { features } from '@/lib/features'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'

interface TrendingSearchItem {
  query: string
  searchCount: number
  rank: number
  category?: 'trader' | 'token' | 'general'
}

interface _TrendingSearchResponse {
  trending: TrendingSearchItem[]
  fallback: string[]
  lastUpdated: string
}

/** Highlight matched keyword in text */
function highlightMatch(text: string, q: string): React.ReactNode {
  if (!text || !q.trim()) return text
  const lower = text.toLowerCase()
  const lq = q.toLowerCase().trim()
  const parts: React.ReactNode[] = []
  let last = 0
  let idx = lower.indexOf(lq)
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx))
    parts.push(
      <mark key={`hl-${idx}`} style={{
        backgroundColor: 'var(--color-accent-primary-25, var(--color-accent-primary-20))',
        color: 'inherit', borderRadius: 2, padding: '0 1px', fontWeight: 700,
      }}>
        {text.slice(idx, idx + lq.length)}
      </mark>
    )
    last = idx + lq.length
    idx = lower.indexOf(lq, last)
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length > 0 ? parts : text
}

interface SearchDropdownProps {
  open: boolean
  query: string
  onClose: () => void
}

interface HotPost {
  id: string
  title: string
  hotScore: number
  rank: number
  view_count?: number
}

// Category config for search results grouping
const CATEGORY_CONFIG = {
  traders: { icon: 'T', labelZh: '交易员', labelEn: 'Traders', color: 'var(--color-verified-web3)' },
  posts: { icon: 'P', labelZh: '帖子', labelEn: 'Posts', color: 'var(--color-score-profitability)' },
  library: { icon: 'L', labelZh: '资料库', labelEn: 'Library', color: 'var(--color-score-great)' },
  users: { icon: 'U', labelZh: '用户', labelEn: 'Users', color: 'var(--color-score-average)' },
  groups: { icon: 'G', labelZh: '小组', labelEn: 'Groups', color: 'var(--color-score-average)' },
} as const

type CategoryKey = keyof typeof CATEGORY_CONFIG

/**
 * Search dropdown
 * - Unified search: traders, posts, library, users
 * - Grouped by category
 * - Keyboard navigation (arrow keys, Enter, Escape)
 * - Search history
 * - Hot posts
 */
export default function SearchDropdown({ open, query, onClose }: SearchDropdownProps) {
  const router = useRouter()
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
  const containerRef = useRef<HTMLDivElement>(null)

  // Flatten results for keyboard navigation (exclude social content when disabled)
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

  // Load trending searches
  const loadTrendingSearches = useCallback(async () => {
    if (!open) return
    setTrendingLoading(true)
    try {
      const response = await fetch('/api/search?type=trending')
      if (response.ok) {
        const result = await response.json()
        const data = result.data || result
        const trending = data.trending || []
        const fallback = data.fallback || ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE']
        if (trending.length >= 3) {
          setTrendingSearches(trending.slice(0, 8))
        } else {
          setTrendingSearches(
            fallback.slice(0, 8).map((q: string, index: number) => ({
              query: q,
              searchCount: 100 - index * 10,
              rank: index + 1,
              category: /^[A-Z]{2,6}$/.test(q) ? 'token' as const : 'general' as const,
            }))
          )
        }
      }
    } catch (e) {
      logger.error('Failed to load trending searches:', e)
      const fallback = ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE']
      setTrendingSearches(
        fallback.map((q, index) => ({
          query: q, searchCount: 100 - index * 10, rank: index + 1, category: 'token' as const,
        }))
      )
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

  // Unified search with 200ms debounce
  useEffect(() => {
    if (!open || !query.trim() || query.length < 2) {
      // Immediately clear stale results (no debounce on clear)
      setSearchData(null)
      setSearching(false)
      setSelectedIndex(-1)
      if (abortControllerRef.current) abortControllerRef.current.abort()
      return
    }

    const searchTimer = setTimeout(async () => {
      if (abortControllerRef.current) abortControllerRef.current.abort()

      const controller = new AbortController()
      abortControllerRef.current = controller
      setSearching(true)

      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}&limit=5`,
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
    }, 300)

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

  // Keyboard navigation
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (flatResults.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => {
          const next = prev < flatResults.length - 1 ? prev + 1 : 0
          scrollItemIntoView(next)
          return next
        })
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => {
          const next = prev > 0 ? prev - 1 : flatResults.length - 1
          scrollItemIntoView(next)
          return next
        })
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault()
        const selected = flatResults[selectedIndex]
        if (selected) {
          saveToHistory(query)
          router.push(selected.href)
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatResults, selectedIndex, query, onClose, router, saveToHistory])

  const scrollItemIntoView = (index: number) => {
    if (!containerRef.current) return
    const items = containerRef.current.querySelectorAll<HTMLElement>('a[href]')
    const item = items[index]
    if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

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

  const handleResultClick = (resultId?: string, resultType?: string) => {
    if (query.trim()) saveToHistory(query)
    if (resultId && query.trim()) {
      fetch(`/api/search?type=click&q=${encodeURIComponent(query.trim())}&id=${encodeURIComponent(resultId)}&rtype=${resultType || ''}`)
        .catch(() => {}) // Intentional: click tracking is non-critical
    }
    onClose()
  }

  if (!open) return null

  // Calculate offset per category for keyboard highlight
  const getCategoryOffset = (category: CategoryKey): number => {
    if (!searchData) return 0
    // Order must match flatResults and rendered order; skip social categories when disabled
    const order: CategoryKey[] = features.social
      ? ['traders', 'posts', 'library', 'users', 'groups']
      : ['traders', 'library']
    let offset = 0
    for (const key of order) {
      if (key === category) break
      offset += searchData.results[key].length
    }
    return offset
  }

  const renderCategoryResults = (category: CategoryKey, items: UnifiedSearchResult[]) => {
    if (items.length === 0) return null
    const config = CATEGORY_CONFIG[category]
    const offset = getCategoryOffset(category)
    const label = language === 'zh' ? config.labelZh : config.labelEn

    return (
      <Box key={category}>
        <Box style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <Box style={{
            width: 20, height: 20, borderRadius: tokens.radius.sm,
            background: `${config.color}20`, color: config.color,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 800, flexShrink: 0,
          }}>
            {config.icon}
          </Box>
          <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </Text>
          <Text size="xs" color="tertiary">({items.length})</Text>
        </Box>

        {items.map((result, index) => {
          const globalIndex = offset + index
          const isSelected = globalIndex === selectedIndex
          return (
            <Link
              key={`${result.type}-${result.id}`}
              href={result.href}
              style={{ textDecoration: 'none' }}
              onClick={() => handleResultClick(result.id, result.type)}
            >
              <Box
                style={{
                  display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  cursor: 'pointer',
                  background: isSelected ? tokens.colors.bg.tertiary : 'transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => {
                  setSelectedIndex(globalIndex)
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={e => {
                  if (globalIndex !== selectedIndex) e.currentTarget.style.background = 'transparent'
                }}
              >
                {result.avatar ? (
                  <Image
                    src={result.avatar.startsWith('data:') ? result.avatar : `/api/avatar?url=${encodeURIComponent(result.avatar)}`}
                    alt={result.title || 'Avatar'}
                    width={28} height={28}
                    unoptimized
                    style={{ width: 28, height: 28, borderRadius: tokens.radius.full, objectFit: 'cover', flexShrink: 0 }}
                    {...(globalIndex < 5 ? { priority: true } : { loading: 'lazy' as const })}
                  />
                ) : (
                  <Box style={{
                    width: 28, height: 28, borderRadius: tokens.radius.full,
                    background: `${config.color}15`, color: config.color,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, flexShrink: 0,
                  }}>
                    {config.icon}
                  </Box>
                )}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Text size="sm" style={{
                      color: tokens.colors.text.primary,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {highlightMatch(result.title, query)}
                    </Text>
                    {Boolean(result.meta?.is_bot) && (
                      <span style={{
                        padding: '0px 4px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                        color: 'var(--color-brand)', background: 'var(--color-brand-muted)',
                        border: '1px solid color-mix(in srgb, var(--color-brand) 25%, transparent)',
                        lineHeight: 1.4, display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
                      }}>
                        <span style={{ fontSize: 8 }}>{'⚡'}</span>Bot
                      </span>
                    )}
                  </Box>
                  {result.subtitle && (
                    <Text size="xs" color="tertiary" style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {highlightMatch(result.subtitle, query)}
                    </Text>
                  )}
                </Box>
                {isSelected && (
                  <Text size="xs" color="tertiary" style={{ flexShrink: 0, opacity: 0.5 }}>
                    Enter
                  </Text>
                )}
              </Box>
            </Link>
          )
        })}
      </Box>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        maxHeight: 600, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
        zIndex: tokens.zIndex.dropdown,
        boxShadow: tokens.shadow.md,
      }}
    >
      {/* Search results (query >= 2 chars) */}
      {query.trim().length >= 2 && (
        <Box>
          {searching ? (
            <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
              {[1, 2, 3, 4].map((i) => (
                <Box key={i} style={{
                  display: 'flex', alignItems: 'center', gap: tokens.spacing[3],
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}>
                  <Box style={{
                    width: 28, height: 28, borderRadius: tokens.radius.full,
                    background: tokens.colors.bg.tertiary, flexShrink: 0,
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
                  <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Box style={{
                      width: `${50 + i * 12}%`, height: 12,
                      background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm,
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }} />
                    <Box style={{
                      width: `${30 + i * 8}%`, height: 10,
                      background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm,
                      animation: 'pulse 1.5s ease-in-out infinite', opacity: 0.6,
                    }} />
                  </Box>
                </Box>
              ))}
            </Box>
          ) : searchData && searchData.total === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">{t('noRelatedResults')}</Text>
              {searchData.suggestions && searchData.suggestions.length > 0 && (
                <Box style={{ marginTop: tokens.spacing[3] }}>
                  <Text size="xs" color="tertiary">{t('searchDidYouMean')}</Text>
                  <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2], justifyContent: 'center', marginTop: tokens.spacing[2] }}>
                    {searchData.suggestions.map((suggestion) => (
                      <Link key={suggestion} href={`/search?q=${encodeURIComponent(suggestion)}`} style={{ textDecoration: 'none' }} onClick={onClose}>
                        <Box style={{
                          padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`, borderRadius: tokens.radius.md,
                          background: 'var(--color-accent-primary-12)', border: '1px solid var(--color-accent-primary-25)',
                          cursor: 'pointer', transition: 'all 0.1s',
                        }}>
                          <Text size="xs" style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}>{suggestion}</Text>
                        </Box>
                      </Link>
                    ))}
                  </Box>
                </Box>
              )}
            </Box>
          ) : searchData ? (
            <>
              {searchData.matchedExchange && (
                <Box style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`, borderBottom: `1px solid ${tokens.colors.border.primary}`, display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <Text size="xs" color="tertiary">
                    {t('searchShowingTopTraders')} <span style={{ fontWeight: 700, color: tokens.colors.text.secondary }}>
                      {EXCHANGE_CONFIG[searchData.matchedExchange as keyof typeof EXCHANGE_CONFIG]?.name || searchData.matchedExchange}
                    </span>
                  </Text>
                </Box>
              )}
              {renderCategoryResults('traders', searchData.results.traders)}
              {features.social && renderCategoryResults('posts', searchData.results.posts)}
              {renderCategoryResults('library', searchData.results.library)}
              {features.social && renderCategoryResults('users', searchData.results.users)}
              {features.social && renderCategoryResults('groups', searchData.results.groups || [])}
              {searchData.suggestions && searchData.suggestions.length > 0 && (
                <Box style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`, borderBottom: `1px solid ${tokens.colors.border.primary}`, display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                  <Text size="xs" color="tertiary">{t('searchDidYouMean')}</Text>
                  {searchData.suggestions.map((suggestion) => (
                    <Link key={suggestion} href={`/search?q=${encodeURIComponent(suggestion)}`} style={{ textDecoration: 'none' }} onClick={onClose}>
                      <Text size="xs" style={{ color: tokens.colors.accent.primary, fontWeight: 600 }}>{suggestion}</Text>
                    </Link>
                  ))}
                </Box>
              )}
              <Link href={`/search?q=${encodeURIComponent(query)}`} style={{ textDecoration: 'none' }} onClick={() => handleResultClick()}>
                <Box
                  style={{ padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`, textAlign: 'center', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <Text size="xs" color="tertiary">{t('viewAllSearchResults')} →</Text>
                </Box>
              </Link>
            </>
          ) : null}
        </Box>
      )}

      {/* Suggestions (no active query) */}
      {query.trim().length < 2 && (
        <>
          <SearchHistory
            history={searchHistory}
            onClear={handleClearAllHistory}
            onDelete={handleDeleteHistory}
            onClose={onClose}
            t={t}
          />
          <TrendingSearches
            trending={trendingSearches}
            language={language}
            onClose={onClose}
            hasHistory={searchHistory.length > 0}
            loading={trendingLoading}
          />
          {features.social && (
            <HotPosts
              posts={hotPosts}
              loading={loading}
              language={language}
              translatedTitles={translatedTitles}
              onClose={onClose}
              hasHistory={searchHistory.length > 0}
              t={t}
            />
          )}
        </>
      )}
    </div>
  )
}
