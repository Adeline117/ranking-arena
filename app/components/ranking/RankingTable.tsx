'use client'

import React, { useState, useEffect, useRef, memo, useCallback, useTransition } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../ui/Skeleton'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import dynamic from 'next/dynamic'
import { DynamicScoreRulesModal as ScoreRulesModal } from '../ui/Dynamic'
import CategoryRankingTabs, { CategoryType } from './CategoryRankingTabs'
import { ProLabel } from '../premium/PremiumGate'

// Lazy-load non-LCP components to reduce initial bundle
const Pagination = dynamic(() => import('../ui/Pagination'), { ssr: false })
const _ScoreBreakdownTooltip = dynamic(
  () => import('./ScoreBreakdownTooltip').then(m => ({ default: m.ScoreBreakdownTooltip })),
  { ssr: false }
)
const RankingSearch = dynamic(() => import('./RankingSearch'), { ssr: false })

// Extracted components — keep TraderRow/TraderCard static (LCP-critical)
import { TraderRow } from './TraderRow'
import { TraderCard } from './TraderCard'
import { AvatarPreload } from '../ui/AvatarPreload'
import {
  FilterIcon, CompareIcon, SortIndicator, LockIconSmall,
  TableViewIcon, CardViewIcon, SettingsIcon,
} from './Icons'
import { getPnLTooltip, parseSourceInfo as parseSourceInfoUtil, getMedalGlowClass } from './utils'

// CSS animations loaded async to avoid render-blocking (medal glow, hover effects, pagination)
// Critical layout styles (grid, responsive columns) are already in critical-css.ts and responsive.css
// This deferred load saves ~5KB from the render-blocking CSS path
import { useRankingTableStyles } from './useRankingTableStyles'

// Column customization types
export type ColumnKey = 'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha' | 'style'

// sortino, alpha, style removed — no data in DB yet
const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'winrate', 'mdd']
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'winrate', 'mdd']
const COLUMN_LABELS: Record<ColumnKey, { zh: string; en: string }> = {
  score: { zh: 'Arena Score', en: 'Arena Score' },
  roi: { zh: 'ROI', en: 'ROI' },
  winrate: { zh: '胜率', en: 'Win Rate' },
  mdd: { zh: '最大回撤', en: 'Max Drawdown' },
  sortino: { zh: 'Sortino', en: 'Sortino' },
  alpha: { zh: 'Alpha', en: 'Alpha' },
  style: { zh: '交易风格', en: 'Style' },
}
const LS_KEY_COLUMNS = 'ranking-visible-columns'
const LS_KEY_VIEW_MODE = 'ranking-view-mode'
const LS_KEY_VIEW_MANUAL = 'ranking-view-manual'

// View mode type
export type ViewMode = 'table' | 'card'

function getStoredViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'table'
  try {
    const stored = localStorage.getItem(LS_KEY_VIEW_MODE)
    if (stored === 'table' || stored === 'card') return stored
  } catch { /* ignore */ }
  return 'table'
}

function getStoredManualFlag(): boolean {
  if (typeof window === 'undefined') return false
  try { return localStorage.getItem(LS_KEY_VIEW_MANUAL) === 'true' } catch { return false }
}

