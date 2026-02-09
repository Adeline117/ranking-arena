'use client'

import { useEffect, useState, Suspense, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { logger } from '@/lib/logger'

interface SearchResult {
  type: 'library' | 'group' | 'post' | 'trader'
  id: string
  title: string
  subtitle?: string
  meta?: string
}

const SECTION_LIMIT = 5
const SEARCH_HISTORY_KEY = 'ranking-arena-search-history'
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
  const [loading, setLoading] = useState(false)
  const [email, setEmail] = useState<string | null>(null)
  const [searchError, setSearchError] = useState(false)
  const [searchHistory, setSearchHistory] = useState<string[]>([])
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
    // eslint-disable-next-line no-restricted-syntax -- TODO: migrate to useAuthSession()
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
    })
    setSearchHistory(getSearchHistory())
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
          backgroundColor: 'var(--color-accent-primary-25, rgba(139, 111, 168, 0.25))',
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

      const sanitized = query.trim().slice(0, 100).replace(/[\\%_]/g, c => `\\${c}`)
      if (!sanitized) { setLoading(false); return }

      try {
        const [libRes, groupRes, postRes, traderRes] = await Promise.allSettled([
          supabase.from('library_items')
            .select('id, title, author, category, cover_url', { count: 'exact' })
            .or(`title.ilike.%${sanitized}%,author.ilike.%${sanitized}%`)
            .limit(SECTION_LIMIT),
          supabase.from('groups')
            .select('id, name, member_count, description', { count: 'exact' })
            .ilike('name', `%${sanitized}%`)
            .limit(SECTION_LIMIT),
          supabase.from('posts')
            .select('id, title, content, author_handle', { count: 'exact' })
            .or(`title.ilike.%${sanitized}%,content.ilike.%${sanitized}%`)
            .limit(SECTION_LIMIT),
          supabase.from('trader_sources')
            .select('source_trader_id, handle, source, roi, arena_score, win_rate', { count: 'exact' })
            .or(`handle.ilike.%${sanitized}%,source_trader_id.ilike.%${sanitized}%`)
            .limit(SECTION_LIMIT),
        ])

        // Library
        if (libRes.status === 'fulfilled') {
          const { data, count } = libRes.value
          setLibTotal(count || 0)
          setLibraryResults((data || []).map((item: Record<string, unknown>) => ({
            type: 'library' as const,
            id: item.id as string,
            title: (item.title as string) || '',
            subtitle: (item.author as string) || undefined,
            meta: (item.category as string) || undefined,
          })))
        }

        // Groups
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

        // Posts
        if (postRes.status === 'fulfilled') {
          const { data, count } = postRes.value
          setPostTotal(count || 0)
          setPostResults((data || []).map((p: Record<string, unknown>) => ({
            type: 'post' as const,
            id: p.id as string,
            title: (p.title as string) || ((p.content as string) || '').slice(0, 60),
            subtitle: (p.author_handle as string) ? `${isZh ? '作者' : 'by'}: ${p.author_handle}` : undefined,
          })))
        }

        // Traders
        if (traderRes.status === 'fulfilled') {
          const { data, count } = traderRes.value
          setTraderTotal(count || 0)
          setTraderResults((data || []).map((t: Record<string, unknown>) => {
            const roi = t.roi as number | null
            const score = t.arena_score as number | null
            const winRate = t.win_rate as number | null
            const parts: string[] = [((t.source as string) || '').replace(/_/g, ' ').toUpperCase()]
            if (roi != null) parts.push(`ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`)
            if (score != null) parts.push(`Score: ${score.toFixed(0)}`)
            if (winRate != null) parts.push(`${isZh ? '胜率' : 'Win'}: ${winRate.toFixed(0)}%`)
            return {
              type: 'trader' as const,
              id: t.source_trader_id as string,
              title: (t.handle as string) || (t.source_trader_id as string),
              subtitle: parts.join(' · ') || undefined,
            }
          }))
        }
      } catch (error) {
        logger.error('Search error:', error)
        setSearchError(true)
        showToast(isZh ? '搜索失败' : 'Search failed', 'error')
      } finally {
        setLoading(false)
      }
    }

    const timeout = setTimeout(doSearch, 300)
    return () => clearTimeout(timeout)
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
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)' }}
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

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 20, marginTop: 16 }}>
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
              background: 'rgba(239, 68, 68, 0.1)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.5">
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
                {['BTC', 'ETH', 'Binance', 'Bitget', 'SOL'].map(term => (
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
            gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
            gap: 20, marginTop: 16,
          }}>
            {renderSection(
              isZh ? '书库' : 'Library',
              libraryResults, libTotal, 'library',
              'L', tokens.colors.accent.brand, tokens.colors.accent.brandMuted || 'rgba(139, 111, 168, 0.15)',
            )}
            {renderSection(
              isZh ? '小组' : 'Groups',
              groupResults, groupTotal, 'groups',
              'G', tokens.colors.accent.warning || '#f59e0b', 'rgba(245, 158, 11, 0.12)',
            )}
            {renderSection(
              isZh ? '动态/帖子' : 'Posts',
              postResults, postTotal, 'posts',
              'P', tokens.colors.accent.primary, tokens.gradient.primarySubtle || 'rgba(99, 102, 241, 0.12)',
            )}
            {renderSection(
              isZh ? '交易员' : 'Traders',
              traderResults, traderTotal, 'traders',
              'T', tokens.colors.accent.success || '#10b981', 'rgba(16, 185, 129, 0.12)',
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
