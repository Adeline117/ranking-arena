'use client'

import React, {
  useState,
  useEffect,
  useRef,
  memo,
  useCallback,
  useMemo,
  useDeferredValue,
} from 'react'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { getCsrfHeaders } from '@/lib/api/csrf'
import { useTableKeyboardNav } from '@/lib/hooks/useTableKeyboardNav'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { RankingSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import dynamic from 'next/dynamic'
import { DynamicScoreRulesModal as ScoreRulesModal } from '../ui/Dynamic'
import InfoTooltip from '../ui/InfoTooltip'
import { CategoryType } from './CategoryRankingTabs'

// Lazy-load non-LCP components to reduce initial bundle
const Pagination = dynamic(() => import('../ui/Pagination'), { ssr: false })
const _ScoreBreakdownTooltip = dynamic(
  () => import('./ScoreBreakdownTooltip').then((m) => ({ default: m.ScoreBreakdownTooltip })),
  { ssr: false }
)

// Extracted components — keep TraderRow/TraderCard static (LCP-critical)
import { TraderRow } from './TraderRow'
import { TraderCard } from './TraderCard'
import { AvatarPreload } from '../ui/AvatarPreload'
import { SortIndicator } from './Icons'
import { getPnLTooltip, parseSourceInfo as parseSourceInfoUtil, getMedalGlowClass } from './utils'
import { classifyStyle, type TradingStyle } from '@/lib/utils/trading-style'
import { SectionErrorBoundary } from '../utils/ErrorBoundary'

// CSS animations loaded async to avoid render-blocking (medal glow, hover effects, pagination)
// Critical layout styles (grid, responsive columns) are already in critical-css.ts and responsive.css
// This deferred load saves ~5KB from the render-blocking CSS path
import { useRankingTableStyles } from './useRankingTableStyles'
import { RankingFilters } from './RankingFilters'

// Import consolidated types from RankingTableTypes (single source of truth for UI Trader type)
import {
  type Trader,
  type ColumnKey,
  type ViewMode,
  DEFAULT_VISIBLE_COLUMNS,
  LS_KEY_COLUMNS,
  getStoredColumns,
} from './RankingTableTypes'

// Re-export for backward compatibility (many components import { Trader } from './RankingTable')
export type { Trader, ColumnKey, ViewMode }

// Row density (1.4) — shared with RankingFilters' density toggle.
export type RankingDensity = 'compact' | 'comfortable'
const LS_KEY_DENSITY = 'arena.ranking.density'

import { useDebounce } from '@/lib/hooks/useDebounce'

// ExportRankingButton moved to RankingFilters.tsx

/** Infinite scroll sentinel — triggers onVisible when scrolled into view */
function CardLoadMoreSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onVisible()
      },
      { rootMargin: '200px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [onVisible])
  return <div ref={ref} style={{ height: 1 }} aria-hidden />
}

/**
 * 排行榜页面 - 核心功能，突出前三名
 */
