'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { supabase } from '@/lib/supabase/client'
import StarRating from '@/app/components/ui/StarRating'
import TopLeaderboards, { type LeaderboardEntry, type LeaderboardColumn } from '@/app/components/ui/TopLeaderboards'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DirectoryItem {
  id: string
  name: string
  name_zh: string | null
  category: string
  logo_url: string | null
  website: string | null
  github_url?: string | null
  description: string | null
  description_zh: string | null
  pricing?: string | null
  avg_rating: number | null
  rating_count: number
  tags: string[] | null
}

export interface CategoryFilter {
  key: string
  labelKey: string
  isGroup?: boolean
}

export interface SortOption {
  key: string
  labelKey: string
}

export interface LeaderboardConfig {
  title: string
  icon: React.ReactNode
  categories?: string[]
  /** If provided, uses .or() instead of .in() for category matching */
  orFilter?: string
}

export interface DirectoryPageConfig {
  /** Supabase table name */
  table: 'institutions' | 'tools'
  /** Extra select columns beyond common ones */
  extraColumns?: string
  /** Category filter chips */
  categoryFilters: readonly CategoryFilter[]
  /** Groups mapping category key → array of sub-categories */
  categoryGroups: Record<string, string[]>
  /** Sort options */
  sortOptions: readonly SortOption[]
  /** Pricing label mapping (tools only) */
  pricingLabelKeys?: Record<string, string>
  /** Category key → i18n labelKey mapping (auto-built from categoryFilters) */
  categoryLabelMap?: Record<string, string>
  /** Top leaderboard columns config */
  leaderboards: LeaderboardConfig[]
  /** Page header */
  header: {
    titleKey: string
    subtitleKey: string
    icon?: React.ReactNode
    /** CSS gradient for title text */
    gradient?: string
    /** Accent color for active filters */
    accentVar?: string
    accentMutedVar?: string
  }
  /** i18n keys */
  i18n: {
    searchPlaceholder: string
    emptyText: string
    noRatingsYet?: string
  }
}

// ─── Sanitize search input ───────────────────────────────────────────────────

