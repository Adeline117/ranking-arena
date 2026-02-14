'use client'

import { useEffect, useState, Suspense, useCallback, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'
import type { UnifiedSearchResponse } from '@/app/api/search/route'

interface SearchResult {
  type: 'library' | 'group' | 'post' | 'trader'
  id: string
  title: string
  subtitle?: string
  meta?: string
}

const SECTION_LIMIT = 5
const SEARCH_HISTORY_KEY = 'arena_search_history'
const MAX_HISTORY = 10

function getSearchHistory(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveSearchHistory(query: string) {
  if (typeof window === 'undefined' || !query.trim()) return
  try {
    const history = getSearchHistory().filter(h => h !== query.trim())
    history.unshift(query.trim())
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)))
  } catch { /* ignore */ }
}

function clearSearchHistory() {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem(SEARCH_HISTORY_KEY) } catch { /* ignore */ }
}

function SearchContent() {
  const searchParams = useSearchParams()
  const _router = useRouter()
  const { t: _t, language } = useLanguage()
  const isZh = language === 'zh'
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

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
    setSearchHistory(getSearchHistory())
    
    // 加载热门搜索数据
    const loadTrendingSearches = async () => {
      try {
        const response = await fetch('/api/search/trending')
        if (response.ok) {
          const result = await response.json()
          const data = result.data || result
          
          // 使用真实热门搜索或退回到fallback
          const trending = data.trending || []
          const fallback = data.fallback || ['BTC', 'ETH', 'Binance', 'Bitget', 'SOL']
          
          if (trending.length >= 3) {
            setTrendingSearches(trending.slice(0, 6).map((item: any) => item.query))
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

  // Save successful searches to history
  useEffect(() => {
    if (query.trim() && !loading && !searchError) {
      const total = libraryResults.length + groupResults.length + postResults.length + traderResults.length
      if (total > 0) {
        saveSearchHistory(query.trim())
        setSearchHistory(getSearchHistory())
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

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
        <span key={`hl-${idx}`} style={{
          backgroundColor: 'var(--color-accent-primary-25, var(--color-accent-primary-20))',
          color: 'inherit', borderRadius: 2, padding: '0 2px', fontWeight: 600,
        }}>
          {text.slice(idx, idx + lq.length)}
        </span>
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
        const [apiRes, groupRes] = await Promise.allSettled([
          fetch(`/api/search?q=${encodeURIComponent(query.trim())}&limit=${SECTION_LIMIT}`, {
            signal: controller.signal,
          }),
          // Groups are not in the unified API, query separately
          supabase.from('groups')
            .select('id, name, member_count, description', { count: 'exact' })
            .ilike('name', `%${query.trim().slice(0, 100).replace(/[\\%_]/g, c => `\\${c}`)}%`)
            .limit(SECTION_LIMIT),
        ])

        if (controller.signal.aborted) return

        // Process unified API results
        if (apiRes.status === 'fulfilled' && apiRes.value.ok) {
          const json = await apiRes.value.json()
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
            subtitle: p.subtitle ? `${isZh ? '作者' : 'by'}: ${p.subtitle}` : undefined,
          })))

          // Traders
          setTraderTotal(data.results.traders.length)
          setTraderResults(data.results.traders.map(t => ({
            type: 'trader' as const,
            id: t.href.replace('/trader/', ''),
            title: t.title,
            subtitle: t.subtitle || undefined,
          })))
        } else {
          setLibraryResults([])
          setPostResults([])
          setTraderResults([])
          setLibTotal(0)
          setPostTotal(0)
          setTraderTotal(0)
        }

        // Groups (separate query)
        if (groupRes.status === 'fulfilled') {
          const { data, count } = groupRes.value
          setGroupTotal(count || 0)
          setGroupResults((data || []).map((g: Record<string, unknown>) => ({
            type: 'group' as const,
            id: g.id as string,
            title: (g.name as string) || '',
            subtitle: g.member_count ? `${(g.member_count as number).toLocaleString()} ${isZh ? '成员' : 'members'}` : undefined,
            meta: g.description ? ((g.description as string).slice(0, 60)) : undefined,
          })))
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        logger.error('Search error:', error)
        setSearchError(true)
        showToast(isZh ? '搜索失败' : 'Search failed', 'error')
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
  }, [query, isZh, showToast])

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
              {isZh ? '查看全部' : 'View all'}
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
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <div style={{
        position: 'fixed', inset: 0,
        background: tokens.gradient.mesh, opacity: 0.5,
        pointerEvents: 'none', zIndex: 0,
      }} />
      <TopNav email={email} />

      <main style={{
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
            {isZh ? '搜索结果' : 'Search results'}: <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>&quot;{query}&quot;</span>
          </div>
        )}

        {/* Tab filters */}
        {query && !loading && !searchError && totalResults > 0 && (
          <div style={{
            display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap',
          }}>
            {[
              { key: 'all', label: isZh ? '全部' : 'All', count: libTotal + groupTotal + postTotal + traderTotal },
              { key: 'traders', label: isZh ? '交易员' : 'Traders', count: traderTotal },
              { key: 'posts', label: isZh ? '帖子' : 'Posts', count: postTotal },
              { key: 'library', label: isZh ? '书库' : 'Library', count: libTotal },
              { key: 'groups', label: isZh ? '小组' : 'Groups', count: groupTotal },
            ].filter(tab => tab.key === 'all' || tab.count > 0).map(tab => (
              <Link
                key={tab.key}
                href={`/search?q=${encodeURIComponent(query)}${tab.key !== 'all' ? `&tab=${tab.key}` : ''}`}
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
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: 'var(--color-accent-error-10)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-error)" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 6 }}>
              {isZh ? '搜索出错' : 'Search failed'}
            </div>
            <div style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
              {isZh ? '请稍后再试' : 'Please try again later'}
            </div>
          </div>
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
              {isZh ? '搜索' : 'Search'}
            </div>
            <div style={{ fontSize: 14, color: tokens.colors.text.tertiary, maxWidth: 340, margin: '0 auto 32px' }}>
              {isZh ? '搜索书库、小组、帖子、交易员...' : 'Search library, groups, posts, traders...'}
            </div>

            {/* Search history */}
            {searchHistory.length > 0 && (
              <div style={{ maxWidth: 480, margin: '0 auto 24px', textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{
                    fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}>
                    {isZh ? '搜索历史' : 'Recent searches'}
                  </div>
                  <button
                    onClick={() => { clearSearchHistory(); setSearchHistory([]) }}
                    style={{
                      fontSize: 11, color: tokens.colors.text.tertiary, background: 'none',
                      border: 'none', cursor: 'pointer', padding: '2px 6px',
                    }}
                  >
                    {isZh ? '清除' : 'Clear'}
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
                {isZh ? '热门搜索' : 'Popular searches'}
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
            <div style={{
              width: 72, height: 72, borderRadius: '50%',
              background: tokens.gradient.primarySubtle,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px', opacity: 0.8,
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /><line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 6 }}>
              {isZh ? '未找到结果' : 'No results'}
            </div>
            <div style={{ fontSize: 13, color: tokens.colors.text.tertiary, marginBottom: 24 }}>
              {isZh ? `未找到与"${query}"相关的内容` : `No results for "${query}"`}
            </div>
            <div style={{ maxWidth: 360, margin: '0 auto', textAlign: 'left' }}>
              <div style={{ fontSize: 12, color: tokens.colors.text.secondary, marginBottom: 10, fontWeight: 600 }}>
                {isZh ? '建议' : 'Suggestions'}:
              </div>
              <ul style={{ fontSize: 13, color: tokens.colors.text.tertiary, lineHeight: 2, paddingLeft: 18, margin: 0 }}>
                <li>{isZh ? '检查是否有拼写错误' : 'Check for typos'}</li>
                <li>{isZh ? '尝试使用更短或更通用的关键词' : 'Try shorter or more general keywords'}</li>
                <li>{isZh ? '尝试使用交易员的handle或平台名称搜索' : 'Try searching by trader handle or platform name'}</li>
              </ul>
            </div>
            {searchHistory.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: tokens.colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                  {isZh ? '最近搜索' : 'Recent searches'}
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
            {(activeTab === 'all' || activeTab === 'library') && renderSection(
              isZh ? '书库' : 'Library',
              libraryResults, libTotal, 'library',
              'L', tokens.colors.accent.brand, tokens.colors.accent.brandMuted || 'var(--color-accent-primary-15)',
            )}
            {(activeTab === 'all' || activeTab === 'groups') && renderSection(
              isZh ? '小组' : 'Groups',
              groupResults, groupTotal, 'groups',
              'G', tokens.colors.accent.warning || 'var(--color-score-average)', 'var(--color-orange-subtle)',
            )}
            {(activeTab === 'all' || activeTab === 'posts') && renderSection(
              isZh ? '动态/帖子' : 'Posts',
              postResults, postTotal, 'posts',
              'P', tokens.colors.accent.primary, tokens.gradient.primarySubtle || 'var(--color-indigo-subtle)',
            )}
            {(activeTab === 'all' || activeTab === 'traders') && renderSection(
              isZh ? '交易员' : 'Traders',
              traderResults, traderTotal, 'traders',
              'T', tokens.colors.accent.success || 'var(--color-score-great)', 'var(--color-accent-success-12)',
            )}
          </div>
        )}
      </main>
      <MobileBottomNav />
    </div>
  )
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
          <div style={{ marginTop: 60 }}>
            <div className="skeleton" style={{ height: 200, borderRadius: 14 }} />
          </div>
        </main>
      </div>
    }>
      <SearchContent />
    </Suspense>
  )
}
