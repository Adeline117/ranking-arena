'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { useToast } from '@/app/components/ui/Toast'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import Link from 'next/link'
import { tokens, alpha } from '@/lib/design-tokens'
import ErrorState from '@/app/components/ui/ErrorState'
import EmptyState from '@/app/components/ui/EmptyState'
import Avatar from '@/app/components/ui/Avatar'
import type { UnifiedSearchResponse } from '@/app/api/search/route'
import { features } from '@/lib/features'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { useDebounce } from '@/lib/hooks/useDebounce'
import { getScoreColor } from '@/lib/utils/score-colors'
import { trackEvent } from '@/lib/analytics/track'
import {
  getSearchResultHref,
  mapPeopleSearchResults,
  type SearchResult,
} from './search-result-model'

const SECTION_LIMIT = 5

// Use shared search history service (syncs to Supabase for logged-in users)
import { getLocalHistory, addToHistory, clearHistory } from '@/lib/services/search-history'
const getSearchHistory = getLocalHistory
const saveSearchHistory = (query: string) => {
  addToHistory(query)
}
const clearSearchHistory = () => {
  clearHistory()
}

// ============================================
// SWR fetcher for search API
// ============================================

const searchFetcher = async (url: string): Promise<UnifiedSearchResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json.data || json
}

// Mapped search results used by the UI
interface MappedSearchResults {
  traderResults: SearchResult[]
  traderTotal: number
  postResults: SearchResult[]
  postTotal: number
  peopleResults: SearchResult[]
  peopleTotal: number
  groupResults: SearchResult[]
  groupTotal: number
  availablePlatforms: string[]
  didYouMean: string[]
}