function getStoredColumns(): ColumnKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLUMNS
  try {
    const stored = localStorage.getItem(LS_KEY_COLUMNS)
    if (stored) {
      const parsed = JSON.parse(stored) as ColumnKey[]
      if (Array.isArray(parsed) && parsed.every(c => ALL_TOGGLEABLE_COLUMNS.includes(c))) {
        return parsed
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_VISIBLE_COLUMNS
}

export interface Trader {
  id: string
  handle: string | null
  roi: number
  pnl?: number | null
  win_rate?: number | null
  max_drawdown?: number | null
  trades_count?: number | null
  followers: number
  source?: string
  avatar_url?: string | null
  arena_score?: number
  return_score?: number
  pnl_score?: number
  drawdown_score?: number
  stability_score?: number
  score_confidence?: 'full' | 'partial' | 'minimal' | null
  rank_change?: number | null
  is_new?: boolean
  also_on?: string[]
  // V3 Advanced Metrics
  sortino_ratio?: number | null
  calmar_ratio?: number | null
  alpha?: number | null
  arena_score_v3?: number | null
  trading_style?: 'hft' | 'day_trader' | 'swing' | 'trend' | 'scalping' | null
  style_confidence?: number | null
}

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * Export Ranking button with range selector (Top 10/50/100)
 */
function ExportRankingButton({ traders, source, timeRange, language }: {
  traders: Trader[]
  source?: string
  timeRange?: string
  language: string
}) {
  const [showMenu, setShowMenu] = useState(false)
  const isZh = language === 'zh'
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    if (showMenu) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  const doExport = (count: number) => {
    setShowMenu(false)
    const slice = traders.slice(0, count)
    const headers = ['rank', 'id', 'source', 'arena_score', 'roi', 'pnl', 'win_rate', 'max_drawdown', 'followers']
    const rows = slice.map((t, i) => [
      i + 1, t.handle || t.id, t.source || '', t.arena_score ?? '', t.roi, t.pnl ?? '',
      t.win_rate ?? '', t.max_drawdown ?? '', t.followers,
    ])
    const csv = [headers.join(','), ...rows.map(r => r.map(v => {
      if (v == null) return ''
      const s = String(v)
      return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `ranking-${source || 'all'}-top${count}-${timeRange || '90D'}.csv`
    link.click()
  }

  const options = [10, 50, 100].filter(n => n <= traders.length || n === 10)

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        aria-expanded={showMenu}
        aria-haspopup="true"
        aria-label={isZh ? '导出排名' : 'Export Ranking'}
        style={{
          padding: '6px 12px', borderRadius: 6,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.secondary,
          color: tokens.colors.text.primary,
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}
      >
        {isZh ? '导出排名' : 'Export Ranking'}
      </button>
      {showMenu && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: 8, overflow: 'hidden', zIndex: 100, minWidth: 120,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {options.map(n => (
            <button
              key={n}
              onClick={() => doExport(n)}
              style={{
                display: 'block', width: '100%', padding: '8px 16px',
                background: 'transparent', border: 'none',
                color: tokens.colors.text.primary, fontSize: 13, fontWeight: 500,
                cursor: 'pointer', textAlign: 'left',
              }}
              onMouseEnter={e => e.currentTarget.style.background = tokens.colors.bg.tertiary}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              Top {n}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 排行榜页面 - 核心功能，突出前三名
 */
function RankingTableInner(props: {
  traders: Trader[]
  loading: boolean
  loggedIn: boolean
  source?: string
  timeRange?: '7D' | '30D' | '90D'
  isPro?: boolean
  category?: CategoryType
  onCategoryChange?: (category: CategoryType) => void
  onProRequired?: () => void
  onFilterToggle?: () => void
  hasActiveFilters?: boolean
  error?: string | null
  onRetry?: () => void
  controlledSortColumn?: 'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha'
  controlledSortDir?: 'asc' | 'desc'
  controlledPage?: number
  controlledSearchQuery?: string
  onSortChange?: (column: 'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha', dir: 'asc' | 'desc') => void
  onPageChange?: (page: number) => void
  onSearchChange?: (query: string) => void
}) {
  const { traders, loading, source, timeRange = '90D', isPro = false, category = 'all', onCategoryChange, onProRequired, onFilterToggle, hasActiveFilters, error, onRetry,
    controlledSortColumn, controlledSortDir, controlledPage, controlledSearchQuery,
    onSortChange, onPageChange, onSearchChange,
  } = props
  const { t, language } = useLanguage()

  // Load ranking-table.css asynchronously (animations, hover effects)
  useRankingTableStyles()

  const [, startTransition] = useTransition()

  const [internalPage, setInternalPage] = useState(1)
  const [showRules, setShowRules] = useState(false)
  const [showScoreRulesModal, setShowScoreRulesModal] = useState(false)
  const [internalSortColumn, setInternalSortColumn] = useState<'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha'>('score')
  const [internalSortDir, setInternalSortDir] = useState<'asc' | 'desc'>('desc')
  const [justSortedColumn, setJustSortedColumn] = useState<string | null>(null)
  const [_sortAnimationKey, setSortAnimationKey] = useState(0)
  const itemsPerPage = 20

  // Mobile card view: load more instead of pagination
  const [cardVisibleCount, setCardVisibleCount] = useState(20)

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
  const columnSettingsRef = useRef<HTMLDivElement>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('table')

  useEffect(() => {
    setVisibleColumns(getStoredColumns())

    // Mobile auto-switch: respect manual choice, otherwise follow screen width
    const isManual = getStoredManualFlag()
    if (isManual) {
      setViewMode(getStoredViewMode())
    } else {
      const isMobile = window.matchMedia('(max-width: 767px)').matches
      setViewMode(isMobile ? 'card' : 'table')
    }

    // Auto-switch on resize when user hasn't manually chosen
    const mql = window.matchMedia('(max-width: 767px)')
    const handleResize = (e: MediaQueryListEvent) => {
      if (!getStoredManualFlag()) {
        setViewMode(e.matches ? 'card' : 'table')
      }
    }
    mql.addEventListener('change', handleResize)
    return () => mql.removeEventListener('change', handleResize)
  }, [])

  // Click-outside: close column settings dropdown
  useEffect(() => {
    if (!showColumnSettings) return
    const handleClickOutside = (e: MouseEvent) => {
      if (columnSettingsRef.current && !columnSettingsRef.current.contains(e.target as Node)) {
        setShowColumnSettings(false)
      }
    }
    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [showColumnSettings])

  const toggleViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    try {
      localStorage.setItem(LS_KEY_VIEW_MODE, mode)
      localStorage.setItem(LS_KEY_VIEW_MANUAL, 'true')
    } catch { /* ignore */ }
  }

  const resetViewModeToAuto = () => {
    try {
      localStorage.removeItem(LS_KEY_VIEW_MANUAL)
      localStorage.removeItem(LS_KEY_VIEW_MODE)
    } catch { /* ignore */ }
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
    let template = '44px minmax(140px, 1.5fr)'
    if (visibleColumns.includes('score')) template += ' 64px'
    if (visibleColumns.includes('roi')) template += ' 90px'
    if (visibleColumns.includes('winrate')) template += ' 70px'
    if (visibleColumns.includes('mdd')) template += ' 70px'
    if (visibleColumns.includes('sortino')) template += ' 70px'
    if (visibleColumns.includes('alpha')) template += ' 70px'
    if (visibleColumns.includes('style')) template += ' 80px'
    return template
  }, [visibleColumns])


  const handleSort = (col: 'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha') => {
    const newDir = sortColumn === col ? (sortDir === 'desc' ? 'asc' : 'desc') : 'desc'
    setJustSortedColumn(col)
    setSortAnimationKey(prev => prev + 1)
    setTimeout(() => setJustSortedColumn(null), 400)
    startTransition(() => {
      if (onSortChange) { onSortChange(col, newDir) }
      else { setInternalSortColumn(col); setInternalSortDir(newDir) }
      setCurrentPage(1)
    })
  }

  const handleSearchInput = (value: string) => {
    if (onSearchChange) onSearchChange(value)
    else setInternalSearchQuery(value)
    startTransition(() => { setCurrentPage(1) })
  }

  const sortedTraders = React.useMemo(() => {
    let data = traders.slice(0, 1000)
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase()
      data = data.filter(t => {
        const handle = (t.handle || t.id || '').toLowerCase()
        return handle.includes(q) || t.id.toLowerCase().includes(q)
      })
    }
    return [...data].sort((a, b) => {
      let aVal = 0, bVal = 0
      switch (sortColumn) {
        case 'score': aVal = a.arena_score ?? 0; bVal = b.arena_score ?? 0; break
        case 'roi': aVal = a.roi ?? 0; bVal = b.roi ?? 0; break
        case 'winrate': aVal = a.win_rate ?? 0; bVal = b.win_rate ?? 0; break
        case 'mdd': aVal = Math.abs(a.max_drawdown ?? 0); bVal = Math.abs(b.max_drawdown ?? 0); break
        case 'sortino': aVal = a.sortino_ratio ?? 0; bVal = b.sortino_ratio ?? 0; break
        case 'alpha': aVal = a.alpha ?? 0; bVal = b.alpha ?? 0; break
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })
  }, [traders, sortColumn, sortDir, debouncedSearch])


  const totalPages = Math.ceil(sortedTraders.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedTraders = sortedTraders.slice(startIndex, endIndex)

  // Wrap parseSourceInfo with translation function
  const parseSourceInfoWithT = useCallback((src: string) => parseSourceInfoUtil(src, t), [t])

  const handlePaginationChange = useCallback((page: number) => {
    setCurrentPage(page)
  }, [setCurrentPage])

  return (
    <>
    {/* Preload top trader avatars for faster LCP */}
    <AvatarPreload
      avatarUrls={traders.slice(0, 10).map(t => t.avatar_url)}
      maxPreload={10}
    />
    {/* Dynamic grid template override */}
    <style>{`
      @media (min-width: 768px) {
        .ranking-table-grid-custom {
          grid-template-columns: ${desktopGridTemplate} !important;
        }
        ${!visibleColumns.includes('score') ? '.ranking-table-grid-custom .col-score { display: none !important; }' : ''}
        ${!visibleColumns.includes('winrate') ? '.ranking-table-grid-custom .col-winrate { display: none !important; }' : ''}
        ${!visibleColumns.includes('mdd') ? '.ranking-table-grid-custom .col-mdd { display: none !important; }' : ''}
        ${!visibleColumns.includes('roi') ? '.ranking-table-grid-custom .roi-cell { display: none !important; }' : ''}
        ${!visibleColumns.includes('sortino') ? '.ranking-table-grid-custom .col-sortino { display: none !important; }' : ''}
        ${!visibleColumns.includes('alpha') ? '.ranking-table-grid-custom .col-alpha { display: none !important; }' : ''}
        ${!visibleColumns.includes('style') ? '.ranking-table-grid-custom .col-style { display: none !important; }' : ''}
      }
    `}</style>
    <Box
      className="glass-card ranking-table-container"
      p={0}
      radius="xl"
      style={{
        boxShadow: `${tokens.shadow.lg}, 0 0 0 1px var(--glass-border-light)`,
        overflow: 'hidden',
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.lg,
        WebkitBackdropFilter: tokens.glass.blur.lg,
        border: tokens.glass.border.light,
      }}
    >
      {/* Category Tabs + Tool buttons */}
      {onCategoryChange && (
        <Box
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: tokens.spacing[2],
            borderBottom: `1px solid var(--glass-border-light)`,
            background: tokens.glass.bg.light,
            borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
            flexWrap: 'wrap',
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
              <Text size="xs" weight="bold" color="secondary">
                {t('categoryType')}
              </Text>
              <ProLabel size="xs" />
            </Box>
            <CategoryRankingTabs currentCategory={category} onCategoryChange={onCategoryChange} isPro={isPro} onProRequired={onProRequired} />
          </Box>

          {/* Tool buttons */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
            {/* View toggle */}
            <Box className="view-toggle-group">
              <button onClick={() => toggleViewMode('table')} title={t('tableView')} aria-label={t('tableView')} aria-pressed={viewMode === 'table'} className={`view-toggle-btn touch-target-sm${viewMode === 'table' ? ' view-toggle-active' : ''}`}>
                <TableViewIcon size={12} />
              </button>
              <button onClick={() => toggleViewMode('card')} title={t('cardView')} aria-label={t('cardView')} aria-pressed={viewMode === 'card'} className={`view-toggle-btn touch-target-sm${viewMode === 'card' ? ' view-toggle-active' : ''}`}>
                <CardViewIcon size={12} />
              </button>
              {getStoredManualFlag() && (
                <button
                  onClick={resetViewModeToAuto}
                  title={t('resetAutoLayout')}
                  className="view-toggle-btn touch-target-sm"
                  style={{ fontSize: tokens.typography.fontSize.xs, opacity: 0.6 }}
                >
                  Auto
                </button>
              )}
            </Box>

            {/* Filter button */}
            <Box onClick={onFilterToggle} title={t('advancedFilter')} aria-label={t('advancedFilter')} role="button" tabIndex={0} className={`toolbar-btn touch-target-sm${hasActiveFilters ? ' toolbar-btn-active' : ''}`}
              style={{ position: 'relative' }}
            >
              <FilterIcon size={11} />
              <span>{t('filter')}</span>
              {!isPro && <LockIconSmall size={7} />}
              {hasActiveFilters && (
                <Box style={{ position: 'absolute', top: 2, right: 2, width: 4, height: 4, borderRadius: '50%', background: tokens.colors.accent.primary }} />
              )}
            </Box>

            {/* Compare button */}
            <Link href="/compare" title={t('compareTraders')} className="toolbar-btn touch-target-sm"
            >
              <CompareIcon size={11} />
              <span>{t('compare')}</span>
              {!isPro && <LockIconSmall size={7} />}
            </Link>

            {/* Column settings */}
            <div ref={columnSettingsRef} style={{ position: 'relative' }}>
              <Box onClick={() => setShowColumnSettings(!showColumnSettings)} title={t('columnSettingsTitle')} aria-label={t('columnSettingsTitle')} aria-expanded={showColumnSettings} role="button" tabIndex={0} className={`toolbar-btn touch-target-sm${showColumnSettings ? ' toolbar-btn-active' : ''}`}>
                <SettingsIcon size={11} />
              </Box>
              {showColumnSettings && (
                <Box style={{ position: 'absolute', top: '100%', right: 0, marginTop: tokens.spacing[1], padding: tokens.spacing[3], background: tokens.colors.bg.primary, border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.lg, boxShadow: tokens.shadow.lg, zIndex: 9999, minWidth: 160 }} onClick={(e) => e.stopPropagation()}>
                  <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                    {t('columnSettingsTitle')}
                  </Text>
                  {ALL_TOGGLEABLE_COLUMNS.map(col => (
                    <label key={col} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], padding: `${tokens.spacing[1]} 0`, cursor: 'pointer', fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.primary }}>
                      <input type="checkbox" checked={visibleColumns.includes(col)} onChange={() => toggleColumn(col)} style={{ cursor: 'pointer' }} />
                      {language === 'zh' ? COLUMN_LABELS[col].zh : COLUMN_LABELS[col].en}
                    </label>
                  ))}
                  <button onClick={resetColumns}
                    style={{ marginTop: tokens.spacing[2], padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, fontSize: tokens.typography.fontSize.xs, color: tokens.colors.accent.primary, background: 'transparent', border: `1px solid ${tokens.colors.accent.primary}40`, borderRadius: tokens.radius.sm, cursor: 'pointer', width: '100%' }}>
                    {t('resetToDefault')}
                  </button>
                </Box>
              )}
            </div>

            {/* Export ranking - Pro only */}
            {traders.length > 0 && (
              isPro ? (
                <ExportRankingButton traders={traders} source={source} timeRange={timeRange} language={language} />
              ) : (
                <button
                  onClick={() => onProRequired?.()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '4px 8px', borderRadius: 6,
                    border: '1px solid var(--color-border-primary)',
                    background: 'transparent',
                    color: 'var(--color-text-tertiary)',
                    fontSize: 11, fontWeight: 500,
                    cursor: 'pointer', opacity: 0.7,
                  }}
                  title={t('proFeature')}
                >
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3Z" /></svg>
                  {language === 'zh' ? '导出排名' : 'Export'}
                </button>
              )
            )}
          </Box>
        </Box>
      )}

      {/* Enhanced Search with history + keyboard nav */}
      <RankingSearch
        value={searchQuery}
        onChange={handleSearchInput}
        resultCount={debouncedSearch.trim() ? sortedTraders.length : undefined}
        language={language}
      />

      {/* Table Header (only in table view) - sticky */}
      {viewMode === 'table' && (
      <Box className="ranking-table-header ranking-table-grid ranking-table-grid-custom"
        style={{ display: 'grid', gap: tokens.spacing[2], padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`, borderBottom: `1px solid var(--glass-border-light)`, background: onCategoryChange ? 'rgba(15,15,30,0.98)' : tokens.glass.bg.light, borderRadius: onCategoryChange ? '0' : `${tokens.radius.xl} ${tokens.radius.xl} 0 0`, position: 'sticky', top: 0, zIndex: 20, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
        <Text size="sm" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: tokens.typography.fontSize.sm }}>{t('rank')}</Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: tokens.typography.fontSize.sm }}>{t('trader')}</Text>
          <button onClick={() => setShowRules(!showRules)}
            className="info-btn-circle"
            title={t('rankingRules')}
            aria-label={t('rankingRules')}
            aria-expanded={showRules}
          >?</button>
        </Box>
        <Box className={`col-score sort-header sort-header-center${sortColumn === 'score' ? ' sort-header-active' : ''} ${justSortedColumn === 'score' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('score')} title={t('arenaScoreTooltip')} aria-sort={sortColumn === 'score' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
          Score <SortIndicator active={sortColumn === 'score'} dir={sortDir} />
        </Box>
        <Box className={`roi-cell sort-header sort-header-end${sortColumn === 'roi' ? ' sort-header-active' : ''} ${justSortedColumn === 'roi' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('roi')} title={t('roiTooltip').replace('{range}', timeRange)} aria-sort={sortColumn === 'roi' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
          ROI <SortIndicator active={sortColumn === 'roi'} dir={sortDir} />
        </Box>
        <Box className={`col-winrate sort-header sort-header-end${sortColumn === 'winrate' ? ' sort-header-active' : ''} ${justSortedColumn === 'winrate' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('winrate')} title={t('winRateTooltip')} aria-sort={sortColumn === 'winrate' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
          Win% <SortIndicator active={sortColumn === 'winrate'} dir={sortDir} />
        </Box>
        <Box className={`col-mdd sort-header sort-header-end${sortColumn === 'mdd' ? ' sort-header-active' : ''} ${justSortedColumn === 'mdd' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('mdd')} title={t('mddTooltip')} aria-sort={sortColumn === 'mdd' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
          MDD <SortIndicator active={sortColumn === 'mdd'} dir={sortDir} />
        </Box>
        {visibleColumns.includes('sortino') && (
          <Box className={`col-sortino sort-header sort-header-end${sortColumn === 'sortino' ? ' sort-header-active' : ''} ${justSortedColumn === 'sortino' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('sortino')} title={t('sortinoTooltip') || 'Sortino Ratio'} data-sortable>
            Sortino <SortIndicator active={sortColumn === 'sortino'} dir={sortDir} />
          </Box>
        )}
        {visibleColumns.includes('alpha') && (
          <Box className={`col-alpha sort-header sort-header-end${sortColumn === 'alpha' ? ' sort-header-active' : ''} ${justSortedColumn === 'alpha' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('alpha')} title={t('alphaTooltip') || 'Alpha (excess return)'} data-sortable>
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

      {loading ? (
        <RankingSkeleton />
      ) : error ? (
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
        <Box style={{ padding: `${tokens.spacing[12]} ${tokens.spacing[4]}`, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[4] }}>
          <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, color: tokens.colors.text.tertiary }}>
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
          </svg>
          <Text size="md" weight="semibold" style={{ color: tokens.colors.text.secondary }}>
            {debouncedSearch.trim() || hasActiveFilters
              ? '没有符合条件的交易员'
              : t('noTraderData')}
          </Text>
          {(debouncedSearch.trim() || hasActiveFilters) && (
            <>
              <Text size="sm" style={{ color: tokens.colors.text.tertiary }}>
                试试放宽筛选条件
              </Text>
              <button
                onClick={() => {
                  if (debouncedSearch.trim()) {
                    if (onSearchChange) onSearchChange('')
                    else setInternalSearchQuery('')
                  }
                }}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                  background: `${tokens.colors.accent.primary}20`,
                  border: `1px solid ${tokens.colors.accent.primary}40`,
                  borderRadius: tokens.radius.md,
                  color: tokens.colors.accent.primary,
                  cursor: 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.bold,
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {t('clearSearch')}
              </button>
            </>
          )}
        </Box>
      ) : viewMode === 'card' ? (
        <>
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))', gap: tokens.spacing[3], padding: tokens.spacing[4] }}>
            {sortedTraders.slice(0, cardVisibleCount).map((trader, idx) => {
              const rank = idx + 1
              return (
                <TraderCard key={`${trader.id}-${trader.source || 'unknown'}`}
                  trader={trader} rank={rank} source={source} language={language}
                  searchQuery={debouncedSearch}
                  getMedalGlowClass={getMedalGlowClass} parseSourceInfo={parseSourceInfoWithT} />
              )
            })}
          </Box>
          {cardVisibleCount < sortedTraders.length && (
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
          )}
        </>
      ) : (
        <>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {paginatedTraders.map((trader, idx) => {
              const rank = startIndex + idx + 1
              return (
                <TraderRow key={`${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`}
                  trader={trader} rank={rank} source={source} language={language}
                  searchQuery={debouncedSearch}
                  getMedalGlowClass={getMedalGlowClass} parseSourceInfo={parseSourceInfoWithT} getPnLTooltipFn={getPnLTooltip} />
              )
            })}
          </Box>
          {/* Registration CTA after first page for non-logged-in users */}
          {!props.loggedIn && currentPage === 1 && sortedTraders.length > itemsPerPage && (
            <Link href="/login" style={{ textDecoration: 'none' }}>
              <Box style={{
                margin: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                background: `linear-gradient(135deg, ${tokens.colors.accent.primary}15, ${tokens.colors.accent.brand}10)`,
                border: `1px solid ${tokens.colors.accent.primary}30`,
                borderRadius: tokens.radius.lg,
                textAlign: 'center',
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
              }}>
                <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                  {language === 'zh' ? '🔓 注册免费查看更多交易员' : '🔓 Sign up free to see more traders'}
                </Text>
              </Box>
            </Link>
          )}
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={handlePaginationChange} />
        </>
      )}
    </Box>
    </>
  )
}

const RankingTable = memo(RankingTableInner)
export { RankingTable }
export default RankingTable