function RankingTableInner(props: {
  traders: Trader[]
  loading: boolean
  /** Background refresh (period switch / poll) with rows still on screen — dims the table instead of replacing it. */
  isRefreshing?: boolean
  loggedIn: boolean
  source?: string
  timeRange?: '7D' | '30D' | '90D' | 'COMPOSITE'
  isPro?: boolean
  category?: CategoryType
  onCategoryChange?: (category: CategoryType) => void
  onProRequired?: () => void
  onFilterToggle?: () => void
  hasActiveFilters?: boolean
  error?: string | null
  onRetry?: () => void
  controlledSortColumn?: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha'
  controlledSortDir?: 'asc' | 'desc'
  controlledPage?: number
  controlledSearchQuery?: string
  onSortChange?: (
    column: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha',
    dir: 'asc' | 'desc'
  ) => void
  onPageChange?: (page: number) => void
  onSearchChange?: (query: string) => void
  /** Server-side total count for pagination (overrides client-side count) */
  serverTotalCount?: number
  /** Category counts from server for tab badges */
  categoryCounts?: { all: number; futures: number; spot: number; onchain: number }
}) {
  const {
    traders: tradersRaw,
    loading,
    isRefreshing = false,
    source,
    timeRange = '90D',
    isPro = false,
    category = 'all',
    onCategoryChange,
    onProRequired,
    onFilterToggle: _onFilterToggle,
    hasActiveFilters,
    error,
    onRetry,
    controlledSortColumn,
    controlledSortDir,
    controlledPage,
    controlledSearchQuery,
    onSortChange,
    onPageChange,
    onSearchChange,
    serverTotalCount,
    categoryCounts,
  } = props
  const { t, language } = useLanguage()

  // Real per-row rank-trajectory sparklines (audit 1.3). rank_history is keyed by
  // 7D/30D/90D, so map the COMPOSITE view onto its dominant 90D window.
  const seriesPeriod = timeRange === 'COMPOSITE' ? '90D' : timeRange
  // Map of `${period}:${platform}:${traderKey}` → ranks (oldest→newest). Period
  // is part of the key so a timeframe switch can never surface stale ranks.
  const [rankSeries, setRankSeries] = useState<Record<string, number[]>>({})
  // Keys already requested (success keeps them; abort/failure releases for retry).
  const requestedSeriesKeysRef = useRef<Set<string>>(new Set())

  // useDeferredValue allows React to interrupt the expensive 50-row render during hydration.
  // During loading state, show immediate (empty/skeleton) data.
  // When traders arrive, React renders the deferred value in a lower-priority pass,
  // keeping the main thread free for higher-priority interactions (TBT reduction).
  const traders = useDeferredValue(tradersRaw)

  // Load ranking-table.css asynchronously (animations, hover effects)
  useRankingTableStyles()

  const [internalPage, setInternalPage] = useState(1)
  const [showRules, setShowRules] = useState(false)
  const [showScoreRulesModal, setShowScoreRulesModal] = useState(false)
  const [internalSortColumn, setInternalSortColumn] = useState<
    'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha'
  >('score')
  const [internalSortDir, setInternalSortDir] = useState<'asc' | 'desc'>('desc')
  const [justSortedColumn, setJustSortedColumn] = useState<string | null>(null)
  const [_sortAnimationKey, setSortAnimationKey] = useState(0)
  const sortTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const itemsPerPage = 50

  // Mobile card view: load more instead of pagination
  // Cap at 200 to prevent unbounded DOM accumulation on mobile
  const MAX_CARD_COUNT = 200
  const [cardVisibleCount, setCardVisibleCount] = useState(50)

  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const searchQuery = controlledSearchQuery ?? internalSearchQuery
  const debouncedSearch = useDebounce(searchQuery, 300)

  const sortColumn = controlledSortColumn ?? internalSortColumn
  const sortDir = controlledSortDir ?? internalSortDir
  const currentPage = controlledPage ?? internalPage
  const setCurrentPage = useCallback(
    (v: number | ((prev: number) => number)) => {
      const newVal = typeof v === 'function' ? v(controlledPage ?? internalPage) : v
      if (onPageChange) onPageChange(newVal)
      else setInternalPage(newVal)
    },
    [onPageChange, controlledPage, internalPage]
  )

  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_VISIBLE_COLUMNS)
  const [showColumnSettings, setShowColumnSettings] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('table')

  // Row density (1.4) — comfortable (default) / compact. Persisted to
  // localStorage like the column-visibility settings; drives data-density on the
  // container so CSS can tighten row min-height + padding.
  const [density, setDensity] = useState<RankingDensity>('comfortable')
  const handleDensityChange = useCallback((d: RankingDensity) => {
    setDensity(d)
    try {
      localStorage.setItem(LS_KEY_DENSITY, d)
    } catch {
      /* localStorage unavailable (private mode) — non-fatal, density still applies for the session */
    }
  }, [])

  // Trading style filter
  const [styleFilter, setStyleFilter] = useState<TradingStyle | 'all'>('all')
  // Score grade filter
  const [scoreGradeFilter, setScoreGradeFilter] = useState<'all' | 'S' | 'A' | 'B' | 'C' | 'D'>(
    'all'
  )
  // Trader type filter (human/bot/all)
  const [traderTypeFilter, setTraderTypeFilter] = useState<'all' | 'human' | 'bot'>('all')
  // Filter panel open state
  const [filterOpen, setFilterOpen] = useState(false)
  // Expanded row for score breakdown
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)

  useEffect(() => {
    setVisibleColumns(getStoredColumns())

    // Restore persisted row density (1.4)
    try {
      const storedDensity = localStorage.getItem(LS_KEY_DENSITY)
      if (storedDensity === 'compact' || storedDensity === 'comfortable') {
        setDensity(storedDensity)
      }
    } catch {
      /* localStorage unavailable — keep default 'comfortable' */
    }

    // Auto-detect: mobile → card, desktop → table
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    setViewMode(isMobile ? 'card' : 'table')

    const mql = window.matchMedia('(max-width: 767px)')
    const handleResize = (e: MediaQueryListEvent) => {
      setViewMode(e.matches ? 'card' : 'table')
    }
    mql.addEventListener('change', handleResize)
    return () => mql.removeEventListener('change', handleResize)
  }, [])

  // Cleanup sort highlight timeout on unmount
  useEffect(() => {
    return () => {
      clearTimeout(sortTimeoutRef.current)
    }
  }, [])

  const toggleColumn = (col: ColumnKey) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]
      if (next.length === 0) return prev
      localStorage.setItem(LS_KEY_COLUMNS, JSON.stringify(next))
      return next
    })
  }

  const resetColumns = () => {
    setVisibleColumns(DEFAULT_VISIBLE_COLUMNS)
    localStorage.setItem(LS_KEY_COLUMNS, JSON.stringify(DEFAULT_VISIBLE_COLUMNS))
  }

  const desktopGridTemplate = React.useMemo(() => {
    let template = '40px minmax(140px, 1.5fr)'
    if (visibleColumns.includes('score')) template += ' 58px'
    if (visibleColumns.includes('roi')) template += ' 96px'
    if (visibleColumns.includes('pnl')) template += ' 80px'
    if (visibleColumns.includes('winrate')) template += ' 64px'
    if (visibleColumns.includes('mdd')) template += ' 64px'
    if (visibleColumns.includes('sharpe')) template += ' 64px'
    if (visibleColumns.includes('sortino')) template += ' 70px'
    if (visibleColumns.includes('alpha')) template += ' 70px'
    if (visibleColumns.includes('style')) template += ' 80px'
    if (visibleColumns.includes('followers')) template += ' 70px'
    if (visibleColumns.includes('trades')) template += ' 70px'
    return template
  }, [visibleColumns])

  // Min-width for the desktop grid = sum of every column at its template size
  // (name column at its 140px floor) + gaps + horizontal padding. Drives the
  // horizontal-scroll threshold: the grid only overflows (and the frozen columns
  // engage) once the viewport is narrower than this. On wider screens the 1.5fr
  // name column absorbs the slack and min-width has no effect — layout unchanged.
  // Uses the row's larger gap (12px) / padding (40px) so the box fully covers its
  // background + bottom border even in the overflow region.
  const desktopGridMinWidth = React.useMemo(() => {
    const widths: number[] = [40, 140] // rank, name (floor)
    if (visibleColumns.includes('score')) widths.push(58)
    if (visibleColumns.includes('roi')) widths.push(96)
    if (visibleColumns.includes('pnl')) widths.push(80)
    if (visibleColumns.includes('winrate')) widths.push(64)
    if (visibleColumns.includes('mdd')) widths.push(64)
    if (visibleColumns.includes('sharpe')) widths.push(64)
    if (visibleColumns.includes('sortino')) widths.push(70)
    if (visibleColumns.includes('alpha')) widths.push(70)
    if (visibleColumns.includes('style')) widths.push(80)
    if (visibleColumns.includes('followers')) widths.push(70)
    if (visibleColumns.includes('trades')) widths.push(70)
    const cols = widths.reduce((a, b) => a + b, 0)
    const gaps = (widths.length - 1) * 12 // row gap = tokens.spacing[3]
    const padding = 40 // row horizontal padding = 2 × tokens.spacing[5]
    return cols + gaps + padding
  }, [visibleColumns])

  // Grid template + hidden-column flags are driven by a CSS variable and
  // data-attributes on the .ranking-table-container element (see globals.css).
  // Previously this was a runtime <style>{...}</style> element that React
  // reconciled on every render, causing StyleSheet recalc on column toggles.
  const hiddenColAttrs = React.useMemo(() => {
    const attrs: Record<string, '' | undefined> = {}
    const cols = [
      'score',
      'winrate',
      'mdd',
      'roi',
      'pnl',
      'sharpe',
      'sortino',
      'alpha',
      'style',
      'followers',
      'trades',
    ] as const
    for (const col of cols) {
      if (!visibleColumns.includes(col)) attrs[`data-hide-${col}`] = ''
    }
    return attrs
  }, [visibleColumns])

  const handleSort = (col: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha') => {
    const newDir = sortColumn === col ? (sortDir === 'desc' ? 'asc' : 'desc') : 'desc'
    setJustSortedColumn(col)
    setSortAnimationKey((prev) => prev + 1)
    clearTimeout(sortTimeoutRef.current)
    sortTimeoutRef.current = setTimeout(() => setJustSortedColumn(null), 400)
    if (onSortChange) {
      onSortChange(col, newDir)
    } else {
      setInternalSortColumn(col)
      setInternalSortDir(newDir)
    }
    setCurrentPage(1)
    setCardVisibleCount(50)
  }

  const _handleSearchInput = (value: string) => {
    if (onSearchChange) onSearchChange(value)
    else setInternalSearchQuery(value)
    setCurrentPage(1)
    setCardVisibleCount(50)
  }

  const hasStyleData = React.useMemo(
    () => traders.some((t) => t.trading_style && t.trading_style !== 'unknown'),
    [traders]
  )

  // Fingerprint of traders[] content — used to short-circuit sortedTraders
  // useMemo when autorefresh creates a new array reference with identical
  // content. Without this, every 5-min polling refresh triggers a full sort
  // + filter pass + downstream re-render cascade even when nothing changed.
  const tradersFingerprint = React.useMemo(
    () =>
      traders.map((t) => `${t.id}:${t.arena_score ?? ''}:${t.roi ?? ''}:${t.pnl ?? ''}`).join('|'),
    [traders]
  )
  const prevSortedRef = React.useRef<{ fp: string; key: string; data: Trader[] } | null>(null)

  const sortedTraders = React.useMemo(() => {
    // Cache key includes all the factors that affect the output. If same as
    // last computation AND content fingerprint unchanged, reuse the cached
    // reference (identity stable → downstream components can bail out of
    // re-render via React.memo / reference equality).
    const key = `${sortColumn}|${sortDir}|${debouncedSearch}|${styleFilter}|${scoreGradeFilter}|${traderTypeFilter}`
    if (
      prevSortedRef.current &&
      prevSortedRef.current.fp === tradersFingerprint &&
      prevSortedRef.current.key === key
    ) {
      return prevSortedRef.current.data
    }
    let data = [...traders]
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase()
      data = data.filter((t) => {
        const handle = (t.handle || t.id || '').toLowerCase()
        const displayName = (t.display_name || '').toLowerCase()
        return handle.includes(q) || t.id.toLowerCase().includes(q) || displayName.includes(q)
      })
    }
    // Apply trader type filter (human/bot)
    if (traderTypeFilter !== 'all') {
      data = data.filter((t) => {
        const isBot =
          t.is_bot ||
          t.trader_type === 'bot' ||
          t.trader_type === 'suspected_bot' ||
          t.source === 'web3_bot'
        return traderTypeFilter === 'bot' ? isBot : !isBot
      })
    }
    // Apply style filter
    if (styleFilter !== 'all') {
      data = data.filter((t) => {
        const style =
          t.trading_style ||
          classifyStyle({
            avg_holding_hours: t.avg_holding_hours,
            trades_count: t.trades_count,
            win_rate: t.win_rate,
          })
        return style === styleFilter
      })
    }
    // Apply score grade filter
    if (scoreGradeFilter !== 'all') {
      data = data.filter((t) => {
        const s = t.arena_score ?? 0
        switch (scoreGradeFilter) {
          case 'S':
            return s >= 90
          case 'A':
            return s >= 70 && s < 90
          case 'B':
            return s >= 50 && s < 70
          case 'C':
            return s >= 30 && s < 50
          case 'D':
            return s < 30
          default:
            return true
        }
      })
    }
    const sorted = [...data].sort((a, b) => {
      // Use null to distinguish "no data" from actual 0 — nulls always sort last
      let aRaw: number | null = null,
        bRaw: number | null = null
      switch (sortColumn) {
        case 'score':
          aRaw = a.arena_score ?? null
          bRaw = b.arena_score ?? null
          break
        case 'roi':
          aRaw = a.roi ?? null
          bRaw = b.roi ?? null
          break
        case 'pnl':
          aRaw = a.pnl ?? null
          bRaw = b.pnl ?? null
          break
        case 'winrate':
          aRaw = a.win_rate ?? null
          bRaw = b.win_rate ?? null
          break
        case 'mdd':
          aRaw = a.max_drawdown != null ? Math.abs(Number(a.max_drawdown)) : null
          bRaw = b.max_drawdown != null ? Math.abs(Number(b.max_drawdown)) : null
          break
        case 'sortino':
          aRaw = a.sortino_ratio ?? null
          bRaw = b.sortino_ratio ?? null
          break
        case 'alpha':
          aRaw = a.alpha ?? null
          bRaw = b.alpha ?? null
          break
      }
      // Null always goes to the bottom regardless of sort direction
      if (aRaw === null && bRaw === null) return 0
      if (aRaw === null) return 1
      if (bRaw === null) return -1
      return sortDir === 'desc' ? bRaw - aRaw : aRaw - bRaw
    })
    prevSortedRef.current = { fp: tradersFingerprint, key, data: sorted }
    return sorted
  }, [
    traders,
    sortColumn,
    sortDir,
    debouncedSearch,
    styleFilter,
    scoreGradeFilter,
    traderTypeFilter,
    tradersFingerprint,
  ])

  // Batch-fetch real rank-trajectory series for the visible cards (audit 1.3).
  // Card view only — the desktop TraderRow has no sparkline. Fully non-blocking:
  // ONE POST per page of keys, results stream into rankSeries as they arrive, and
  // any failure leaves the static ROI-bar fallback untouched (no first-paint /
  // poll regression). Never N+1.
  useEffect(() => {
    if (viewMode !== 'card') return
    const visible = sortedTraders.slice(0, cardVisibleCount)
    const release = (keys: string[]) => {
      for (const k of keys) requestedSeriesKeysRef.current.delete(k)
    }
    const toFetch: { platform: string; trader_key: string }[] = []
    for (const tr of visible) {
      const platform = tr.source || source || ''
      if (!platform || !tr.id) continue
      const cacheKey = `${seriesPeriod}:${platform}:${tr.id}`
      if (requestedSeriesKeysRef.current.has(cacheKey)) continue
      requestedSeriesKeysRef.current.add(cacheKey)
      toFetch.push({ platform, trader_key: tr.id })
    }
    if (toFetch.length === 0) return

    const controller = new AbortController()
    ;(async () => {
      for (let i = 0; i < toFetch.length; i += 60) {
        const chunk = toFetch.slice(i, i + 60)
        const chunkKeys = chunk.map((c) => `${seriesPeriod}:${c.platform}:${c.trader_key}`)
        try {
          const res = await fetch('/api/rankings/rank-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
            body: JSON.stringify({ traders: chunk, period: seriesPeriod, days: 7 }),
            signal: controller.signal,
          })
          if (!res.ok) {
            release(chunkKeys)
            continue
          }
          const map = (await res.json()) as Record<string, number[]>
          if (controller.signal.aborted) {
            release(chunkKeys)
            return
          }
          // Re-key under the active period before merging into state.
          const prefixed: Record<string, number[]> = {}
          for (const [k, v] of Object.entries(map)) prefixed[`${seriesPeriod}:${k}`] = v
          if (Object.keys(prefixed).length > 0) {
            setRankSeries((prev) => ({ ...prev, ...prefixed }))
          }
        } catch {
          // Network error / abort — release so a later render can retry.
          release(chunkKeys)
          if (controller.signal.aborted) return
        }
      }
    })()
    return () => controller.abort()
  }, [viewMode, sortedTraders, cardVisibleCount, source, seriesPeriod])

  // Server-side pagination: use serverTotalCount for total pages.
  // When serverTotalCount is available, traders array is already one page from the API.
  // Compute effective category count for correct pagination per tab.
  const effectiveTotalCount =
    serverTotalCount != null
      ? category === 'all'
        ? (categoryCounts?.all ?? serverTotalCount)
        : category === 'futures'
          ? (categoryCounts?.futures ?? serverTotalCount)
          : category === 'spot'
            ? (categoryCounts?.spot ?? serverTotalCount)
            : category === 'web3'
              ? (categoryCounts?.onchain ?? serverTotalCount)
              : serverTotalCount
      : null

  const totalPages =
    effectiveTotalCount != null
      ? Math.ceil(effectiveTotalCount / itemsPerPage)
      : Math.ceil(sortedTraders.length / itemsPerPage)
  const startIndex = serverTotalCount != null ? 0 : (currentPage - 1) * itemsPerPage
  const endIndex = serverTotalCount != null ? sortedTraders.length : startIndex + itemsPerPage
  const paginatedTraders = sortedTraders.slice(startIndex, endIndex)
  // Rank offset: in server-side pagination, traders array is already one page,
  // but rank display must account for which page we're on.
  const rankOffset = serverTotalCount != null ? (currentPage - 1) * itemsPerPage : startIndex

  // Reset scroll position on page/sort/filter changes
  const tableScrollRef = useRef<HTMLDivElement>(null)
  // Horizontal-scroll wrapper (desktop table view). When the grid is wider than
  // the viewport it scrolls horizontally with the rank + name columns frozen.
  // We flip data-hscroll only while it actually overflows so wide screens (where
  // everything fits) keep the exact current layout — no sticky cells, no scrollbar.
  const hScrollRef = useRef<HTMLDivElement>(null)
  // Sticky column header (table view). It lives OUTSIDE the h-scroll wrapper so
  // its position:sticky pins against the viewport; the scroll-sync effect below
  // keeps it column-aligned with the horizontally-scrolled rows.
  const headerRef = useRef<HTMLDivElement>(null)
  const resetKey = useMemo(
    () =>
      `${currentPage}-${sortColumn}-${sortDir}-${debouncedSearch}-${styleFilter}-${scoreGradeFilter}-${traderTypeFilter}`,
    [
      currentPage,
      sortColumn,
      sortDir,
      debouncedSearch,
      styleFilter,
      scoreGradeFilter,
      traderTypeFilter,
    ]
  )
  useEffect(() => {
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0
  }, [resetKey])

  // Detect horizontal overflow on the desktop table wrapper and toggle
  // data-hscroll (mirrored onto the header, which sits outside the wrapper).
  // The frozen-column CSS (sticky cells + backgrounds + divider shadow) is
  // gated entirely on data-hscroll="true", so on wide screens where the grid
  // fits there is zero visual/layout change. Re-measures on viewport resize
  // (ResizeObserver) and whenever column visibility / density / row count
  // changes the intrinsic grid width.
  //
  // Header scroll-sync: the sticky header is NOT inside the scroll wrapper
  // (any overflow other than visible/clip would make the wrapper its sticky
  // scrollport and stop it pinning to the viewport — see render comment), so
  // while the rows are h-scrolled we mirror scrollLeft onto the header via
  // translateX, and counter-translate its two frozen cells (rank + name) so
  // they stay put exactly like the rows' sticky-left cells.
  useEffect(() => {
    const el = hScrollRef.current
    if (!el) return
    if (viewMode !== 'table') {
      el.removeAttribute('data-hscroll')
      return
    }
    // Same gate as the frozen-column CSS block in ranking-table.css: coarse
    // pointers / mobile keep the plain synced-header behavior (no frozen cells).
    const frozenColsMq = window.matchMedia(
      '(min-width: 768px) and (hover: hover) and (pointer: fine)'
    )
    const syncHeader = () => {
      const header = headerRef.current
      if (!header) return
      const x = el.scrollLeft
      header.style.transform = x ? `translate3d(${-x}px, 0, 0)` : ''
      const counter = x && frozenColsMq.matches ? `translate3d(${x}px, 0, 0)` : ''
      for (const cell of [header.children[0], header.children[1]]) {
        if (cell instanceof HTMLElement) cell.style.transform = counter
      }
    }
    const measure = () => {
      // The rows are per-row clipped until data-hscroll unclips them, so the
      // wrapper's own scrollWidth cannot bootstrap the flag. The header carries
      // the grid's min-width unclipped (it sits outside the wrapper, in the
      // overflow:clip container), so ITS width is the overflow signal:
      // header wider than the wrapper's scrollport = the grid doesn't fit.
      const header = headerRef.current
      const gridWidth = header ? header.offsetWidth : el.scrollWidth
      const overflowing = gridWidth > el.clientWidth + 1 ? 'true' : 'false'
      el.dataset.hscroll = overflowing
      if (header) header.dataset.hscroll = overflowing
      syncHeader()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (headerRef.current) ro.observe(headerRef.current)
    el.addEventListener('scroll', syncHeader, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', syncHeader)
    }
  }, [viewMode, visibleColumns, density, paginatedTraders.length])

  // Wrap parseSourceInfo with translation function
  const parseSourceInfoWithT = useCallback((src: string) => parseSourceInfoUtil(src, t), [t])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedRowId((prev) => (prev === id ? null : id))
  }, [])

  const handlePaginationChange = useCallback(
    (page: number) => {
      setCurrentPage(page)
    },
    [setCurrentPage]
  )

  // Stable callbacks for filter changes (avoids inline arrows that defeat React.memo)
  const handleStyleFilterChange = useCallback(
    (s: TradingStyle | 'all') => {
      setStyleFilter(s)
      setCurrentPage(1)
      setCardVisibleCount(50)
    },
    [setCurrentPage]
  )

  const handleTraderTypeFilterChange = useCallback(
    (type: 'all' | 'human' | 'bot') => {
      setTraderTypeFilter(type)
      setCurrentPage(1)
      setCardVisibleCount(50)
    },
    [setCurrentPage]
  )

  const handleScoreGradeFilterChange = useCallback(
    (grade: 'all' | 'S' | 'A' | 'B' | 'C' | 'D') => {
      setScoreGradeFilter(grade)
      setCurrentPage(1)
      setCardVisibleCount(50)
    },
    [setCurrentPage]
  )

  const handleFilterToggle = useCallback(() => {
    setFilterOpen((prev) => !prev)
  }, [])

  const hasActiveFiltersComputed =
    styleFilter !== 'all' || scoreGradeFilter !== 'all' || traderTypeFilter !== 'all'

  // Keyboard navigation for table rows (Arrow Up/Down, Enter, Home/End, Escape)
  const getRowHref = useCallback(
    (index: number) => {
      const trader = paginatedTraders[index]
      if (!trader) return ''
      return `/trader/${encodeURIComponent(trader.id)}${trader.source ? `?platform=${encodeURIComponent(trader.source)}` : ''}`
    },
    [paginatedTraders]
  )
  const { containerProps: kbContainerProps, getRowProps: kbGetRowProps } = useTableKeyboardNav({
    rowCount: paginatedTraders.length,
    getRowHref,
    enabled: viewMode === 'table' && !loading && paginatedTraders.length > 0,
  })

  return (
    <>
      {/* Preload top-3 trader avatars for faster LCP. Card view on mobile
        only shows top-3 medals above the fold, and table view uses
        loading="lazy" on rows 4+. Previously preloaded 10 which opened
        10 HTTP connections + wasted ~50-200KB on slow networks during
        the LCP window. */}
      <AvatarPreload avatarUrls={traders.slice(0, 3).map((t) => t.avatar_url)} maxPreload={3} />
      <Box
        className="ranking-table-container"
        data-sort-col={sortColumn}
        data-density={density}
        {...hiddenColAttrs}
        role="table"
        aria-label={t('rankingTable')}
        p={0}
        radius="none"
        style={{
          boxShadow: `0 0 0 1px var(--glass-border-light)`,
          // 'clip' (NOT 'hidden'): clips identically but does not create a
          // scroll container, so the header's position:sticky keeps the
          // viewport as its scrollport and pins under the nav. 'hidden' makes
          // this Box the sticky scrollport and the header never pins.
          overflow: viewMode === 'card' ? 'visible' : 'clip',
          background: 'var(--color-bg-secondary, #14121C)',
          border: tokens.glass.border.light,
          // Dynamic grid template via CSS variable — no <style> element needed.
          ['--ranking-grid-cols' as string]: desktopGridTemplate,
          // Horizontal-scroll threshold for the frozen-column layout (desktop).
          ['--ranking-grid-min' as string]: `${desktopGridMinWidth}px`,
        }}
      >
        {/* Category Tabs + Tool buttons (extracted to RankingFilters) */}
        {onCategoryChange && (
          <RankingFilters
            category={category}
            onCategoryChange={onCategoryChange}
            isPro={isPro}
            onProRequired={onProRequired}
            filterOpen={filterOpen}
            onFilterToggle={handleFilterToggle}
            hasActiveFilters={hasActiveFiltersComputed}
            visibleColumns={visibleColumns}
            showColumnSettings={showColumnSettings}
            onShowColumnSettings={setShowColumnSettings}
            onToggleColumn={toggleColumn}
            onResetColumns={resetColumns}
            styleFilter={styleFilter}
            onStyleFilterChange={handleStyleFilterChange}
            hasStyleData={hasStyleData}
            scoreGradeFilter={scoreGradeFilter}
            onScoreGradeFilterChange={handleScoreGradeFilterChange}
            traderTypeFilter={traderTypeFilter}
            onTraderTypeFilterChange={handleTraderTypeFilterChange}
            traders={traders}
            source={source}
            timeRange={timeRange}
            categoryCounts={categoryCounts}
            density={density}
            onDensityChange={handleDensityChange}
          />
        )}

        {/* Table Header (only in table view) — sticky. It deliberately lives
            OUTSIDE the .ranking-hscroll wrapper below: any overflow value other
            than visible/clip turns that wrapper into a scroll container, which
            would make position:sticky resolve against the wrapper's scrollport
            instead of the viewport — the header then stops pinning under the
            nav and instead gets pushed 56px down over the #1 row. Out here its
            nearest scrollport is the viewport again (the container uses
            overflow:clip, not hidden, for the same reason). Column alignment
            with the h-scrolled rows is maintained by the scroll-sync effect
            (translateX = -scrollLeft; frozen rank/name cells counter-translated). */}
        {viewMode === 'table' && (
          <Box
            ref={headerRef}
            className="ranking-table-header ranking-table-grid ranking-table-grid-custom"
            role="row"
            style={{
              display: 'grid',
              gap: tokens.spacing[2],
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid var(--glass-border-light)`,
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              background: 'var(--color-bg-secondary, #14121C)',
              borderRadius: onCategoryChange ? '0' : `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
              position: 'sticky',
              top: 56,
              zIndex: tokens.zIndex.sticky,
            }}
          >
            <Text
              size="xs"
              weight="bold"
              color="tertiary"
              role="columnheader"
              aria-label={t('rank')}
              style={{
                textAlign: 'center',
                textTransform: 'uppercase',
                letterSpacing: '0.8px',
                whiteSpace: 'nowrap',
                fontSize: tokens.typography.fontSize.xs,
              }}
            >
              {t('rank')}
            </Text>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
              <Text
                size="xs"
                weight="bold"
                color="tertiary"
                role="columnheader"
                aria-label={t('trader')}
                style={{
                  textTransform: 'uppercase',
                  letterSpacing: '0.8px',
                  whiteSpace: 'nowrap',
                  fontSize: tokens.typography.fontSize.xs,
                }}
              >
                {t('trader')}
              </Text>
              <button
                onClick={() => setShowRules(!showRules)}
                className="info-btn-circle"
                title={t('rankingRules')}
                aria-label={t('rankingRules')}
                aria-expanded={showRules}
              >
                ?
              </button>
            </Box>
            <Box
              className={`col-score sort-header sort-header-center${sortColumn === 'score' ? ' sort-header-active' : ''} ${justSortedColumn === 'score' ? 'just-sorted' : ''}`}
              as="button"
              onClick={() => handleSort('score')}
              role="columnheader"
              aria-label={`${t('score')} — ${t('clickToSort')}`}
              aria-sort={
                sortColumn === 'score' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
              }
              data-sortable
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
            >
              {t('score')}
              <span
                title={t('arenaScoreHeaderTooltip')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 13,
                  height: 13,
                  borderRadius: '50%',
                  border: `1px solid var(--color-text-tertiary)`,
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'var(--color-text-tertiary)',
                  lineHeight: 1,
                  cursor: 'help',
                  flexShrink: 0,
                  opacity: 0.65,
                  fontStyle: 'normal',
                }}
                aria-label={t('arenaScoreHeaderTooltip')}
              >
                i
              </span>
              <SortIndicator active={sortColumn === 'score'} dir={sortDir} />
            </Box>
            <Box
              className={`roi-cell sort-header sort-header-end${sortColumn === 'roi' ? ' sort-header-active' : ''} ${justSortedColumn === 'roi' ? 'just-sorted' : ''}`}
              as="button"
              onClick={() => handleSort('roi')}
              title={t('roiTooltip').replace('{range}', timeRange)}
              role="columnheader"
              aria-label={`${t('roi')} (${timeRange}) — ${t('clickToSort')}`}
              aria-sort={
                sortColumn === 'roi' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
              }
              data-sortable
            >
              {t('roi')} ({timeRange}) <SortIndicator active={sortColumn === 'roi'} dir={sortDir} />
            </Box>
            <Box
              className={`col-pnl sort-header sort-header-end${sortColumn === 'pnl' ? ' sort-header-active' : ''} ${justSortedColumn === 'pnl' ? 'just-sorted' : ''}`}
              as="button"
              onClick={() => handleSort('pnl')}
              title={t('pnlTooltip')}
              role="columnheader"
              aria-label={`${t('pnl')} — ${t('clickToSort')}`}
              aria-sort={
                sortColumn === 'pnl' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
              }
              data-sortable
            >
              {t('pnl')} <SortIndicator active={sortColumn === 'pnl'} dir={sortDir} />
            </Box>
            <Box
              className={`col-winrate sort-header sort-header-end${sortColumn === 'winrate' ? ' sort-header-active' : ''} ${justSortedColumn === 'winrate' ? 'just-sorted' : ''}`}
              as="button"
              onClick={() => handleSort('winrate')}
              title={t('winRateTooltip')}
              role="columnheader"
              aria-label={`${t('winRateShort')} — ${t('clickToSort')}`}
              aria-sort={
                sortColumn === 'winrate' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
              }
              data-sortable
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 2,
              }}
            >
              {t('winRateShort')}
              <InfoTooltip text={t('winRateTooltip')} />
              <SortIndicator active={sortColumn === 'winrate'} dir={sortDir} />
            </Box>
            <Box
              className={`col-mdd sort-header sort-header-end${sortColumn === 'mdd' ? ' sort-header-active' : ''} ${justSortedColumn === 'mdd' ? 'just-sorted' : ''}`}
              as="button"
              onClick={() => handleSort('mdd')}
              title={t('mddTooltip')}
              role="columnheader"
              aria-label={`${t('maxDrawdownShort')} — ${t('clickToSort')}`}
              aria-sort={
                sortColumn === 'mdd' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
              }
              data-sortable
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 2,
              }}
            >
              {t('maxDrawdownShort')}
              <InfoTooltip text={t('mddTooltip')} />
              <SortIndicator active={sortColumn === 'mdd'} dir={sortDir} />
            </Box>
            {visibleColumns.includes('sharpe') && (
              <Box
                className="col-sharpe sort-header sort-header-end"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 2,
                }}
              >
                <Text
                  size="xs"
                  weight="bold"
                  color="tertiary"
                  style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}
                >
                  Sharpe
                </Text>
                <InfoTooltip text={t('sharpeTooltip')} />
              </Box>
            )}
            {visibleColumns.includes('sortino') && (
              <Box
                className={`col-sortino sort-header sort-header-end${sortColumn === 'sortino' ? ' sort-header-active' : ''} ${justSortedColumn === 'sortino' ? 'just-sorted' : ''}`}
                as="button"
                onClick={() => handleSort('sortino')}
                title={t('sortinoTooltip')}
                role="columnheader"
                aria-label={`${t('sortinoRatio')} — ${t('clickToSort')}`}
                aria-sort={
                  sortColumn === 'sortino'
                    ? sortDir === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
                data-sortable
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 2,
                }}
              >
                {t('sortinoRatio')}
                <InfoTooltip text={t('sortinoTooltip')} />
                <SortIndicator active={sortColumn === 'sortino'} dir={sortDir} />
              </Box>
            )}
            {visibleColumns.includes('alpha') && (
              <Box
                className={`col-alpha sort-header sort-header-end${sortColumn === 'alpha' ? ' sort-header-active' : ''} ${justSortedColumn === 'alpha' ? 'just-sorted' : ''}`}
                as="button"
                onClick={() => handleSort('alpha')}
                title={t('alphaTooltip')}
                role="columnheader"
                aria-label={`${t('alpha')} — ${t('clickToSort')}`}
                aria-sort={
                  sortColumn === 'alpha' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                }
                data-sortable
              >
                Alpha <SortIndicator active={sortColumn === 'alpha'} dir={sortDir} />
              </Box>
            )}
            {visibleColumns.includes('style') && (
              <Box className="col-style" style={{ textAlign: 'center' }}>
                <Text
                  size="sm"
                  weight="bold"
                  color="tertiary"
                  style={{
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  {t('tradingStyle')}
                </Text>
              </Box>
            )}
            {visibleColumns.includes('followers') && (
              <Box className="col-followers" style={{ textAlign: 'right' }}>
                <Text
                  size="xs"
                  weight="bold"
                  color="tertiary"
                  style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}
                >
                  {t('followers')}
                </Text>
              </Box>
            )}
            {visibleColumns.includes('trades') && (
              <Box className="col-trades" style={{ textAlign: 'right' }}>
                <Text
                  size="xs"
                  weight="bold"
                  color="tertiary"
                  style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}
                >
                  {t('trades')}
                </Text>
              </Box>
            )}
          </Box>
        )}

        {/* Horizontal-scroll wrapper — the rows' single scroll container.
            overflow-x:auto only engages when the grid is wider than the
            viewport (narrow window / many columns); on wide screens the grid
            expands to fit and nothing scrolls. The sticky header sits OUTSIDE
            (see comment above) and mirrors this wrapper's scrollLeft via the
            scroll-sync effect. In card view it is inert. */}
        <div
          ref={hScrollRef}
          className="ranking-hscroll"
          role="presentation"
          style={{
            overflowX: viewMode === 'table' ? 'auto' : 'visible',
            overflowY: viewMode === 'table' ? 'hidden' : 'visible',
          }}
        >
          {/* Rules explanation */}
          {showRules && (
            <Box
              style={{
                padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                background: alpha(tokens.colors.accent.primary, 6),
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
                fontSize: tokens.typography.fontSize.sm,
                color: tokens.colors.text.secondary,
                lineHeight: 1.7,
              }}
            >
              <Text
                size="sm"
                weight="bold"
                style={{ color: tokens.colors.accent.primary, marginBottom: 8, display: 'block' }}
              >
                {t('arenaScoreRankingRules')}
              </Text>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span>{t('rankingRule1')}</span>
                <span>{t('rankingRule2')}</span>
                <span>{t('rankingRule3')}</span>
                <span style={{ color: tokens.colors.text.tertiary, marginTop: 6 }}>
                  {t('rankingRuleROINote')}
                </span>
              </div>
              <button onClick={() => setShowScoreRulesModal(true)} className="detail-btn">
                {t('detailButton')}
              </button>
            </Box>
          )}

          <ScoreRulesModal
            isOpen={showScoreRulesModal}
            onClose={() => setShowScoreRulesModal(false)}
          />

          <Box
            style={{
              minHeight: 400,
              contain: 'layout style',
              position: 'relative',
              // Background refresh: keep rows visible, dim instead of overlay/skeleton.
              // Rows stay readable but non-interactive until fresh data lands.
              opacity: isRefreshing ? 0.55 : 1,
              transition: 'opacity 150ms ease',
              pointerEvents: isRefreshing ? 'none' : undefined,
            }}
          >
            {(loading || isRefreshing) && sortedTraders.length === 0 ? (
              // Show a skeleton whenever the body would otherwise be blank during
              // a load OR a filter/time-range refetch that cleared the rows —
              // previously isRefreshing with no rows left a ~400px empty band that
              // read as "the filter did nothing / ugly whitespace".
              <Box style={{ animation: 'fadeIn 0.2s ease-in' }}>
                <RankingSkeleton />
              </Box>
            ) : error && sortedTraders.length === 0 ? (
              <Box
                style={{
                  padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`,
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: tokens.spacing[3],
                }}
              >
                <Text size="md" color="secondary">
                  {error}
                </Text>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    className="retry-btn"
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                      background: alpha(tokens.colors.accent.primary, 13),
                      border: `1px solid ${alpha(tokens.colors.accent.primary, 25)}`,
                      borderRadius: tokens.radius.md,
                      color: tokens.colors.accent.primary,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                      fontWeight: tokens.typography.fontWeight.bold,
                      transition: `all ${tokens.transition.base}`,
                    }}
                  >
                    {t('retry')}
                  </button>
                )}
              </Box>
            ) : sortedTraders.length === 0 ? (
              <EmptyState
                icon={
                  <svg
                    width="28"
                    height="28"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
                  </svg>
                }
                title={
                  debouncedSearch.trim() || hasActiveFilters
                    ? t('rankingNoMatchCriteria')
                    : t('noTraderData')
                }
                description={
                  debouncedSearch.trim() || hasActiveFilters
                    ? t('rankingBroadenFilters')
                    : undefined
                }
                action={
                  debouncedSearch.trim() || hasActiveFilters
                    ? {
                        label: t('clearSearch'),
                        onClick: () => {
                          if (debouncedSearch.trim()) {
                            if (onSearchChange) onSearchChange('')
                            else setInternalSearchQuery('')
                          }
                        },
                      }
                    : // Unfiltered + empty = soft fetch failure → offer a real retry
                      // instead of the "try refreshing" copy asking the user to reload.
                      onRetry
                      ? { label: t('retry'), onClick: onRetry }
                      : undefined
                }
              />
            ) : viewMode === 'card' ? (
              <>
                <Box
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
                    gap: tokens.spacing[3],
                    padding: tokens.spacing[4],
                  }}
                >
                  {sortedTraders.slice(0, cardVisibleCount).map((trader, idx) => {
                    const positionRank = rankOffset + idx + 1
                    const rank = positionRank
                    const series =
                      rankSeries[`${seriesPeriod}:${trader.source || source || ''}:${trader.id}`]
                    return (
                      <SectionErrorBoundary key={`${trader.id}-${trader.source || 'unknown'}`}>
                        <TraderCard
                          trader={trader}
                          rank={rank}
                          source={source}
                          language={language}
                          searchQuery={debouncedSearch}
                          getMedalGlowClass={getMedalGlowClass}
                          parseSourceInfo={parseSourceInfoWithT}
                          series={series}
                        />
                      </SectionErrorBoundary>
                    )
                  })}
                </Box>
                {cardVisibleCount < sortedTraders.length && cardVisibleCount < MAX_CARD_COUNT && (
                  <>
                    {/* Auto-load more via IntersectionObserver */}
                    <CardLoadMoreSentinel
                      onVisible={() =>
                        setCardVisibleCount((prev) =>
                          Math.min(prev + 20, MAX_CARD_COUNT, sortedTraders.length)
                        )
                      }
                    />
                    <Box
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        padding: tokens.spacing[4],
                      }}
                    >
                      <button
                        onClick={() =>
                          setCardVisibleCount((prev) =>
                            Math.min(prev + 20, MAX_CARD_COUNT, sortedTraders.length)
                          )
                        }
                        style={{
                          padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
                          borderRadius: tokens.radius.md,
                          fontSize: tokens.typography.fontSize.sm,
                          fontWeight: tokens.typography.fontWeight.semibold,
                          color: tokens.colors.accent.primary,
                          background: `${colorAlpha(tokens.colors.accent.primary, 6)}`,
                          border: `1px solid ${colorAlpha(tokens.colors.accent.primary, 19)}`,
                          cursor: 'pointer',
                          transition: `all ${tokens.transition.fast}`,
                          width: '100%',
                          maxWidth: 320,
                        }}
                      >
                        {t('loadMore')} ({cardVisibleCount}/{sortedTraders.length})
                      </button>
                    </Box>
                  </>
                )}
                {cardVisibleCount >= MAX_CARD_COUNT && sortedTraders.length > MAX_CARD_COUNT && (
                  <Box style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                    <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[2] }}>
                      {t('showingTopN')?.replace('{n}', String(MAX_CARD_COUNT)) ||
                        `Showing top ${MAX_CARD_COUNT}.`}
                    </Text>
                    <button
                      onClick={() => setViewMode('table')}
                      style={{
                        padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                        borderRadius: tokens.radius.md,
                        fontSize: tokens.typography.fontSize.sm,
                        fontWeight: tokens.typography.fontWeight.bold,
                        color: tokens.colors.accent.primary,
                        background: `${colorAlpha(tokens.colors.accent.primary, 8)}`,
                        border: `1px solid ${colorAlpha(tokens.colors.accent.primary, 25)}`,
                        cursor: 'pointer',
                        transition: `all ${tokens.transition.fast}`,
                      }}
                    >
                      {t('switchToTableView')}
                    </button>
                  </Box>
                )}
                {cardVisibleCount >= sortedTraders.length &&
                  sortedTraders.length > 20 &&
                  sortedTraders.length <= MAX_CARD_COUNT && (
                    <Box style={{ textAlign: 'center', padding: tokens.spacing[4], opacity: 0.5 }}>
                      <Text size="xs" color="tertiary">
                        {t('endOfList')}
                      </Text>
                    </Box>
                  )}
              </>
            ) : (
              <>
                <Box
                  className="content-appear ranking-table-rows"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0,
                    position: 'relative',
                    // 'layout style' (not 'paint'): paint-containment clips overflow,
                    // which would prevent a wide grid from scrolling horizontally
                    // inside .ranking-hscroll. Vertical clipping is still handled by
                    // the wrapper (overflow-y:hidden) and the container.
                    contain: 'layout style',
                    outline: 'none',
                  }}
                  {...kbContainerProps}
                >
                  {paginatedTraders.map((trader, idx) => {
                    const positionRank = rankOffset + idx + 1
                    const rank = positionRank
                    return (
                      <div
                        key={`${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`}
                        {...kbGetRowProps(idx)}
                      >
                        <SectionErrorBoundary>
                          <TraderRow
                            trader={trader}
                            rank={rank}
                            source={source}
                            language={language}
                            searchQuery={debouncedSearch}
                            getMedalGlowClass={getMedalGlowClass}
                            parseSourceInfo={parseSourceInfoWithT}
                            getPnLTooltipFn={getPnLTooltip}
                            isExpanded={expandedRowId === trader.id}
                            onToggleExpand={handleToggleExpand}
                          />
                        </SectionErrorBoundary>
                      </div>
                    )
                  })}
                </Box>
                {/* Registration CTA after first page for non-logged-in users */}
                {!props.loggedIn &&
                  currentPage === 1 &&
                  (serverTotalCount != null
                    ? serverTotalCount > itemsPerPage
                    : sortedTraders.length > itemsPerPage) && (
                    <button
                      onClick={() => useLoginModal.getState()?.openLoginModal?.()}
                      style={{
                        border: 'none',
                        cursor: 'pointer',
                        background: 'none',
                        width: '100%',
                        padding: 0,
                        // Stay put when the table is scrolled horizontally.
                        position: 'sticky',
                        left: 0,
                      }}
                    >
                      <Box
                        style={{
                          margin: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                          padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                          background: `${colorAlpha(tokens.colors.accent.brand, 8)}`,
                          border: `1px solid ${colorAlpha(tokens.colors.accent.primary, 25)}`,
                          borderRadius: tokens.radius.lg,
                          textAlign: 'center',
                          cursor: 'pointer',
                          transition: `all ${tokens.transition.base}`,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: tokens.spacing[1],
                        }}
                      >
                        <Text
                          size="sm"
                          weight="bold"
                          style={{ color: tokens.colors.accent.primary }}
                        >
                          {t('rankingSignUpFree')}
                        </Text>
                        <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                          {t('rankingShowingTop')
                            .replace('{count}', String(itemsPerPage))
                            .replace('{total}', String(sortedTraders.length))}
                        </Text>
                      </Box>
                    </button>
                  )}
                {/* Sticky-left so pagination stays centered in the viewport while
                  the table body is scrolled horizontally. */}
                <div style={{ position: 'sticky', left: 0 }}>
                  <Pagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={handlePaginationChange}
                  />
                </div>
              </>
            )}
          </Box>
        </div>
      </Box>
    </>
  )
}

const RankingTable = memo(RankingTableInner)
export { RankingTable }
export default RankingTable