function SearchContent() {
  const searchParams = useSearchParams()
  const { t } = useLanguage()
  const query = searchParams.get('q') || ''
  const activeTab = searchParams.get('tab') || 'all'
  const platformFilter = searchParams.get('platform') || ''
  const [inputValue, setInputValue] = useState(query)
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [trendingSearches, setTrendingSearches] = useState<string[]>([
    'BTC',
    'ETH',
    'Binance',
    'Bitget',
    'SOL',
  ])
  const { showToast } = useToast()

  // Sync input value when URL query changes externally (e.g. from nav bar)
  useEffect(() => {
    setInputValue(query)
  }, [query])

  // Update URL when input changes (debounced).
  // U3-2 ROOT-CAUSE FIX: the effect previously listed ONLY [debouncedInputValue]
  // (eslint-disabled), so it ran against a STALE `query`/`searchParams` closure.
  // When landing with ?q= already set (hard nav, or the nav dropdown's "see all
  // results"), typing a new word or hitting the ⊗ clear button fought the URL:
  //   • a stale debounced value re-added ?q=old right after `router.replace('/search')`
  //     ("clear was swallowed"),
  //   • and a stale searchParams dropped tab/platform on a stray replace.
  // Fixes: (1) full deps so the closure is always current; (2) act ONLY once the
  // debounce has SETTLED to the live input (`debouncedInputValue === inputValue.trim()`)
  // — this stops a not-yet-settled old value from racing a manual navigation and
  // re-adding ?q= after a clear. Building params from the CURRENT searchParams
  // preserves tab/platform.
  const debouncedInputValue = useDebounce(inputValue.trim(), 300)
  useEffect(() => {
    if (debouncedInputValue !== inputValue.trim()) return // debounce not settled yet
    if (debouncedInputValue === query) return
    const params = new URLSearchParams(searchParams.toString())
    if (debouncedInputValue) {
      params.set('q', debouncedInputValue)
    } else {
      params.delete('q')
    }
    const qs = params.toString()
    // U3-2 ROOT-CAUSE FIX (round 2): after the Wave-3 SSR conversion (commit
    // 0b8870b73) /search became a STATIC server shell + client leaf. On a static
    // route, PROGRAMMATIC `router.replace()` for a search-param-only change is a
    // silent no-op (the client router dedupes it) — so typing never rewrote the
    // URL and results (keyed off `query`) never refreshed. The homepage solved the
    // identical problem with native History (useRankingFilters.ts:362). Mirror it:
    // `window.history.replaceState` reliably updates the bar and useSearchParams
    // (Next 15.1+/16) reacts to it. Results no longer depend on this line at all —
    // they follow `debouncedInputValue` directly (see below) — this is purely for
    // shareable/bookmarkable/reloadable URLs.
    window.history.replaceState(null, '', qs ? `/search?${qs}` : '/search')
  }, [debouncedInputValue, inputValue, query, searchParams])

  // Results follow the SETTLED TYPED value, not the URL `query`. This decouples
  // the result set from same-route client navigation (which is unreliable on this
  // static shell — see the History fix above). `inputValue` is seeded from the URL
  // `query` on mount (useState(query)) and resynced on external URL changes
  // (trending-pill / tab / platform Link clicks → setInputValue(query) effect
  // above), so hard-nav landings, shared links, and Link clicks all still drive
  // results — while typing works even when router same-route nav is a no-op.
  const debouncedQuery = debouncedInputValue
  const debouncedPlatform = platformFilter

  // SWR key: null when no query (disables fetching)
  const searchKey = debouncedQuery
    ? `/api/search?q=${encodeURIComponent(debouncedQuery)}&limit=${SECTION_LIMIT}${debouncedPlatform ? `&platform=${encodeURIComponent(debouncedPlatform)}` : ''}`
    : null

  const {
    data: rawSearchData,
    error: searchFetchError,
    isLoading: swrLoading,
    refetch: retrySearch,
  } = useQuery<UnifiedSearchResponse>({
    queryKey: ['search', debouncedQuery, debouncedPlatform],
    queryFn: () => searchFetcher(searchKey!),
    enabled: !!searchKey,
    refetchOnWindowFocus: false,
    staleTime: STALE_STANDARD,
    placeholderData: (prev) => prev,
  })

  // Map raw API data to UI-friendly shape
  const mapped = useMemo<MappedSearchResults>(() => {
    if (!rawSearchData?.results) {
      return {
        traderResults: [],
        traderTotal: 0,
        postResults: [],
        postTotal: 0,
        peopleResults: [],
        peopleTotal: 0,
        groupResults: [],
        groupTotal: 0,
        availablePlatforms: [],
        didYouMean: [],
      }
    }
    const data = rawSearchData

    const mappedPosts = data.results.posts.map((p) => ({
      type: 'post' as const,
      id: p.id,
      title: p.title,
      subtitle: p.subtitle ? `${t('searchPostBy')}: ${p.subtitle}` : undefined,
    }))

    const mappedTraders = data.results.traders.map((tr) => ({
      type: 'trader' as const,
      // `tr.id` is the API's unique `platform:traderKey` (used only as React key).
      // Do NOT derive an id from href — it carries `?platform=...` which, once
      // re-encoded into the path, 404s the trader page (Trader Not Found bug).
      id: tr.id,
      title: tr.title,
      href: tr.href,
      subtitle: tr.subtitle || undefined,
      roi: typeof tr.meta?.roi === 'number' ? tr.meta.roi : null,
      score: typeof tr.meta?.arena_score === 'number' ? tr.meta.arena_score : null,
    }))

    const platforms = [
      ...new Set(data.results.traders.map((tr) => tr.meta?.platform as string).filter(Boolean)),
    ]

    const groupsResults = data.results.groups || []
    const peopleResults = mapPeopleSearchResults(data.results.users || [])
    const mappedGroups = groupsResults.map((g) => ({
      type: 'group' as const,
      id: g.id,
      title: g.title,
      subtitle: g.meta?.member_count
        ? `${(g.meta.member_count as number).toLocaleString('en-US')} ${t('members')}`
        : undefined,
      meta: g.subtitle ? g.subtitle.slice(0, 60) : undefined,
    }))

    return {
      postResults: mappedPosts,
      postTotal: data.results.posts.length,
      traderResults: mappedTraders,
      traderTotal: data.results.traders.length,
      peopleResults,
      peopleTotal: peopleResults.length,
      groupResults: mappedGroups,
      groupTotal: groupsResults.length,
      availablePlatforms: platforms,
      didYouMean: data.suggestions || [],
    }
  }, [rawSearchData, t])

  const {
    groupResults,
    groupTotal,
    postResults,
    postTotal,
    peopleResults,
    peopleTotal,
    traderResults,
    traderTotal,
    availablePlatforms,
    didYouMean,
  } = mapped

  const loading = swrLoading && !!debouncedQuery
  const searchError = !!searchFetchError && !!debouncedQuery

  // Show toast on search error
  useEffect(() => {
    if (searchFetchError && debouncedQuery) {
      showToast(t('searchFailedToast'), 'error')
    }
  }, [searchFetchError, debouncedQuery, showToast, t])

  // Save search history when results arrive
  useEffect(() => {
    if (!rawSearchData?.results || !debouncedQuery) return
    const totalReceived =
      rawSearchData.results.posts.length +
      rawSearchData.results.traders.length +
      (rawSearchData.results.users || []).length +
      (rawSearchData.results.groups || []).length
    if (totalReceived > 0) {
      saveSearchHistory(debouncedQuery)
      setSearchHistory(getSearchHistory())
    }
  }, [rawSearchData, debouncedQuery])

  useEffect(() => {
    setSearchHistory(getSearchHistory())

    // Trending pills render ONLY in the no-query empty state. Skip the fetch when
    // the user arrives with a query (pills never show) so it doesn't compete with
    // hydration on the already-TBT-heavy search page. Fires lazily once the empty
    // state becomes reachable (query cleared).
    if (query) return

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
  }, [query])

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
        <mark
          key={`hl-${idx}`}
          style={{
            backgroundColor: 'var(--color-accent-primary-25, var(--color-accent-primary-20))',
            color: 'inherit',
            borderRadius: 2,
            padding: '0 2px',
            fontWeight: 600,
          }}
        >
          {text.slice(idx, idx + lq.length)}
        </mark>
      )
      last = idx + lq.length
      idx = lower.indexOf(lq, last)
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts.length > 0 ? parts : text
  }, [])

  const totalResults =
    groupResults.length + peopleResults.length + postResults.length + traderResults.length

  // 3.10 — roving-tabindex / arrow-key navigation over the full results list.
  // Build a flat ordered list matching the section render order so a single
  // index maps each result link to its keyboard position.
  const tradersShown = activeTab === 'all' || activeTab === 'traders'
  const postsShown = features.social && (activeTab === 'all' || activeTab === 'posts')
  const peopleShown = features.social && (activeTab === 'all' || activeTab === 'people')
  const groupsShown = features.social && (activeTab === 'all' || activeTab === 'groups')
  const flatResults = useMemo(() => {
    const list: SearchResult[] = []
    // Keep trader discovery first. Social categories retain their existing
    // order, with People inserted before Groups.
    if (tradersShown) list.push(...traderResults)
    if (postsShown) list.push(...postResults)
    if (peopleShown) list.push(...peopleResults)
    if (groupsShown) list.push(...groupResults)
    return list
  }, [
    tradersShown,
    postsShown,
    peopleShown,
    groupsShown,
    traderResults,
    postResults,
    peopleResults,
    groupResults,
  ])
  const postOffset = tradersShown ? traderResults.length : 0
  const peopleOffset = postOffset + (postsShown ? postResults.length : 0)
  const groupOffset = peopleOffset + (peopleShown ? peopleResults.length : 0)

  const [selectedIndex, setSelectedIndex] = useState(-1)
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([])

  // Reset the highlight whenever the result set changes.
  useEffect(() => {
    setSelectedIndex(-1)
  }, [query, activeTab, flatResults.length])

  const focusResult = useCallback((index: number) => {
    setSelectedIndex(index)
    linkRefs.current[index]?.focus()
  }, [])

  const handleResultsKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatResults.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        focusResult(selectedIndex < flatResults.length - 1 ? selectedIndex + 1 : 0)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        focusResult(selectedIndex > 0 ? selectedIndex - 1 : flatResults.length - 1)
      } else if (e.key === 'Home') {
        e.preventDefault()
        focusResult(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        focusResult(flatResults.length - 1)
      }
      // Enter activates the focused <a> (Link) natively — no handler needed.
    },
    [flatResults.length, selectedIndex, focusResult]
  )

  const renderSection = (
    title: string,
    results: SearchResult[],
    total: number,
    tabParam: string,
    iconLetter: string,
    accentColor: string,
    accentBg: string,
    indexOffset: number
  ) => {
    if (results.length === 0) {
      return (
        <section
          style={{
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.lg,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 18px',
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.md,
                background: accentBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700,
                color: accentColor,
              }}
            >
              {iconLetter}
            </div>
            <span
              style={{
                fontSize: 14,
                color: tokens.colors.text.tertiary,
                fontWeight: 500,
              }}
            >
              {t('searchNoSectionResults').replace('{type}', title)}
            </span>
          </div>
        </section>
      )
    }
    return (
      <section
        style={{
          background: tokens.colors.bg.secondary,
          border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.lg,
          overflow: 'hidden',
        }}
      >
        {/* Section header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: tokens.radius.md,
                background: accentBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700,
                color: accentColor,
              }}
            >
              {iconLetter}
            </div>
            <span
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: tokens.colors.text.primary,
              }}
            >
              {title}
            </span>
            <span
              style={{
                fontSize: 12,
                color: tokens.colors.text.tertiary,
                fontWeight: 500,
              }}
            >
              {total > SECTION_LIMIT ? `${total}+` : total}
            </span>
          </div>
          {total > SECTION_LIMIT && (
            <Link
              href={`/search?q=${encodeURIComponent(query)}&tab=${tabParam}`}
              style={{
                fontSize: 13,
                color: 'var(--color-brand-text)',
                textDecoration: 'none',
                fontWeight: 500,
              }}
            >
              {t('searchViewAll')}
            </Link>
          )}
        </div>

        {/* Results */}
        {results.map((result, idx) => {
          const globalIndex = indexOffset + idx
          return (
            <Link
              key={`${result.type}-${result.id}-${idx}`}
              href={getSearchResultHref(result)}
              ref={(el) => {
                linkRefs.current[globalIndex] = el
              }}
              tabIndex={globalIndex === Math.max(selectedIndex, 0) ? 0 : -1}
              onFocus={() => setSelectedIndex(globalIndex)}
              onClick={() =>
                trackEvent('search_result_click', {
                  queryLength: query.trim().length,
                  resultId: result.id,
                  resultType: result.type,
                  surface: 'search_page',
                })
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 18px',
                textDecoration: 'none',
                color: 'inherit',
                borderBottom:
                  idx < results.length - 1 ? `1px solid ${tokens.colors.border.primary}` : 'none',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--overlay-hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {result.type === 'user' && (
                <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
                  <Avatar
                    userId={result.id}
                    name={result.title.replace(/^@/, '')}
                    avatarUrl={result.avatar}
                    size={32}
                    style={{ boxShadow: 'none' }}
                  />
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: tokens.colors.text.primary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {highlightText(result.title, query)}
                </div>
                {result.subtitle && (
                  <div
                    style={{
                      fontSize: 12,
                      color: tokens.colors.text.tertiary,
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {result.type === 'trader' && (result.roi != null || result.score != null)
                      ? // Color ROI (by sign) + Score (by tier) within the subtitle; the
                        // exchange/rank parts stay neutral. Format: "exchange · #rank · ROI · Score".
                        result.subtitle.split(' · ').map((part, i, arr) => {
                          const isRoi = result.roi != null && /%$/.test(part) && /[+-]/.test(part)
                          const isScore = result.score != null && /^score/i.test(part)
                          const c = isRoi
                            ? result.roi! >= 0
                              ? 'var(--color-accent-success)'
                              : 'var(--color-accent-error)'
                            : isScore
                              ? getScoreColor(result.score!)
                              : undefined
                          return (
                            <span key={i}>
                              <span
                                style={
                                  c
                                    ? { color: c, fontWeight: tokens.typography.fontWeight.bold }
                                    : undefined
                                }
                              >
                                {part}
                              </span>
                              {i < arr.length - 1 ? ' · ' : ''}
                            </span>
                          )
                        })
                      : result.subtitle}
                  </div>
                )}
              </div>
              {result.meta && (
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: tokens.radius.full,
                    background: accentBg,
                    color: accentColor,
                    fontWeight: 600,
                    flexShrink: 0,
                    textTransform: 'uppercase',
                  }}
                >
                  {result.meta}
                </span>
              )}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke={tokens.colors.text.tertiary}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0, opacity: 0.5 }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </Link>
          )
        })}
      </section>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
      }}
    >
      <h1 className="sr-only">{t('searchResults')}</h1>

      <div
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '24px 20px 100px',
        }}
      >
        {/* Inline search input — users can refine without scrolling to nav bar */}
        <div style={{ position: 'relative', marginBottom: 16 }}>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.text.tertiary}
            strokeWidth="2"
            strokeLinecap="round"
            style={{
              position: 'absolute',
              left: 18,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
            }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={t('searchPlaceholder')}
            autoFocus={!query}
            enterKeyHint="search"
            style={{
              width: '100%',
              padding: '16px 18px 16px 54px',
              fontSize: '17px', // >= 16px prevents iOS Safari auto-zoom
              fontWeight: 500,
              color: tokens.colors.text.primary,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.xl,
              outline: 'none',
              boxShadow: '0 1px 2px var(--color-overlay-subtle)',
              boxSizing: 'border-box',
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.accent.primary
              e.currentTarget.style.boxShadow = `0 0 0 3px ${alpha(tokens.colors.accent.primary, 18)}`
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = tokens.colors.border.primary
              e.currentTarget.style.boxShadow = '0 1px 2px var(--color-overlay-subtle)'
            }}
          />
          {inputValue && (
            <button
              onClick={() => {
                // Clearing the input empties results (they follow the typed
                // value) and strips ?q from the URL. Native History for the same
                // static-shell reason as the debounce effect; preserve any
                // non-q params (lang/tab/platform).
                setInputValue('')
                const params = new URLSearchParams(searchParams.toString())
                params.delete('q')
                const qs = params.toString()
                window.history.replaceState(null, '', qs ? `/search?${qs}` : '/search')
              }}
              style={{
                position: 'absolute',
                right: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                background: `${alpha(tokens.colors.text.tertiary, 13)}`,
                border: 'none',
                borderRadius: tokens.radius.full,
                width: 22,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: tokens.colors.text.tertiary,
                fontSize: 14,
                lineHeight: 1,
              }}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {/* Search header */}
        {query && (
          <div
            style={{
              fontSize: 13,
              color: tokens.colors.text.tertiary,
              padding: '16px 0 8px',
              fontWeight: 500,
            }}
          >
            {t('searchResults')}:{' '}
            <span style={{ color: tokens.colors.text.primary, fontWeight: 600 }}>
              &quot;{query}&quot;
            </span>
          </div>
        )}

        {/* Tab filters */}
        {query && !loading && !searchError && totalResults > 0 && (
          <nav
            aria-label={t('searchResults')}
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 16,
              flexWrap: 'wrap',
            }}
          >
            {[
              {
                key: 'all',
                label: t('searchTabAll'),
                count: groupTotal + peopleTotal + postTotal + traderTotal,
              },
              { key: 'traders', label: t('traders'), count: traderTotal },
              ...(features.social
                ? [{ key: 'posts', label: t('searchTabPosts'), count: postTotal }]
                : []),
              ...(features.social
                ? [{ key: 'people', label: t('searchTabPeople'), count: peopleTotal }]
                : []),
              ...(features.social
                ? [{ key: 'groups', label: t('groups'), count: groupTotal }]
                : []),
            ]
              .filter((tab) => tab.key === 'all' || tab.count > 0)
              .map((tab) => (
                <Link
                  key={tab.key}
                  href={`/search?q=${encodeURIComponent(query)}${tab.key !== 'all' ? `&tab=${tab.key}` : ''}`}
                  className="touch-target"
                  aria-current={activeTab === tab.key ? 'page' : undefined}
                  style={{
                    padding: '6px 16px',
                    borderRadius: tokens.radius.full,
                    background:
                      activeTab === tab.key
                        ? 'var(--color-accent-primary-15, var(--color-accent-primary-15))'
                        : tokens.colors.bg.secondary,
                    border: `1px solid ${activeTab === tab.key ? 'var(--color-accent-primary-40, var(--color-accent-primary-40))' : tokens.colors.border.primary}`,
                    color:
                      activeTab === tab.key
                        ? 'var(--color-brand-text)'
                        : tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: activeTab === tab.key ? 700 : 500,
                    textDecoration: 'none',
                    transition: tokens.transition.fast,
                  }}
                >
                  {tab.label} {tab.count > 0 && <span style={{ fontSize: 11 }}>({tab.count})</span>}
                </Link>
              ))}
          </nav>
        )}

        {/* Platform filter pills (when viewing traders tab and multiple platforms exist) */}
        {query &&
          !loading &&
          !searchError &&
          (activeTab === 'all' || activeTab === 'traders') &&
          availablePlatforms.length > 1 && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                marginBottom: 12,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: tokens.colors.text.tertiary,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginRight: 4,
                }}
              >
                {t('platform')}:
              </span>
              <Link
                href={`/search?q=${encodeURIComponent(query)}${activeTab !== 'all' ? `&tab=${activeTab}` : ''}`}
                style={{
                  padding: '4px 12px',
                  borderRadius: tokens.radius.full,
                  fontSize: 12,
                  fontWeight: 500,
                  background: !platformFilter
                    ? 'var(--color-accent-primary-15)'
                    : tokens.colors.bg.secondary,
                  border: `1px solid ${!platformFilter ? 'var(--color-accent-primary-40)' : tokens.colors.border.primary}`,
                  color: !platformFilter ? 'var(--color-brand-text)' : tokens.colors.text.tertiary,
                  textDecoration: 'none',
                  transition: 'all 0.15s',
                }}
              >
                {t('searchTabAll')}
              </Link>
              {availablePlatforms.slice(0, 8).map((p) => {
                const name = EXCHANGE_CONFIG[p as keyof typeof EXCHANGE_CONFIG]?.name || p
                const isActive = platformFilter === p
                return (
                  <Link
                    key={p}
                    href={`/search?q=${encodeURIComponent(query)}${activeTab !== 'all' ? `&tab=${activeTab}` : ''}&platform=${encodeURIComponent(p)}`}
                    style={{
                      padding: '4px 12px',
                      borderRadius: tokens.radius.full,
                      fontSize: 12,
                      fontWeight: 500,
                      background: isActive
                        ? 'var(--color-accent-primary-15)'
                        : tokens.colors.bg.secondary,
                      border: `1px solid ${isActive ? 'var(--color-accent-primary-40)' : tokens.colors.border.primary}`,
                      color: isActive ? 'var(--color-brand-text)' : tokens.colors.text.tertiary,
                      textDecoration: 'none',
                      transition: 'all 0.15s',
                    }}
                  >
                    {name}
                  </Link>
                )
              })}
            </div>
          )}

        {loading ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
              gap: 16,
              marginTop: 16,
            }}
          >
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  background: tokens.colors.bg.secondary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.lg,
                  padding: 18,
                }}
              >
                <div
                  className="skeleton"
                  style={{
                    height: 18,
                    width: '40%',
                    marginBottom: 16,
                    borderRadius: tokens.radius.sm,
                  }}
                />
                {[1, 2, 3].map((j) => (
                  <div key={j} style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
                    <div
                      className="skeleton"
                      style={{ flex: 1, height: 14, borderRadius: tokens.radius.sm }}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : searchError ? (
          <ErrorState
            title={t('searchErrorTitle')}
            description={t('searchTryAgainLater')}
            retry={() => void retrySearch()}
          />
        ) : !query ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: '50%',
                background: tokens.gradient.primarySubtle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 24px',
              }}
            >
              <svg
                width="36"
                height="36"
                viewBox="0 0 24 24"
                fill="none"
                stroke={tokens.colors.accent.primary}
                strokeWidth="1.5"
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                color: tokens.colors.text.primary,
                marginBottom: 8,
              }}
            >
              {t('search')}
            </div>
            <div
              style={{
                fontSize: 14,
                color: tokens.colors.text.tertiary,
                maxWidth: 340,
                margin: '0 auto 32px',
              }}
            >
              {t('searchPrompt')}
            </div>

            {/* Search history */}
            {searchHistory.length > 0 && (
              <div style={{ maxWidth: 480, margin: '0 auto 24px', textAlign: 'left' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: tokens.colors.text.secondary,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {t('searchRecentSearches')}
                  </div>
                  <button
                    onClick={() => {
                      clearSearchHistory()
                      setSearchHistory([])
                    }}
                    style={{
                      fontSize: 11,
                      color: tokens.colors.text.tertiary,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '8px 12px',
                      minHeight: 44,
                      display: 'inline-flex',
                      alignItems: 'center',
                    }}
                  >
                    {t('searchClearHistory')}
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {searchHistory.map((term) => (
                    <Link
                      key={term}
                      href={`/search?q=${encodeURIComponent(term)}`}
                      style={{
                        padding: '8px 18px',
                        borderRadius: tokens.radius.md,
                        background: tokens.colors.bg.secondary,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        color: tokens.colors.text.secondary,
                        fontSize: 13,
                        fontWeight: 500,
                        textDecoration: 'none',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = tokens.colors.accent.brand
                        e.currentTarget.style.color = tokens.colors.text.primary
                      }}
                      onMouseLeave={(e) => {
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
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: tokens.colors.text.secondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 10,
                }}
              >
                {t('searchPopularSearches')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {trendingSearches.map((term) => (
                  <Link
                    key={term}
                    href={`/search?q=${encodeURIComponent(term)}`}
                    style={{
                      padding: '8px 18px',
                      borderRadius: tokens.radius.md,
                      background: tokens.colors.bg.secondary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      color: tokens.colors.text.secondary,
                      fontSize: 13,
                      fontWeight: 500,
                      textDecoration: 'none',
                      transition: 'all 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = tokens.colors.accent.brand
                      e.currentTarget.style.color = tokens.colors.text.primary
                    }}
                    onMouseLeave={(e) => {
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
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={tokens.colors.text.tertiary}
                  strokeWidth="1.5"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                  <line x1="8" y1="11" x2="14" y2="11" />
                </svg>
              }
              title={t('searchNoResultsTitle')}
              description={t('searchNoResultsFor').replace('{query}', query)}
              variant="compact"
            />
            {/* "Did you mean" suggestions */}
            {didYouMean.length > 0 && (
              <div style={{ maxWidth: 400, margin: '16px auto 0', textAlign: 'center' }}>
                <div
                  style={{
                    fontSize: 13,
                    color: tokens.colors.text.secondary,
                    marginBottom: 8,
                    fontWeight: 500,
                  }}
                >
                  {t('searchDidYouMean')}
                </div>
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}
                >
                  {didYouMean.map((suggestion) => (
                    <Link
                      key={suggestion}
                      href={`/search?q=${encodeURIComponent(suggestion)}`}
                      style={{
                        padding: '8px 18px',
                        borderRadius: tokens.radius.md,
                        background: 'var(--color-accent-primary-12)',
                        border: '1px solid var(--color-accent-primary-25)',
                        color: tokens.colors.accent.primary,
                        fontSize: 14,
                        fontWeight: 600,
                        textDecoration: 'none',
                        transition: 'all 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = tokens.colors.accent.primary
                      }}
                      onMouseLeave={(e) => {
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
              <div
                style={{
                  fontSize: 12,
                  color: tokens.colors.text.secondary,
                  marginBottom: 10,
                  fontWeight: 600,
                }}
              >
                {t('searchSuggestions')}:
              </div>
              <ul
                style={{
                  fontSize: 13,
                  color: tokens.colors.text.tertiary,
                  lineHeight: 2,
                  paddingLeft: 18,
                  margin: 0,
                }}
              >
                <li>{t('searchCheckTypos')}</li>
                <li>{t('searchTryShorterKeywords')}</li>
                <li>{t('searchTryTraderHandle')}</li>
              </ul>
            </div>
            {searchHistory.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: tokens.colors.text.secondary,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    {t('searchRecentSearches')}
                  </div>
                  {/* U3-4: no-results empty state was missing the clear-history
                      entry that both the no-query empty state and the nav dropdown
                      already expose. Add the same control here for parity. */}
                  <button
                    onClick={() => {
                      clearSearchHistory()
                      setSearchHistory([])
                    }}
                    style={{
                      fontSize: 11,
                      color: tokens.colors.text.tertiary,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 6px',
                    }}
                  >
                    {t('searchClearHistory')}
                  </button>
                </div>
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}
                >
                  {searchHistory.slice(0, 5).map((term) => (
                    <Link
                      key={term}
                      href={`/search?q=${encodeURIComponent(term)}`}
                      style={{
                        padding: '6px 14px',
                        borderRadius: tokens.radius.md,
                        background: tokens.colors.bg.secondary,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        color: tokens.colors.text.secondary,
                        fontSize: 12,
                        textDecoration: 'none',
                      }}
                    >
                      {term}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            onKeyDown={handleResultsKeyDown}
            aria-label={t('searchResults')}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
              gap: 16,
              marginTop: 16,
              // Keep each section at its natural height. Default align-items:stretch
              // made an empty "No Traders found" card stretch to match the tall Posts
              // column, leaving a large dead grey panel (common, since trader search
              // often returns 0 results).
              alignItems: 'start',
            }}
          >
            {tradersShown &&
              (activeTab !== 'all' || traderResults.length > 0) &&
              renderSection(
                t('traders'),
                traderResults,
                traderTotal,
                'traders',
                'T',
                tokens.colors.accent.success || 'var(--color-score-great)',
                'var(--color-accent-success-12)',
                0
              )}
            {postsShown &&
              (activeTab !== 'all' || postResults.length > 0) &&
              renderSection(
                t('searchPostsSection'),
                postResults,
                postTotal,
                'posts',
                'P',
                tokens.colors.accent.primary,
                tokens.gradient.primarySubtle || 'var(--color-indigo-subtle)',
                postOffset
              )}
            {peopleShown &&
              (activeTab !== 'all' || peopleResults.length > 0) &&
              renderSection(
                t('searchTabPeople'),
                peopleResults,
                peopleTotal,
                'people',
                'U',
                tokens.colors.accent.primary,
                'var(--color-accent-primary-12)',
                peopleOffset
              )}
            {groupsShown &&
              (activeTab !== 'all' || groupResults.length > 0) &&
              renderSection(
                t('groups'),
                groupResults,
                groupTotal,
                'groups',
                'G',
                tokens.colors.accent.warning || 'var(--color-score-average)',
                'var(--color-orange-subtle)',
                groupOffset
              )}
          </div>
        )}
      </div>
      {/* MobileBottomNav rendered in root layout */}
    </div>
  )
}

export default function SearchPageClient() {
  return <SearchContent />
}