function sanitizeSearch(input: string): string {
  return input.replace(/[%_(),.'"\\]/g, '').trim()
}

// ─── Select columns ─────────────────────────────────────────────────────────

const BASE_COLUMNS = 'id, name, name_zh, category, logo_url, website, description, description_zh, avg_rating, rating_count, tags'

// ─── Component ───────────────────────────────────────────────────────────────

export default function DirectoryPage({ config }: { config: DirectoryPageConfig }) {
  const { language, t } = useLanguage()
  const router = useRouter()
  const searchParams = useSearchParams()

  // URL-synced state
  const initialCategory = searchParams.get('cat') || 'all'
  const initialSort = searchParams.get('sort') || 'rating'
  const initialSearch = searchParams.get('q') || ''

  const [items, setItems] = useState<DirectoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState(initialCategory)
  const [sort, setSort] = useState(initialSort)
  const [search, setSearch] = useState(initialSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch)
  const [error, setError] = useState<string | null>(null)
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({})
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const filterScrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const selectColumns = config.extraColumns
    ? `${BASE_COLUMNS}, ${config.extraColumns}`
    : BASE_COLUMNS

  const categoryLabelMap = useMemo(() =>
    Object.fromEntries(config.categoryFilters.map(f => [f.key, f.labelKey])),
    [config.categoryFilters],
  )

  // Keyboard shortcut: "/" to focus search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Sync state → URL
  const syncUrl = useCallback((cat: string, s: string, q: string) => {
    const params = new URLSearchParams()
    if (cat !== 'all') params.set('cat', cat)
    if (s !== 'rating') params.set('sort', s)
    if (q) params.set('q', q)
    const qs = params.toString()
    router.replace(`?${qs}`, { scroll: false })
  }, [router])

  // Debounce search
  useEffect(() => {
    clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search)
      syncUrl(category, sort, search)
    }, 300)
    return () => clearTimeout(searchTimerRef.current)
  }, [search, category, sort, syncUrl])

  // Auto-scroll active filter into view on mobile
  const handleCategoryChange = useCallback((cat: string) => {
    setCategory(cat)
    syncUrl(cat, sort, search)
    // Scroll active chip into view
    requestAnimationFrame(() => {
      const container = filterScrollRef.current
      if (!container) return
      const activeEl = container.querySelector('.directory-filter-chip.active') as HTMLElement
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
      }
    })
  }, [sort, search, syncUrl])

  const handleSortChange = useCallback((s: string) => {
    setSort(s)
    syncUrl(category, s, search)
  }, [category, search, syncUrl])

  const handleClearSearch = useCallback(() => {
    setSearch('')
    setDebouncedSearch('')
    syncUrl(category, sort, '')
    searchInputRef.current?.focus()
  }, [category, sort, syncUrl])

  // ─── Leaderboards ───────────────────────────────────────────────────────

  const [leaderboardData, setLeaderboardData] = useState<DirectoryItem[][]>([])
  const [leaderboardLoading, setLeaderboardLoading] = useState(true)

  useEffect(() => {
    async function fetchLeaderboards() {
      setLeaderboardLoading(true)
      try {
        const results = await Promise.all(
          config.leaderboards.map(async (lb) => {
            let query = supabase
              .from(config.table)
              .select(selectColumns)
              .eq('is_active', true)

            if (lb.orFilter) {
              query = query.or(lb.orFilter)
            } else {
              query = query.in('category', lb.categories || [])
            }

            const { data } = await query
              .order('avg_rating', { ascending: false, nullsFirst: false })
              .limit(10)
            return (data || []) as unknown as DirectoryItem[]
          }),
        )
        setLeaderboardData(results)
      } catch {
        // leaderboards are non-critical
      } finally {
        setLeaderboardLoading(false)
      }
    }
    fetchLeaderboards()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Category counts ──────────────────────────────────────────────────

  useEffect(() => {
    async function fetchCounts() {
      try {
        const { data } = await supabase
          .from(config.table)
          .select('category')
          .eq('is_active', true)
        if (!data) return
        const counts: Record<string, number> = { all: data.length }
        data.forEach(row => {
          const cat = row.category as string
          counts[cat] = (counts[cat] || 0) + 1
        })
        Object.entries(config.categoryGroups).forEach(([groupKey, cats]) => {
          counts[groupKey] = cats.reduce((sum, c) => sum + (counts[c] || 0), 0)
        })
        setCategoryCounts(counts)
      } catch {
        // counts are optional
      }
    }
    fetchCounts()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Main data fetch ──────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      let query = supabase
        .from(config.table)
        .select(selectColumns)
        .eq('is_active', true)

      if (category !== 'all') {
        const groupCats = config.categoryGroups[category]
        if (groupCats) {
          query = query.in('category', groupCats)
        } else {
          query = query.eq('category', category)
        }
      }

      const cleanSearch = sanitizeSearch(debouncedSearch)
      if (cleanSearch) {
        query = query.or(`name.ilike.%${cleanSearch}%,name_zh.ilike.%${cleanSearch}%`)
      }

      if (sort === 'rating') {
        query = query.order('avg_rating', { ascending: false, nullsFirst: false })
      } else if (sort === 'newest') {
        query = query.order('created_at', { ascending: false })
      } else if (sort === 'reviews') {
        query = query.order('rating_count', { ascending: false })
      }

      query = query.limit(100)

      const { data, error: queryError } = await query
      if (queryError) throw queryError
      setItems((data || []) as unknown as DirectoryItem[])
    } catch {
      setError(t('failedToLoadRetry'))
    } finally {
      setLoading(false)
    }
  }, [category, sort, debouncedSearch, t, config.table, config.categoryGroups, selectColumns])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ─── Helpers ───────────────────────────────────────────────────────────

  function itemToEntry(item: DirectoryItem): LeaderboardEntry {
    return {
      id: item.id,
      name: language === 'zh' ? (item.name_zh || item.name) : item.name,
      rating: item.avg_rating,
      logoUrl: item.logo_url,
      href: item.website || item.github_url,
    }
  }

  const leaderboardColumns: LeaderboardColumn[] = config.leaderboards.map((lb, i) => ({
    title: t(lb.title),
    icon: lb.icon,
    entries: (leaderboardData[i] || []).map(itemToEntry),
    loading: leaderboardLoading,
    emptyText: t('comingSoon'),
  }))

  const accentVar = config.header.accentVar || 'var(--color-brand)'
  const accentMutedVar = config.header.accentMutedVar || 'var(--color-brand-muted)'

  // Active filter label for result count
  const activeFilterLabel = category !== 'all' && categoryLabelMap[category]
    ? t(categoryLabelMap[category])
    : null

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }}>
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 100px' }}>

        {/* Top Leaderboards */}
        <TopLeaderboards columns={leaderboardColumns} />

        {/* Header */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            {config.header.icon && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 36, height: 36, borderRadius: tokens.radius.lg,
                background: accentMutedVar, border: `1px solid ${accentVar}`,
                color: accentVar, flexShrink: 0,
              }}>
                {config.header.icon}
              </span>
            )}
            <h1 style={{
              fontSize: tokens.typography.fontSize['3xl'], fontWeight: 800,
              margin: 0, letterSpacing: '-0.02em',
              ...(config.header.gradient ? {
                background: config.header.gradient,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              } : {
                color: 'var(--color-text-primary)',
              }),
            }}>
              {t(config.header.titleKey)}
            </h1>
          </div>
          <p style={{
            fontSize: tokens.typography.fontSize.base,
            color: 'var(--color-text-tertiary)',
            marginBottom: 24,
            lineHeight: tokens.typography.lineHeight.normal,
          }}>
            {t(config.header.subtitleKey)}
          </p>
        </div>

        {/* Filter bar — horizontally scrollable on mobile */}
        <style>{`
          .directory-filters { display: flex; gap: 8px; margin-bottom: 20px; align-items: center; }
          .directory-filter-scroll {
            display: flex; gap: 8px; flex: 1; min-width: 0;
            overflow-x: auto; -webkit-overflow-scrolling: touch;
            scrollbar-width: none; padding-bottom: 4px;
          }
          .directory-filter-scroll::-webkit-scrollbar { display: none; }
          @media (min-width: 768px) {
            .directory-filter-scroll { flex-wrap: wrap; overflow-x: visible; }
          }
          .directory-filter-chip {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 9px 18px; border-radius: 9999px;
            font-size: ${tokens.typography.fontSize.base};
            letter-spacing: 0.01em; cursor: pointer; white-space: nowrap;
            transition: all ${tokens.transition.base}; border: 1px solid var(--color-border-primary);
            background: var(--color-bg-secondary); color: var(--color-text-secondary); font-weight: 500;
          }
          .directory-filter-chip:hover:not(.active) {
            border-color: ${accentVar}; color: var(--color-text-primary);
            background: var(--color-bg-hover);
          }
          .directory-filter-chip.active {
            font-weight: 700; border-color: transparent;
            background: ${config.header.gradient || tokens.gradient.purpleGold};
            color: var(--color-on-accent, #fff);
            box-shadow: ${tokens.shadow.md};
          }
          .directory-search-input {
            width: 100%; padding: 10px 14px 10px 38px; border-radius: ${tokens.radius.xl};
            border: 1px solid var(--color-border-primary);
            background: var(--color-bg-secondary); color: var(--color-text-primary);
            font-size: ${tokens.typography.fontSize.base}; outline: none;
            transition: all ${tokens.transition.base};
          }
          .directory-search-input:focus {
            border-color: ${accentVar}; box-shadow: 0 0 0 3px ${accentMutedVar};
          }
          .directory-card {
            display: block; padding: 22px; border-radius: ${tokens.radius.xl};
            border: 1px solid var(--color-border-primary); background: var(--color-bg-secondary);
            text-decoration: none; transition: all ${tokens.transition.slow};
            box-shadow: ${tokens.shadow.xs};
            animation: directoryFadeIn 0.3s ease-out both;
          }
          .directory-card:hover {
            border-color: ${accentVar}; transform: translateY(-3px);
            box-shadow: ${tokens.shadow.cardHover};
          }
          @keyframes directoryFadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .directory-grid > *:nth-child(1) { animation-delay: 0s; }
          .directory-grid > *:nth-child(2) { animation-delay: 0.03s; }
          .directory-grid > *:nth-child(3) { animation-delay: 0.06s; }
          .directory-grid > *:nth-child(4) { animation-delay: 0.09s; }
          .directory-grid > *:nth-child(5) { animation-delay: 0.12s; }
          .directory-grid > *:nth-child(6) { animation-delay: 0.15s; }
          .directory-grid > *:nth-child(n+7) { animation-delay: 0.18s; }
          .directory-clear-btn {
            position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
            background: var(--color-bg-tertiary); border: none; border-radius: 50%;
            width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
            cursor: pointer; color: var(--color-text-tertiary);
            transition: all ${tokens.transition.fast};
          }
          .directory-clear-btn:hover {
            background: var(--color-bg-hover); color: var(--color-text-primary);
          }
          .directory-skeleton-card {
            border-radius: ${tokens.radius.xl}; padding: 22px;
            border: 1px solid var(--color-border-primary); background: var(--color-bg-secondary);
          }
        `}</style>

        <div className="directory-filters">
          <div className="directory-filter-scroll" ref={filterScrollRef}>
            {config.categoryFilters.map(f => {
              const active = category === f.key
              const count = categoryCounts[f.key]
              return (
                <button
                  key={f.key}
                  className={`directory-filter-chip${active ? ' active' : ''}`}
                  onClick={() => handleCategoryChange(f.key)}
                >
                  {t(f.labelKey)}
                  {count != null && count > 0 && (
                    <span style={{
                      fontSize: tokens.typography.fontSize.xs, fontWeight: 600,
                      padding: '1px 7px', borderRadius: tokens.radius.full,
                      background: active ? 'var(--glass-bg-heavy)' : 'var(--color-accent-primary-12)',
                      color: active ? 'var(--color-text-primary)' : accentVar,
                      lineHeight: '1.5', minWidth: 20, textAlign: 'center' as const,
                    }}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <select
            value={sort}
            onChange={e => handleSortChange(e.target.value)}
            aria-label={t('sortBy') || 'Sort by'}
            style={{
              padding: '9px 14px', borderRadius: tokens.radius.full,
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
              fontSize: tokens.typography.fontSize.sm, cursor: 'pointer', outline: 'none',
              flexShrink: 0, transition: `all ${tokens.transition.base}`,
            }}
          >
            {config.sortOptions.map(opt => (
              <option key={opt.key} value={opt.key}>{t(opt.labelKey)}</option>
            ))}
          </select>
        </div>

        {/* Search with clear button and "/" shortcut hint */}
        <div style={{ position: 'relative', maxWidth: 400, marginBottom: 16 }}>
          <div style={{
            position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--color-text-tertiary)', pointerEvents: 'none', display: 'flex', alignItems: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t(config.i18n.searchPlaceholder)}
            className="directory-search-input"
            aria-label={t(config.i18n.searchPlaceholder)}
            style={search ? { paddingRight: 36 } : undefined}
          />
          {search ? (
            <button
              className="directory-clear-btn"
              onClick={handleClearSearch}
              aria-label={t('clearSearch')}
              type="button"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ) : (
            <span style={{
              position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
              fontSize: 11, color: 'var(--color-text-quaternary, var(--color-text-tertiary))',
              border: '1px solid var(--color-border-primary)', borderRadius: 4,
              padding: '1px 6px', fontFamily: 'monospace', pointerEvents: 'none',
              opacity: 0.6,
            }}>
              /
            </span>
          )}
        </div>

        {/* Result count */}
        {!loading && !error && (
          <div style={{
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-tertiary)',
            marginBottom: 16,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>{items.length}</span>
            <span>{t('resultsCount')}</span>
            {activeFilterLabel && (
              <span style={{
                padding: '2px 10px', borderRadius: tokens.radius.full,
                background: 'var(--color-accent-primary-08)',
                fontSize: tokens.typography.fontSize.xs, fontWeight: 500,
              }}>
                {activeFilterLabel}
              </span>
            )}
            {debouncedSearch && (
              <span style={{
                padding: '2px 10px', borderRadius: tokens.radius.full,
                background: 'var(--color-accent-primary-08)',
                fontSize: tokens.typography.fontSize.xs, fontWeight: 500,
              }}>
                &ldquo;{debouncedSearch}&rdquo;
              </span>
            )}
          </div>
        )}

        {/* Content */}
        {error ? (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <p style={{ color: 'var(--color-accent-error)', fontSize: tokens.typography.fontSize.base, marginBottom: 16 }}>{error}</p>
            <button
              onClick={fetchData}
              style={{
                padding: '8px 20px', borderRadius: tokens.radius.full,
                background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-primary)', cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
              }}
            >
              {t('retry')}
            </button>
          </div>
        ) : loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="directory-skeleton-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                  <div className="skeleton" style={{ width: 44, height: 44, borderRadius: tokens.radius.xl, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton" style={{ height: 14, width: '60%', borderRadius: 6, marginBottom: 8 }} />
                    <div className="skeleton" style={{ height: 10, width: '35%', borderRadius: 4 }} />
                  </div>
                </div>
                <div className="skeleton" style={{ height: 12, width: '90%', borderRadius: 4, marginBottom: 6 }} />
                <div className="skeleton" style={{ height: 12, width: '70%', borderRadius: 4, marginBottom: 14 }} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <div className="skeleton" style={{ height: 22, width: 60, borderRadius: tokens.radius.full }} />
                  <div className="skeleton" style={{ height: 22, width: 48, borderRadius: tokens.radius.full }} />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 24px' }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px',
              background: 'var(--color-bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </div>
            <p style={{ color: 'var(--color-text-tertiary)', fontSize: tokens.typography.fontSize.base, marginBottom: 8 }}>
              {t(config.i18n.emptyText)}
            </p>
            {(debouncedSearch || category !== 'all') && (
              <button
                onClick={() => { setSearch(''); setDebouncedSearch(''); setCategory('all'); syncUrl('all', sort, '') }}
                style={{
                  padding: '8px 20px', borderRadius: tokens.radius.full,
                  background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
                  border: '1px solid var(--color-border-primary)', cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm, marginTop: 8,
                }}
              >
                {t('clearSearch')}
              </button>
            )}
          </div>
        ) : (
          <div className="directory-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 20 }}>
            {items.map(item => (
              <DirectoryCard
                key={item.id}
                item={item}
                language={language}
                categoryLabelMap={categoryLabelMap}
                pricingLabelKeys={config.pricingLabelKeys}
                noRatingsKey={config.i18n.noRatingsYet}
                accentVar={accentVar}
                accentMutedVar={accentMutedVar}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

// ─── Card (memoized) ─────────────────────────────────────────────────────────

const DirectoryCard = memo(function DirectoryCard({
  item, language, categoryLabelMap, pricingLabelKeys, noRatingsKey, accentVar, accentMutedVar,
}: {
  item: DirectoryItem
  language: string
  categoryLabelMap: Record<string, string>
  pricingLabelKeys?: Record<string, string>
  noRatingsKey?: string
  accentVar: string
  accentMutedVar: string
}) {
  const { t } = useLanguage()
  const name = language === 'zh' ? (item.name_zh || item.name) : item.name
  const desc = language === 'zh' ? (item.description_zh || item.description) : item.description
  const href = item.website || item.github_url || '#'
  const hasLink = !!(item.website || item.github_url)

  const pricingLabel = pricingLabelKeys && item.pricing
    ? (pricingLabelKeys[item.pricing] ? t(pricingLabelKeys[item.pricing]) : item.pricing)
    : null

  return (
    <a
      href={href}
      target={hasLink ? '_blank' : undefined}
      rel="noopener noreferrer"
      className="directory-card"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
        {item.logo_url ? (
          <img
            src={item.logo_url}
            alt={`${item.name} logo`}
            width={44} height={44}
            loading="lazy"
            style={{
              borderRadius: tokens.radius.xl, objectFit: 'cover', flexShrink: 0,
              border: '1px solid var(--color-border-primary)',
            }}
            onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div style={{
            width: 44, height: 44, borderRadius: tokens.radius.xl, flexShrink: 0,
            background: tokens.gradient.primarySubtle,
            border: '1px solid var(--color-border-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: tokens.typography.fontSize.md, fontWeight: 700, color: accentVar,
          }}>
            {name[0]}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: tokens.typography.fontSize.base, fontWeight: 700,
            color: 'var(--color-text-primary)', marginBottom: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {name}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: tokens.typography.fontSize.xs, color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
            <span>{categoryLabelMap[item.category] ? t(categoryLabelMap[item.category]) : item.category}</span>
            {pricingLabel && (
              <span style={{
                padding: '2px 8px', borderRadius: tokens.radius.full,
                background: item.pricing === 'free' || item.pricing === 'open_source'
                  ? 'var(--color-accent-success-12)'
                  : item.pricing === 'paid'
                    ? 'var(--color-accent-warning-12, rgba(255, 184, 0, 0.12))'
                    : 'var(--color-accent-primary-08)',
                color: item.pricing === 'free' || item.pricing === 'open_source'
                  ? 'var(--color-accent-success)'
                  : item.pricing === 'paid'
                    ? 'var(--color-accent-warning, #FFB800)'
                    : 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.xs, fontWeight: 600, lineHeight: '1.4',
              }}>
                {pricingLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      {desc && (
        <p style={{
          fontSize: tokens.typography.fontSize.sm, color: 'var(--color-text-secondary)',
          lineHeight: tokens.typography.lineHeight.normal, margin: '0 0 12px',
          overflow: 'hidden', textOverflow: 'ellipsis',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
        }}>
          {desc}
        </p>
      )}

      {item.tags && item.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {item.tags.slice(0, 3).map(tag => (
            <span key={tag} style={{
              fontSize: tokens.typography.fontSize.xs, padding: '3px 10px',
              borderRadius: tokens.radius.full, fontWeight: 500,
              background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)',
              border: '1px solid var(--color-border-primary)',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {item.avg_rating != null && item.avg_rating > 0 ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 10px', borderRadius: tokens.radius.lg,
          background: accentMutedVar, border: `1px solid ${accentVar}`,
          width: 'fit-content',
        }}>
          <StarRating rating={item.avg_rating} ratingCount={item.rating_count} size={14} readonly />
        </div>
      ) : noRatingsKey ? (
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
          {t(noRatingsKey)}
        </span>
      ) : null}
    </a>
  )
})
