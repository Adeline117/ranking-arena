'use client'

import React, { useState, useEffect, useRef, memo, useCallback, useMemo, useDeferredValue } from 'react'
import { useLoginModal } from '@/lib/hooks/useLoginModal'
import { useTableKeyboardNav } from '@/lib/hooks/useTableKeyboardNav'
import { tokens } from '@/lib/design-tokens'
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
  () => import('./ScoreBreakdownTooltip').then(m => ({ default: m.ScoreBreakdownTooltip })),
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
  LS_KEY_VIEW_MODE,
  LS_KEY_VIEW_MANUAL,
  getStoredViewMode,
  getStoredManualFlag,
  getStoredColumns,
} from './RankingTableTypes'

// Re-export for backward compatibility (many components import { Trader } from './RankingTable')
export type { Trader, ColumnKey, ViewMode }

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

// ExportRankingButton moved to RankingFilters.tsx

/** Infinite scroll sentinel — triggers onVisible when scrolled into view */
function CardLoadMoreSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onVisible() },
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
  onSortChange?: (column: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha', dir: 'asc' | 'desc') => void
  onPageChange?: (page: number) => void
  onSearchChange?: (query: string) => void
  /** Server-side total count for pagination (overrides client-side count) */
  serverTotalCount?: number
  /** Category counts from server for tab badges */
  categoryCounts?: { all: number; futures: number; spot: number; onchain: number }
}) {
  const { traders: tradersRaw, loading, source, timeRange = '90D', isPro = false, category = 'all', onCategoryChange, onProRequired, onFilterToggle, hasActiveFilters, error, onRetry,
    controlledSortColumn, controlledSortDir, controlledPage, controlledSearchQuery,
    onSortChange, onPageChange, onSearchChange, serverTotalCount, categoryCounts,
  } = props
  const { t, language } = useLanguage()

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
  const [internalSortColumn, setInternalSortColumn] = useState<'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha'>('score')
  const [internalSortDir, setInternalSortDir] = useState<'asc' | 'desc'>('desc')
  const [justSortedColumn, setJustSortedColumn] = useState<string | null>(null)
  const [_sortAnimationKey, setSortAnimationKey] = useState(0)
  const itemsPerPage = 50

  // Mobile card view: load more instead of pagination
  const [cardVisibleCount, setCardVisibleCount] = useState(50)

  const [internalSearchQuery, setInternalSearchQuery] = useState('')
  const searchQuery = controlledSearchQuery ?? internalSearchQuery
  const debouncedSearch = useDebounce(searchQuery, 300)

  const sortColumn = controlledSortColumn ?? internalSortColumn
  const sortDir = controlledSortDir ?? internalSortDir
  const currentPage = controlledPage ?? internalPage
  const setCurrentPage = useCallback((v: number | ((prev: number) => number)) => {
    const newVal = typeof v === 'function' ? v(controlledPage ?? internalPage) : v
    if (onPageChange) onPageChange(newVal)
    else setInternalPage(newVal)
  }, [onPageChange, controlledPage, internalPage])

  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_VISIBLE_COLUMNS)
  const [showColumnSettings, setShowColumnSettings] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  // Cache getStoredManualFlag() in a ref to avoid synchronous localStorage reads during render.
  // Previously called as a prop value in JSX (getStoredManualFlag()) on every render.
  const storedManualFlagRef = useRef<boolean>(false)

  // Trading style filter
  const [styleFilter, setStyleFilter] = useState<TradingStyle | 'all'>('all')
  // Trader type filter (human/bot/all)
  const [traderTypeFilter, setTraderTypeFilter] = useState<'all' | 'human' | 'bot'>('all')
  // Expanded row for score breakdown
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)

  useEffect(() => {
    setVisibleColumns(getStoredColumns())

    // Mobile auto-switch: respect manual choice, otherwise follow screen width
    // Read localStorage once on mount and cache in ref to avoid repeated sync reads
    const isManual = getStoredManualFlag()
    storedManualFlagRef.current = isManual
    if (isManual) {
      setViewMode(getStoredViewMode())
    } else {
      const isMobile = window.matchMedia('(max-width: 767px)').matches
      setViewMode(isMobile ? 'card' : 'table')
    }

    // Auto-switch on resize when user hasn't manually chosen
    const mql = window.matchMedia('(max-width: 767px)')
    const handleResize = (e: MediaQueryListEvent) => {
      if (!storedManualFlagRef.current) {
        setViewMode(e.matches ? 'card' : 'table')
      }
    }
    mql.addEventListener('change', handleResize)
    return () => mql.removeEventListener('change', handleResize)
  }, [])

  // Column settings click-outside is handled by RankingFilters

  const toggleViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    storedManualFlagRef.current = true
    try {
      localStorage.setItem(LS_KEY_VIEW_MODE, mode)
      localStorage.setItem(LS_KEY_VIEW_MANUAL, 'true')
    } catch { /* localStorage unavailable in SSR/private browsing */ }
  }

  const resetViewModeToAuto = () => {
    storedManualFlagRef.current = false
    try {
      localStorage.removeItem(LS_KEY_VIEW_MANUAL)
      localStorage.removeItem(LS_KEY_VIEW_MODE)
    } catch { /* localStorage unavailable in SSR/private browsing */ }
    // Re-apply auto logic based on current screen width
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    setViewMode(isMobile ? 'card' : 'table')
  }

  const toggleColumn = (col: ColumnKey) => {
    setVisibleColumns(prev => {
      const next = prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
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

  // Memoize grid CSS string to avoid injecting new style on every render
  const gridStyleCSS = React.useMemo(() => {
    const hiddenCols = [
      !visibleColumns.includes('score') && '.ranking-table-grid-custom .col-score { display: none !important; }',
      !visibleColumns.includes('winrate') && '.ranking-table-grid-custom .col-winrate { display: none !important; }',
      !visibleColumns.includes('mdd') && '.ranking-table-grid-custom .col-mdd { display: none !important; }',
      !visibleColumns.includes('roi') && '.ranking-table-grid-custom .roi-cell { display: none !important; }',
      !visibleColumns.includes('pnl') && '.ranking-table-grid-custom .col-pnl { display: none !important; }',
      !visibleColumns.includes('sharpe') && '.ranking-table-grid-custom .col-sharpe { display: none !important; }',
      !visibleColumns.includes('sortino') && '.ranking-table-grid-custom .col-sortino { display: none !important; }',
      !visibleColumns.includes('alpha') && '.ranking-table-grid-custom .col-alpha { display: none !important; }',
      !visibleColumns.includes('style') && '.ranking-table-grid-custom .col-style { display: none !important; }',
      !visibleColumns.includes('followers') && '.ranking-table-grid-custom .col-followers { display: none !important; }',
      !visibleColumns.includes('trades') && '.ranking-table-grid-custom .col-trades { display: none !important; }',
    ].filter(Boolean).join('\n        ')
    return `
      @media (min-width: 768px) {
        .ranking-table-grid-custom {
          grid-template-columns: ${desktopGridTemplate} !important;
        }
        ${hiddenCols}
      }
    `
  }, [visibleColumns, desktopGridTemplate])

  const handleSort = (col: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha') => {
    const newDir = sortColumn === col ? (sortDir === 'desc' ? 'asc' : 'desc') : 'desc'
    setJustSortedColumn(col)
    setSortAnimationKey(prev => prev + 1)
    setTimeout(() => setJustSortedColumn(null), 400)
    if (onSortChange) { onSortChange(col, newDir) }
    else { setInternalSortColumn(col); setInternalSortDir(newDir) }
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
    () => traders.some(t => t.trading_style && t.trading_style !== 'unknown'),
    [traders]
  )

  const sortedTraders = React.useMemo(() => {
    let data = [...traders]
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase()
      data = data.filter(t => {
        const handle = (t.handle || t.id || '').toLowerCase()
        const displayName = (t.display_name || '').toLowerCase()
        return handle.includes(q) || t.id.toLowerCase().includes(q) || displayName.includes(q)
      })
    }
    // Apply trader type filter (human/bot)
    if (traderTypeFilter !== 'all') {
      data = data.filter(t => {
        const isBot = t.is_bot || t.trader_type === 'bot' || t.source === 'web3_bot'
        return traderTypeFilter === 'bot' ? isBot : !isBot
      })
    }
    // Apply style filter
    if (styleFilter !== 'all') {
      data = data.filter(t => {
        const style = t.trading_style || classifyStyle({
          avg_holding_hours: t.avg_holding_hours,
          trades_count: t.trades_count,
          win_rate: t.win_rate,
        })
        return style === styleFilter
      })
    }
    return [...data].sort((a, b) => {
      // Use null to distinguish "no data" from actual 0 — nulls always sort last
      let aRaw: number | null = null, bRaw: number | null = null
      switch (sortColumn) {
        case 'score': aRaw = a.arena_score ?? null; bRaw = b.arena_score ?? null; break
        case 'roi': aRaw = a.roi ?? null; bRaw = b.roi ?? null; break
        case 'pnl': aRaw = a.pnl ?? null; bRaw = b.pnl ?? null; break
        case 'winrate': aRaw = a.win_rate ?? null; bRaw = b.win_rate ?? null; break
        case 'mdd': aRaw = a.max_drawdown != null ? Math.abs(Number(a.max_drawdown)) : null; bRaw = b.max_drawdown != null ? Math.abs(Number(b.max_drawdown)) : null; break
        case 'sortino': aRaw = a.sortino_ratio ?? null; bRaw = b.sortino_ratio ?? null; break
        case 'alpha': aRaw = a.alpha ?? null; bRaw = b.alpha ?? null; break
      }
      // Null always goes to the bottom regardless of sort direction
      if (aRaw === null && bRaw === null) return 0
      if (aRaw === null) return 1
      if (bRaw === null) return -1
      return sortDir === 'desc' ? bRaw - aRaw : aRaw - bRaw
    })
  }, [traders, sortColumn, sortDir, debouncedSearch, styleFilter, traderTypeFilter])


  // Server-side pagination: use serverTotalCount for total pages.
  // When serverTotalCount is available, traders array is already one page from the API.
  // Compute effective category count for correct pagination per tab.
  const effectiveTotalCount = serverTotalCount != null
    ? (category === 'all'
      ? (categoryCounts?.all ?? serverTotalCount)
      : category === 'futures'
        ? (categoryCounts?.futures ?? serverTotalCount)
        : category === 'spot'
          ? (categoryCounts?.spot ?? serverTotalCount)
          : category === 'web3'
            ? (categoryCounts?.onchain ?? serverTotalCount)
            : serverTotalCount)
    : null

  const totalPages = effectiveTotalCount != null
    ? Math.ceil(effectiveTotalCount / itemsPerPage)
    : Math.ceil(sortedTraders.length / itemsPerPage)
  const startIndex = serverTotalCount != null ? 0 : (currentPage - 1) * itemsPerPage
  const endIndex = serverTotalCount != null ? sortedTraders.length : startIndex + itemsPerPage
  const paginatedTraders = sortedTraders.slice(startIndex, endIndex)

  // Reset scroll position on page/sort/filter changes
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const resetKey = useMemo(() => `${currentPage}-${sortColumn}-${sortDir}-${debouncedSearch}-${styleFilter}-${traderTypeFilter}`, [currentPage, sortColumn, sortDir, debouncedSearch, styleFilter, traderTypeFilter])
  useEffect(() => {
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0
  }, [resetKey])

  // Wrap parseSourceInfo with translation function
  const parseSourceInfoWithT = useCallback((src: string) => parseSourceInfoUtil(src, t), [t])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedRowId(prev => prev === id ? null : id)
  }, [])

  const handlePaginationChange = useCallback((page: number) => {
    setCurrentPage(page)
  }, [setCurrentPage])

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
    {/* Preload top trader avatars for faster LCP */}
    <AvatarPreload
      avatarUrls={traders.slice(0, 10).map(t => t.avatar_url)}
      maxPreload={10}
    />
    {/* Dynamic grid template override — memoized to avoid style recalc on re-render */}
    <style>{gridStyleCSS}</style>
    <Box
      className="ranking-table-container"
      data-sort-col={sortColumn}
      p={0}
      radius="none"
      style={{
        boxShadow: `0 0 0 1px var(--glass-border-light)`,
        overflow: viewMode === 'card' ? 'visible' : 'hidden',
        background: 'var(--color-bg-secondary, #14121C)',
        border: tokens.glass.border.light,
      }}
    >
      {/* Category Tabs + Tool buttons (extracted to RankingFilters) */}
      {onCategoryChange && (
        <RankingFilters
          category={category}
          onCategoryChange={onCategoryChange}
          isPro={isPro}
          onProRequired={onProRequired}
          viewMode={viewMode}
          onToggleViewMode={toggleViewMode}
          onResetViewModeToAuto={resetViewModeToAuto}
          hasManualViewMode={storedManualFlagRef.current}
          onFilterToggle={onFilterToggle}
          hasActiveFilters={hasActiveFilters}
          visibleColumns={visibleColumns}
          showColumnSettings={showColumnSettings}
          onShowColumnSettings={setShowColumnSettings}
          onToggleColumn={toggleColumn}
          onResetColumns={resetColumns}
          styleFilter={styleFilter}
          onStyleFilterChange={(s) => { setStyleFilter(s); setCurrentPage(1); setCardVisibleCount(50) }}
          hasStyleData={hasStyleData}
          traderTypeFilter={traderTypeFilter}
          onTraderTypeFilterChange={(type) => { setTraderTypeFilter(type); setCurrentPage(1); setCardVisibleCount(50) }}
          traders={traders}
          source={source}
          timeRange={timeRange}
          categoryCounts={categoryCounts}
        />
      )}

      {/* Search removed - use top nav search instead */}
      {/* Inline style filter is rendered inside RankingFilters when onCategoryChange is provided */}

      {/* Table Header (only in table view) - sticky */}
      {viewMode === 'table' && (
      <Box className="ranking-table-header ranking-table-grid ranking-table-grid-custom"
        style={{ display: 'grid', gap: tokens.spacing[2], padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`, borderBottom: `1px solid var(--glass-border-light)`, background: 'var(--color-bg-secondary, #14121C)', borderRadius: onCategoryChange ? '0' : `${tokens.radius.xl} ${tokens.radius.xl} 0 0`, position: 'sticky', top: 56, zIndex: tokens.zIndex.sticky }}>
        <Text size="xs" weight="bold" color="tertiary" role="columnheader" aria-label={t('rank')} style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.8px', whiteSpace: 'nowrap', fontSize: tokens.typography.fontSize.xs }}>{t('rank')}</Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="xs" weight="bold" color="tertiary" role="columnheader" aria-label={t('trader')} style={{ textTransform: 'uppercase', letterSpacing: '0.8px', whiteSpace: 'nowrap', fontSize: tokens.typography.fontSize.xs }}>{t('trader')}</Text>
          <button onClick={() => setShowRules(!showRules)}
            className="info-btn-circle"
            title={t('rankingRules')}
            aria-label={t('rankingRules')}
            aria-expanded={showRules}
          >?</button>
        </Box>
        <Box className={`col-score sort-header sort-header-center${sortColumn === 'score' ? ' sort-header-active' : ''} ${justSortedColumn === 'score' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('score')} role="columnheader" aria-label={`${t('score')} — click to sort`} aria-sort={sortColumn === 'score' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
        >
          {t('score')}
          <span
            title={t('arenaScoreHeaderTooltip') || "Arena Score is a 0-100 composite metric combining ROI (60%) and PnL (40%), adjusted for confidence and platform trust. Higher = better risk-adjusted performance."}
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
            aria-label={t('arenaScoreHeaderTooltip') || "Arena Score is a 0-100 composite metric combining ROI (60%) and PnL (40%), adjusted for confidence and platform trust. Higher = better risk-adjusted performance."}
          >
            i
          </span>
          <SortIndicator active={sortColumn === 'score'} dir={sortDir} />
        </Box>
        <Box className={`roi-cell sort-header sort-header-end${sortColumn === 'roi' ? ' sort-header-active' : ''} ${justSortedColumn === 'roi' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('roi')} title={t('roiTooltip').replace('{range}', timeRange)} role="columnheader" aria-label={`${t('roi')} (${timeRange}) — click to sort`} aria-sort={sortColumn === 'roi' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
          {t('roi')} ({timeRange}) <SortIndicator active={sortColumn === 'roi'} dir={sortDir} />
        </Box>
        <Box className={`col-pnl sort-header sort-header-end${sortColumn === 'pnl' ? ' sort-header-active' : ''} ${justSortedColumn === 'pnl' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('pnl')} title={t('pnlTooltip') || 'Profit & Loss'} role="columnheader" aria-label={`${t('pnl')} — click to sort`} aria-sort={sortColumn === 'pnl' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
          {t('pnl')} <SortIndicator active={sortColumn === 'pnl'} dir={sortDir} />
        </Box>
        <Box className={`col-winrate sort-header sort-header-end${sortColumn === 'winrate' ? ' sort-header-active' : ''} ${justSortedColumn === 'winrate' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('winrate')} title={t('winRateTooltip') || 'Percentage of profitable trading days.'} role="columnheader" aria-label={`${t('winRateShort')} — click to sort`} aria-sort={sortColumn === 'winrate' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}
        >
          {t('winRateShort')}
          <InfoTooltip text={t('winRateTooltip') || 'Win Rate: Percentage of profitable trades.\nHigher = more consistent profits.'} />
          <SortIndicator active={sortColumn === 'winrate'} dir={sortDir} />
        </Box>
        <Box className={`col-mdd sort-header sort-header-end${sortColumn === 'mdd' ? ' sort-header-active' : ''} ${justSortedColumn === 'mdd' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('mdd')} title={t('mddTooltip') || 'Largest peak-to-trough decline. Lower is better.'} role="columnheader" aria-label={`${t('maxDrawdownShort')} — click to sort`} aria-sort={sortColumn === 'mdd' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}
        >
          {t('maxDrawdownShort')}
          <InfoTooltip text={t('mddTooltip') || 'Max Drawdown: Largest peak-to-trough decline.\nLower = better risk control.'} />
          <SortIndicator active={sortColumn === 'mdd'} dir={sortDir} />
        </Box>
        {visibleColumns.includes('sharpe') && (
          <Box className="col-sharpe sort-header sort-header-end" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Sharpe
            </Text>
            <InfoTooltip text={t('sharpeTooltip') || 'Sharpe Ratio: Risk-adjusted return per unit of risk.\n> 1 good, > 2 excellent, > 3 outstanding.'} />
          </Box>
        )}
        {visibleColumns.includes('sortino') && (
          <Box className={`col-sortino sort-header sort-header-end${sortColumn === 'sortino' ? ' sort-header-active' : ''} ${justSortedColumn === 'sortino' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('sortino')} title={t('sortinoTooltip') || 'Risk-adjusted return. Higher = better risk/reward.'} role="columnheader" aria-label={`${t('sortinoRatio')} — click to sort`} aria-sort={sortColumn === 'sortino' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}
          >
            {t('sortinoRatio')}
            <InfoTooltip text={t('sortinoTooltip') || 'Sortino: Like Sharpe but only penalizes downside risk.\nHigher = better risk-adjusted return.'} />
            <SortIndicator active={sortColumn === 'sortino'} dir={sortDir} />
          </Box>
        )}
        {visibleColumns.includes('alpha') && (
          <Box className={`col-alpha sort-header sort-header-end${sortColumn === 'alpha' ? ' sort-header-active' : ''} ${justSortedColumn === 'alpha' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('alpha')} title={t('alphaTooltip') || 'Alpha (excess return)'} role="columnheader" aria-label="Alpha — click to sort" aria-sort={sortColumn === 'alpha' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
            Alpha <SortIndicator active={sortColumn === 'alpha'} dir={sortDir} />
          </Box>
        )}
        {visibleColumns.includes('style') && (
          <Box className="col-style" style={{ textAlign: 'center' }}>
            <Text size="sm" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: tokens.typography.fontSize.sm }}>
              {t('tradingStyle') || 'Style'}
            </Text>
          </Box>
        )}
        {visibleColumns.includes('followers') && (
          <Box className="col-followers" style={{ textAlign: 'right' }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {t('followers') || 'Followers'}
            </Text>
          </Box>
        )}
        {visibleColumns.includes('trades') && (
          <Box className="col-trades" style={{ textAlign: 'right' }}>
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {t('trades') || 'Trades'}
            </Text>
          </Box>
        )}
      </Box>
      )}

      {/* Rules explanation */}
      {showRules && (
        <Box style={{ padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`, background: `${tokens.colors.accent.primary}10`, borderBottom: `1px solid ${tokens.colors.border.primary}`, fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary, lineHeight: 1.7 }}>
          <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary, marginBottom: 8, display: 'block' }}>
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
          <button onClick={() => setShowScoreRulesModal(true)}
            className="detail-btn">
            {t('detailButton')}
          </button>
        </Box>
      )}

      <ScoreRulesModal isOpen={showScoreRulesModal} onClose={() => setShowScoreRulesModal(false)} />

      <Box style={{ minHeight: 400, contain: 'layout style' }}>
      {loading && sortedTraders.length === 0 ? (
        <Box style={{ animation: 'fadeIn 0.2s ease-in' }}><RankingSkeleton /></Box>
      ) : error && sortedTraders.length === 0 ? (
        <Box style={{ padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Text size="md" color="secondary">{error}</Text>
          {onRetry && (
            <button onClick={onRetry}
              className="retry-btn"
              style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`, background: `${tokens.colors.accent.primary}20`, border: `1px solid ${tokens.colors.accent.primary}40`, borderRadius: tokens.radius.md, color: tokens.colors.accent.primary, cursor: 'pointer', fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.bold, transition: `all ${tokens.transition.base}` }}>
              {t('retry')}
            </button>
          )}
        </Box>
      ) : sortedTraders.length === 0 ? (
        <EmptyState
          icon={
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
          }
          title={debouncedSearch.trim() || hasActiveFilters
            ? t('rankingNoMatchCriteria')
            : t('noTraderData')}
          description={(debouncedSearch.trim() || hasActiveFilters) ? t('rankingBroadenFilters') : undefined}
          action={(debouncedSearch.trim() || hasActiveFilters) ? {
            label: t('clearSearch'),
            onClick: () => {
              if (debouncedSearch.trim()) {
                if (onSearchChange) onSearchChange('')
                else setInternalSearchQuery('')
              }
            },
          } : undefined}
        />
      ) : viewMode === 'card' ? (
        <>
          <Box
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: tokens.spacing[3], padding: tokens.spacing[4],
            }}
          >
            {sortedTraders.slice(0, cardVisibleCount).map((trader, idx) => {
              const positionRank = idx + 1
              const rank = positionRank
              return (
                <SectionErrorBoundary key={`${trader.id}-${trader.source || 'unknown'}`}>
                  <TraderCard
                    trader={trader} rank={rank} source={source} language={language}
                    searchQuery={debouncedSearch}
                    getMedalGlowClass={getMedalGlowClass} parseSourceInfo={parseSourceInfoWithT} />
                </SectionErrorBoundary>
              )
            })}
          </Box>
          {cardVisibleCount < sortedTraders.length && (
            <>
              {/* Auto-load more via IntersectionObserver */}
              <CardLoadMoreSentinel onVisible={() => setCardVisibleCount(prev => Math.min(prev + 20, sortedTraders.length))} />
              <Box style={{ display: 'flex', justifyContent: 'center', padding: tokens.spacing[4] }}>
                <button
                  onClick={() => setCardVisibleCount(prev => Math.min(prev + 20, sortedTraders.length))}
                  style={{
                    padding: `${tokens.spacing[2]} ${tokens.spacing[6]}`,
                    borderRadius: tokens.radius.md,
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                    color: tokens.colors.accent.primary,
                    background: `${tokens.colors.accent.primary}10`,
                    border: `1px solid ${tokens.colors.accent.primary}30`,
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
          {cardVisibleCount >= sortedTraders.length && sortedTraders.length > 20 && (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[4], opacity: 0.5 }}>
              <Text size="xs" color="tertiary">{t('endOfList') || `All ${sortedTraders.length} traders shown`}</Text>
            </Box>
          )}
        </>
      ) : (
        <>
          <Box
            className="content-appear ranking-table-rows"
            style={{
              display: 'flex', flexDirection: 'column', gap: 0, position: 'relative', contain: 'layout style paint',
              outline: 'none',
            }}
            {...kbContainerProps}
          >
            {paginatedTraders.map((trader, idx) => {
              const positionRank = startIndex + idx + 1
              const rank = positionRank
              return (
                <div key={`${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`} {...kbGetRowProps(idx)}>
                  <SectionErrorBoundary>
                    <TraderRow
                      trader={trader} rank={rank} source={source} language={language}
                      searchQuery={debouncedSearch}
                      getMedalGlowClass={getMedalGlowClass} parseSourceInfo={parseSourceInfoWithT} getPnLTooltipFn={getPnLTooltip}
                      isExpanded={expandedRowId === trader.id}
                      onToggleExpand={handleToggleExpand} />
                  </SectionErrorBoundary>
                </div>
              )
            })}
          </Box>
          {/* Registration CTA after first page for non-logged-in users */}
          {!props.loggedIn && currentPage === 1 && sortedTraders.length > itemsPerPage && (
            <button onClick={() => useLoginModal.getState()?.openLoginModal?.()} style={{ border: 'none', cursor: 'pointer', background: 'none', width: '100%', padding: 0 }}>
              <Box style={{
                margin: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`,
                background: `linear-gradient(135deg, ${tokens.colors.accent.primary}18, ${tokens.colors.accent.brand}12)`,
                border: `1px solid ${tokens.colors.accent.primary}40`,
                borderRadius: tokens.radius.lg,
                textAlign: 'center',
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[1],
              }}>
                <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                  {t('rankingSignUpFree')}
                </Text>
                <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                  {t('rankingShowingTop').replace('{count}', String(itemsPerPage)).replace('{total}', String(sortedTraders.length))}
                </Text>
              </Box>
            </button>
          )}
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={handlePaginationChange} />
        </>
      )}
      </Box>
    </Box>
    </>
  )
}

const RankingTable = memo(RankingTableInner)
export { RankingTable }
export default RankingTable
