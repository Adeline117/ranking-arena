'use client'

import { useEffect, useState, Suspense, useCallback, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import ErrorState from '@/app/components/ui/ErrorState'
import EmptyState from '@/app/components/ui/EmptyState'
import { logger } from '@/lib/logger'
import type { UnifiedSearchResponse } from '@/app/api/search/route'
import { features } from '@/lib/features'

interface SearchResult {
  type: 'library' | 'group' | 'post' | 'trader'
  id: string
  title: string
  subtitle?: string
  meta?: string
}

const SECTION_LIMIT = 5

// Use shared search history service (syncs to Supabase for logged-in users)
import { getLocalHistory, addToHistory, clearHistory } from '@/lib/services/search-history'
const getSearchHistory = getLocalHistory
const saveSearchHistory = (query: string) => { addToHistory(query) }
const clearSearchHistory = () => { clearHistory() }

function SearchContent() {
  const searchParams = useSearchParams()
  const _router = useRouter()
  const { t } = useLanguage()
  const query = searchParams.get('q') || ''
  const activeTab = searchParams.get('tab') || 'all'
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [searchError, setSearchError] = useState(false)
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [trendingSearches, setTrendingSearches] = useState<string[]>(['BTC', 'ETH', 'Binance', 'Bitget', 'SOL'])
  const { showToast } = useToast()

  const [libraryResults, setLibraryResults] = useState<SearchResult[]>([])
  const [groupResults, setGroupResults] = useState<SearchResult[]>([])
  const [postResults, setPostResults] = useState<SearchResult[]>([])
  const [traderResults, setTraderResults] = useState<SearchResult[]>([])
  const [libTotal, setLibTotal] = useState(0)
  const [groupTotal, setGroupTotal] = useState(0)
  const [postTotal, setPostTotal] = useState(0)
  const [traderTotal, setTraderTotal] = useState(0)
  const [didYouMean, setDidYouMean] = useState<string[]>([])
  const [_matchedExchange, setMatchedExchange] = useState<string | null>(null)

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    }).catch(() => { /* Auth check non-critical on search page */ }) // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
    setSearchHistory(getSearchHistory())
    
    // 加载热门搜索数据
    const loadTrendingSearches = async () => {
      try {
        const response = await fetch('/api/search?type=trending')
        if (response.ok) {
          const result = await response.json()
          const data = result.data || result
          
          // 使用真实热门搜索或退回到fallback
          const trending = data.trending || []
          const fallback = data.fallback || ['BTC', 'ETH', 'Binance', 'Bitget', 'SOL']
          
          if (trending.length >= 3) {
            setTrendingSearches(trending.slice(0, 6).map((item: { query: string }) => item.query))
          } else {
            setTrendingSearches(fallback.slice(0, 6))
          }
        }
      } catch (_error) {
        // 使用默认数据，不显示错误
        void _error
      }
    }
    
    loadTrendingSearches()
  }, [])

  // Search history is saved in the success callback of doSearch below

  const highlightText = useCallback((text: string, q: string): React.ReactNode => {
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
          color: 'inherit', borderRadius: 2, padding: '0 2px', fontWeight: 600,
        }}>
          {text.slice(idx, idx + lq.length)}
        </mark>
      )
      last = idx + lq.length
      idx = lower.indexOf(lq, last)
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts.length > 0 ? parts : text
  }, [])

  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setLibraryResults([])
      setGroupResults([])
      setPostResults([])
      setTraderResults([])
      return
    }

    const doSearch = async () => {
      setLoading(true)
      setSearchError(false)

      // Abort previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      const controller = new AbortController()
      abortControllerRef.current = controller

      try {
        // Use unified search API instead of direct Supabase queries
        // This leverages server-side caching and consistent search logic
        const apiRes = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=${SECTION_LIMIT}`, {
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        // Process unified API results (including groups)
        if (apiRes.ok) {
          const json = await apiRes.json()
          const data: UnifiedSearchResponse = json.data || json

          // Library
          setLibTotal(data.results.library.length)
          setLibraryResults(data.results.library.map(item => ({
            type: 'library' as const,
            id: item.id,
            title: item.title,
            subtitle: item.subtitle || undefined,
            meta: item.meta?.category as string || undefined,
          })))

          // Posts
          setPostTotal(data.results.posts.length)
          setPostResults(data.results.posts.map(p => ({
            type: 'post' as const,
            id: p.id,
            title: p.title,
            subtitle: p.subtitle ? `${t('searchPostBy')}: ${p.subtitle}` : undefined,
          })))

          // Traders
          setTraderTotal(data.results.traders.length)
          setTraderResults(data.results.traders.map(tr => ({
            type: 'trader' as const,
            id: tr.href.replace('/trader/', ''),
            title: tr.title,
            subtitle: tr.subtitle || undefined,
          })))

          // Groups
          const groupsResults = data.results.groups || []
          setGroupTotal(groupsResults.length)
          setGroupResults(groupsResults.map(g => ({
            type: 'group' as const,
            id: g.id,
            title: g.title,
            subtitle: g.meta?.member_count ? `${(g.meta.member_count as number).toLocaleString()} ${t('members')}` : undefined,
            meta: g.subtitle ? (g.subtitle.slice(0, 60)) : undefined,
          })))

          // Capture suggestions and exchange match
          setDidYouMean(data.suggestions || [])
          setMatchedExchange(data.matchedExchange || null)

          // Save to history only after results are received
          const totalReceived = data.results.library.length + data.results.posts.length + data.results.traders.length + groupsResults.length
          if (totalReceived > 0) {
            saveSearchHistory(query.trim())
            setSearchHistory(getSearchHistory())
          }
        } else {
          setLibraryResults([])
          setPostResults([])
          setTraderResults([])
          setGroupResults([])
          setLibTotal(0)
          setPostTotal(0)
          setTraderTotal(0)
          setGroupTotal(0)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        logger.error('Search error:', error)
        setSearchError(true)
        showToast(t('searchFailedToast'), 'error')
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    }

    const timeout = setTimeout(doSearch, 300)
    return () => {
      clearTimeout(timeout)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [query, t, showToast])

  const getHref = (result: SearchResult) => {
    if (result.type === 'library') return `/library/${result.id}`
    if (result.type === 'group') return `/groups/${result.id}`
    if (result.type === 'post') return `/post/${result.id}`
    if (result.type === 'trader') return `/trader/${encodeURIComponent(result.id)}`
    return '#'
  }

  const totalResults = libraryResults.length + groupResults.length + postResults.length + traderResults.length

  const renderSection = (
    title: string,
    results: SearchResult[],
    total: number,
    tabParam: string,
    iconLetter: string,
    accentColor: string,
    accentBg: string,
  ) => {
    if (results.length === 0) return null
    return (
      <section style={{
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: 14,
        overflow: 'hidden',
      }}>
        {/* Section header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: `1px solid ${tokens.colors.border.primary}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: tokens.radius.md,
              background: accentBg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: accentColor,
            }}>
              {iconLetter}
            </div>
            <span style={{
              fontSize: 16, fontWeight: 600, color: tokens.colors.text.primary,
            }}>
              {title}
            </span>
            <span style={{
              fontSize: 12, color: tokens.colors.text.tertiary,
              fontWeight: 500,
            }}>
              {total > SECTION_LIMIT ? `${total}+` : total}
            </span>
          </div>
          {total > SECTION_LIMIT && (
            <Link
              href={`/search?q=${encodeURIComponent(query)}&tab=${tabParam}`}
              style={{
                fontSize: 13, color: tokens.colors.accent.brand,
                textDecoration: 'none', fontWeight: 500,
              }}
            >
              {t('searchViewAll')}
            </Link>
          )}
        </div>

        {/* Results */}
        {results.map((result, idx) => (
          <Link
            key={`${result.type}-${result.id}`}
            href={getHref(result)}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 18px',
              textDecoration: 'none', color: 'inherit',
              borderBottom: idx < results.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--overlay-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {highlightText(result.title, query)}
              </div>
              {result.subtitle && (
                <div style={{
                  fontSize: 12, color: tokens.colors.text.tertiary,
                  marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {result.subtitle}
                </div>
              )}
            </div>
            {result.meta && (
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: tokens.radius.full,
                background: accentBg, color: accentColor, fontWeight: 600,
                flexShrink: 0, textTransform: 'uppercase',
              }}>
                {result.meta}
              </span>
            )}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
        ))}
      </section>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary, isolation: 'isolate', position: 'relative' }}>
      <div style={{
        position: 'fixed', inset: 0,
        background: tokens.gradient.mesh, opacity: 0.5,
        pointerEvents: 'none', zIndex: 0,
      }} />
      <TopNav email={email} />
      <h1 className="sr-only">{t('searchResults')}</h1>

      <div style={{
        maxWidth: 900, margin: '0 auto',
        padding: '24px 20px 100px',
        position: 'relative', zIndex: 1,
      }}>
        {/* Search header */}
        {query && (
          <div style={{
            fontSize: 13, color: tokens.colors.text.tertiary,
            padding: '16px 0 8px', fontWeight: 500,
          }}>
            {t('searchResults')}: <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>&quot;{query}&quot;</span>
          </div>
        )}

        {/* Tab filters */}
        {query && !loading && !searchError && totalResults > 0 && (
          <div style={{
            display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap',
          }}>
            {[
              { key: 'all', label: t('searchTabAll'), count: libTotal + groupTotal + postTotal + traderTotal },
              { key: 'traders', label: t('traders'), count: traderTotal },
              { key: 'library', label: t('library'), count: libTotal },
              ...(features.social ? [{ key: 'posts', label: t('searchTabPosts'), count: postTotal }] : []),
              ...(features.social ? [{ key: 'groups', label: t('groups'), count: groupTotal }] : []),
            ].filter(tab => tab.key === 'all' || tab.count > 0).map(tab => (
              <Link
                key={tab.key}
                href={`/search?q=${encodeURIComponent(query)}${tab.key !== 'all' ? `&tab=${tab.key}` : ''}`}
                className="touch-target"
                style={{
                  padding: '6px 16px', borderRadius: tokens.radius.full,
                  background: activeTab === tab.key ? 'var(--color-accent-primary-15, var(--color-accent-primary-15))' : tokens.colors.bg.secondary,
                  border: `1px solid ${activeTab === tab.key ? 'var(--color-accent-primary-40, var(--color-accent-primary-40))' : tokens.colors.border.primary}`,
                  color: activeTab === tab.key ? tokens.colors.accent.brand : tokens.colors.text.secondary,
                  fontSize: 13, fontWeight: activeTab === tab.key ? 700 : 500,
                  textDecoration: 'none', transition: 'all 0.15s',
                }}
              >
                {tab.label} {tab.count > 0 && <span style={{ opacity: 0.6, fontSize: 11 }}>({tab.count})</span>}
              </Link>
            ))}
          </div>
        )}

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))', gap: 16, marginTop: 16 }}>
            {[1, 2, 3, 4].map(i => (
              <div key={i} style={{
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: 14, padding: 18,
              }}>
                <div className="skeleton" style={{ height: 18, width: '40%', marginBottom: 16, borderRadius: 6 }} />
                {[1, 2, 3].map(j => (
                  <div key={j} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                    <div className="skeleton" style={{ flex: 1, height: 14, borderRadius: 4 }} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : searchError ? (
          <ErrorState
            title={t('searchErrorTitle')}
            description={t('searchTryAgainLater')}
          />
        ) : !query ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div style={{
              width: 80, height: 80, borderRadius: '50%',
              background: tokens.gradient.primarySubtle,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 24px',
            }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: tokens.colors.text.primary, marginBottom: 8 }}>
              {t('search')}
            </div>
            <div style={{ fontSize: 14, color: tokens.colors.text.tertiary, maxWidth: 340, margin: '0 auto 32px' }}>
              {t('searchPrompt')}
            </div>

            {/* Search history */}
            {searchHistory.length > 0 && (
              <div style={{ maxWidth: 480, margin: '0 auto 24px', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}>
                    {t('searchRecentSearches')}
                  </div>
                  <button
                    onClick={() => { clearSearchHistory(); setSearchHistory([]) }}
                    style={{
                      fontSize: 11, color: tokens.colors.text.tertiary, background: 'none',
                      border: 'none', cursor: 'pointer', padding: '8px 12px',
                      minHeight: 44, display: 'inline-flex', alignItems: 'center',
                    }}
                  >
                    {t('searchClearHistory')}
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {searchHistory.map(term => (
                    <Link
                      key={term}
                      href={`/search?q=${encodeURIComponent(term)}`}
                      style={{
                        padding: '8px 18px', borderRadius: 10,
                        background: tokens.colors.bg.secondary,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        color: tokens.colors.text.secondary,
                        fontSize: 13, fontWeight: 500,
                        textDecoration: 'none', transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = tokens.colors.accent.brand
                        e.currentTarget.style.color = tokens.colors.text.primary
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = tokens.colors.border.primary
                        e.currentTarget.style.color = tokens.colors.text.secondary
                      }}
                    >
                      {term}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Hot searches */}
            <div style={{ maxWidth: 480, margin: '0 auto', textAlign: 'left' }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary,
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
              }}>
                {t('searchPopularSearches')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {trendingSearches.map(term => (
                  <Link
                    key={term}
                    href={`/search?q=${encodeURIComponent(term)}`}
                    style={{
                      padding: '8px 18px', borderRadius: 10,
                      background: tokens.colors.bg.secondary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      color: tokens.colors.text.secondary,
                      fontSize: 13, fontWeight: 500,
                      textDecoration: 'none', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = tokens.colors.accent.brand
                      e.currentTarget.style.color = tokens.colors.text.primary
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = tokens.colors.border.primary
                      e.currentTarget.style.color = tokens.colors.text.secondary
                    }}
                  >
                    {term}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        ) : totalResults === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <EmptyState
              icon={
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /><line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              }
              title={t('searchNoResultsTitle')}
              description={t('searchNoResultsFor').replace('{query}', query)}
              variant="compact"
            />
            {/* "Did you mean" suggestions */}
            {didYouMean.length > 0 && (
              <div style={{ maxWidth: 400, margin: '16px auto 0', textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: tokens.colors.text.secondary, marginBottom: 8, fontWeight: 500 }}>
                  {t('searchDidYouMean')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                  {didYouMean.map(suggestion => (
                    <Link
                      key={suggestion}
                      href={`/search?q=${encodeURIComponent(suggestion)}`}
                      style={{
                        padding: '8px 18px', borderRadius: 10,
                        background: 'var(--color-accent-primary-12)',
                        border: '1px solid var(--color-accent-primary-25)',
                        color: tokens.colors.accent.primary,
                        fontSize: 14, fontWeight: 600,
                        textDecoration: 'none', transition: 'all 0.15s',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = tokens.colors.accent.primary
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = 'var(--color-accent-primary-25)'
                      }}
                    >
                      {suggestion}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            <div style={{ maxWidth: 360, margin: '16px auto 0', textAlign: 'left' }}>
              <div style={{ fontSize: 12, color: tokens.colors.text.secondary, marginBottom: 10, fontWeight: 600 }}>
                {t('searchSuggestions')}:
              </div>
              <ul style={{ fontSize: 13, color: tokens.colors.text.tertiary, lineHeight: 2, paddingLeft: 18, margin: 0 }}>
                <li>{t('searchCheckTypos')}</li>
                <li>{t('searchTryShorterKeywords')}</li>
                <li>{t('searchTryTraderHandle')}</li>
              </ul>
            </div>
            {searchHistory.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                  {t('searchRecentSearches')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                  {searchHistory.slice(0, 5).map(term => (
                    <Link key={term} href={`/search?q=${encodeURIComponent(term)}`}
                      style={{
                        padding: '6px 14px', borderRadius: tokens.radius.md,
                        background: tokens.colors.bg.secondary,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        color: tokens.colors.text.secondary, fontSize: 12, textDecoration: 'none',
                      }}
                    >{term}</Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
            gap: 16, marginTop: 16,
          }}>
            {(activeTab === 'all' || activeTab === 'traders') && renderSection(
              t('traders'),
              traderResults, traderTotal, 'traders',
              'T', tokens.colors.accent.success || 'var(--color-score-great)', 'var(--color-accent-success-12)',
            )}
            {(activeTab === 'all' || activeTab === 'library') && renderSection(
              t('library'),
              libraryResults, libTotal, 'library',
              'L', tokens.colors.accent.brand, tokens.colors.accent.brandMuted || 'var(--color-accent-primary-15)',
            )}
            {features.social && (activeTab === 'all' || activeTab === 'posts') && renderSection(
              t('searchPostsSection'),
              postResults, postTotal, 'posts',
              'P', tokens.colors.accent.primary, tokens.gradient.primarySubtle || 'var(--color-indigo-subtle)',
            )}
            {features.social && (activeTab === 'all' || activeTab === 'groups') && renderSection(
              t('groups'),
              groupResults, groupTotal, 'groups',
              'G', tokens.colors.accent.warning || 'var(--color-score-average)', 'var(--color-orange-subtle)',
            )}
          </div>
        )}
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}


export default function SearchPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
          <div style={{ marginTop: 60 }}>
            <div className="skeleton" style={{ height: 200, borderRadius: 14 }} />
          </div>
        </div>
      </div>
    }>
      <SearchContent />
    </Suspense>
  )
}
