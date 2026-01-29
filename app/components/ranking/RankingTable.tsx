'use client'

import React, { useState, useEffect, useRef, memo, useCallback, useTransition } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../ui/Skeleton'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { DynamicScoreRulesModal as ScoreRulesModal } from '../ui/dynamic'
import CategoryRankingTabs, { CategoryType } from './CategoryRankingTabs'
import { ProLabel } from '../premium/PremiumGate'
import ExportButton from '../utils/ExportButton'
import { VirtualList } from '../ui/VirtualList'
import Pagination from '../ui/Pagination'

// Extracted components
import { TraderRow } from './TraderRow'
import { TraderCard } from './TraderCard'
import { ScoreBreakdownTooltip } from './ScoreBreakdownTooltip'
import RankingSearch from './RankingSearch'
import {
  FilterIcon, CompareIcon, SortIndicator, LockIconSmall,
  SearchIcon, TableViewIcon, CardViewIcon, SettingsIcon,
} from './icons'
import { getPnLTooltip, parseSourceInfo as parseSourceInfoUtil, getMedalGlowClass } from './utils'

// CSS animations (replaces injectStyles)
import './ranking-table.css'

// Column customization types
export type ColumnKey = 'score' | 'roi' | 'winrate' | 'mdd'

const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'winrate', 'mdd']
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'winrate', 'mdd']
const COLUMN_LABELS: Record<ColumnKey, { zh: string; en: string }> = {
  score: { zh: 'Arena Score', en: 'Arena Score' },
  roi: { zh: 'ROI', en: 'ROI' },
  winrate: { zh: '胜率', en: 'Win Rate' },
  mdd: { zh: '最大回撤', en: 'Max Drawdown' },
}
const LS_KEY_COLUMNS = 'ranking-visible-columns'
const LS_KEY_VIEW_MODE = 'ranking-view-mode'

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
  drawdown_score?: number
  stability_score?: number
  rank_change?: number | null
  is_new?: boolean
  also_on?: string[]
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
  controlledSortColumn?: 'score' | 'roi' | 'winrate' | 'mdd'
  controlledSortDir?: 'asc' | 'desc'
  controlledPage?: number
  controlledSearchQuery?: string
  onSortChange?: (column: 'score' | 'roi' | 'winrate' | 'mdd', dir: 'asc' | 'desc') => void
  onPageChange?: (page: number) => void
  onSearchChange?: (query: string) => void
}) {
  const { traders, loading, source, timeRange = '90D', isPro = false, category = 'all', onCategoryChange, onProRequired, onFilterToggle, hasActiveFilters, error, onRetry,
    controlledSortColumn, controlledSortDir, controlledPage, controlledSearchQuery,
    onSortChange, onPageChange, onSearchChange,
  } = props
  const { t, language } = useLanguage()

  const [, startTransition] = useTransition()

  const [internalPage, setInternalPage] = useState(1)
  const [showRules, setShowRules] = useState(false)
  const [showScoreRulesModal, setShowScoreRulesModal] = useState(false)
  const [internalSortColumn, setInternalSortColumn] = useState<'score' | 'roi' | 'winrate' | 'mdd'>('score')
  const [internalSortDir, setInternalSortDir] = useState<'asc' | 'desc'>('desc')
  const [justSortedColumn, setJustSortedColumn] = useState<string | null>(null)
  const [sortAnimationKey, setSortAnimationKey] = useState(0)
  const itemsPerPage = 20

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

  useEffect(() => {
    setVisibleColumns(getStoredColumns())
    setViewMode(getStoredViewMode())
  }, [])

  const toggleViewMode = (mode: ViewMode) => {
    setViewMode(mode)
    try { localStorage.setItem(LS_KEY_VIEW_MODE, mode) } catch { /* ignore */ }
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
    return template
  }, [visibleColumns])

  const virtualListRef = useRef<HTMLDivElement>(null)

  const handleSort = (col: 'score' | 'roi' | 'winrate' | 'mdd') => {
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
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal
    })
  }, [traders, sortColumn, sortDir, debouncedSearch])

  const useVirtualScroll = false

  useEffect(() => {
    if (useVirtualScroll && virtualListRef.current) {
      const scrollContainer = virtualListRef.current.querySelector('[style*="overflow"]') as HTMLElement
      if (scrollContainer) scrollContainer.scrollTop = 0
    }
  }, [sortColumn, sortDir, useVirtualScroll])

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
      }
    `}</style>
    <Box
      className="glass-card"
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
                {language === 'en' ? 'Category' : '分类'}
              </Text>
              <ProLabel size="xs" />
            </Box>
            <CategoryRankingTabs currentCategory={category} onCategoryChange={onCategoryChange} isPro={isPro} onProRequired={onProRequired} />
          </Box>

          {/* Tool buttons */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
            {/* View toggle */}
            <Box style={{ display: 'flex', alignItems: 'center', borderRadius: tokens.radius.md, border: '1px solid var(--color-border-secondary)', overflow: 'hidden' }}>
              <button onClick={() => toggleViewMode('table')} title={language === 'en' ? 'Table View' : '表格视图'} className="touch-target-sm"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', height: 26, background: viewMode === 'table' ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)', border: 'none', borderRight: '1px solid var(--color-border-secondary)', color: viewMode === 'table' ? 'var(--color-pro-gradient-start)' : 'var(--color-text-tertiary)', cursor: 'pointer', transition: 'all 0.2s' }}>
                <TableViewIcon size={12} />
              </button>
              <button onClick={() => toggleViewMode('card')} title={language === 'en' ? 'Card View' : '卡片视图'} className="touch-target-sm"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', height: 26, background: viewMode === 'card' ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)', border: 'none', color: viewMode === 'card' ? 'var(--color-pro-gradient-start)' : 'var(--color-text-tertiary)', cursor: 'pointer', transition: 'all 0.2s' }}>
                <CardViewIcon size={12} />
              </button>
            </Box>

            {/* Filter button */}
            <Box onClick={onFilterToggle} title={language === 'en' ? 'Advanced Filter' : '高级筛选'} className="touch-target-sm"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '4px 8px', height: 26, borderRadius: tokens.radius.md, position: 'relative', background: hasActiveFilters ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)', border: hasActiveFilters ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-secondary)', color: hasActiveFilters ? 'var(--color-pro-gradient-start)' : 'var(--color-text-secondary)', cursor: 'pointer', transition: 'all 0.2s', fontSize: 11 }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'; e.currentTarget.style.color = 'var(--color-pro-gradient-start)'; e.currentTarget.style.background = 'var(--color-pro-glow)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = hasActiveFilters ? 'var(--color-pro-gradient-start)' : 'var(--color-border-secondary)'; e.currentTarget.style.color = hasActiveFilters ? 'var(--color-pro-gradient-start)' : 'var(--color-text-secondary)'; e.currentTarget.style.background = hasActiveFilters ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)' }}
            >
              <FilterIcon size={11} />
              <span>{language === 'zh' ? '筛选' : 'Filter'}</span>
              {!isPro && <LockIconSmall size={7} />}
              {hasActiveFilters && (
                <Box style={{ position: 'absolute', top: 2, right: 2, width: 4, height: 4, borderRadius: '50%', background: tokens.colors.accent.primary }} />
              )}
            </Box>

            {/* Compare button */}
            <Link href="/compare" title={language === 'en' ? 'Compare Traders' : '交易员对比'} className="touch-target-sm"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '4px 8px', height: 26, borderRadius: tokens.radius.md, background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border-secondary)', color: 'var(--color-text-secondary)', textDecoration: 'none', cursor: 'pointer', transition: 'all 0.2s', fontSize: 11 }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'; e.currentTarget.style.color = 'var(--color-pro-gradient-start)'; e.currentTarget.style.background = 'var(--color-pro-glow)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)'; e.currentTarget.style.borderColor = 'var(--color-border-secondary)'; e.currentTarget.style.color = 'var(--color-text-secondary)' }}
            >
              <CompareIcon size={11} />
              <span>{language === 'zh' ? '对比' : 'Compare'}</span>
              {!isPro && <LockIconSmall size={7} />}
            </Link>

            {/* Column settings */}
            <Box style={{ position: 'relative' }}>
              <Box onClick={() => setShowColumnSettings(!showColumnSettings)} title={language === 'en' ? 'Column Settings' : '列设置'} className="touch-target-sm"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, padding: '4px 8px', height: 26, borderRadius: tokens.radius.md, background: showColumnSettings ? 'var(--color-pro-glow)' : 'var(--color-bg-tertiary)', border: showColumnSettings ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-secondary)', color: showColumnSettings ? 'var(--color-pro-gradient-start)' : 'var(--color-text-secondary)', cursor: 'pointer', transition: 'all 0.2s', fontSize: 11 }}>
                <SettingsIcon size={11} />
              </Box>
              {showColumnSettings && (
                <Box style={{ position: 'absolute', top: '100%', right: 0, marginTop: tokens.spacing[1], padding: tokens.spacing[3], background: tokens.colors.bg.primary, border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.lg, boxShadow: tokens.shadow.lg, zIndex: 9999, minWidth: 160 }} onClick={(e) => e.stopPropagation()}>
                  <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                    {language === 'zh' ? '列设置' : 'Column Settings'}
                  </Text>
                  {ALL_TOGGLEABLE_COLUMNS.map(col => (
                    <label key={col} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], padding: `${tokens.spacing[1]} 0`, cursor: 'pointer', fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.primary }}>
                      <input type="checkbox" checked={visibleColumns.includes(col)} onChange={() => toggleColumn(col)} style={{ cursor: 'pointer' }} />
                      {language === 'zh' ? COLUMN_LABELS[col].zh : COLUMN_LABELS[col].en}
                    </label>
                  ))}
                  <button onClick={resetColumns}
                    style={{ marginTop: tokens.spacing[2], padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`, fontSize: tokens.typography.fontSize.xs, color: tokens.colors.accent.primary, background: 'transparent', border: `1px solid ${tokens.colors.accent.primary}40`, borderRadius: tokens.radius.sm, cursor: 'pointer', width: '100%' }}>
                    {language === 'zh' ? '恢复默认' : 'Reset to Default'}
                  </button>
                </Box>
              )}
            </Box>

            {/* Export button */}
            {isPro && traders.length > 0 && (
              <ExportButton
                data={traders.map(t => ({
                  rank: traders.indexOf(t) + 1, handle: t.handle || t.id, source: t.source || '',
                  arena_score: t.arena_score ?? '', roi: t.roi, pnl: t.pnl ?? '',
                  win_rate: t.win_rate ?? '', max_drawdown: t.max_drawdown ?? '', followers: t.followers,
                }))}
                filename={`ranking-arena-${source || 'all'}-${timeRange || '90D'}`}
                format="csv"
              />
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

      {/* Table Header (only in table view) */}
      {viewMode === 'table' && (
      <Box className="ranking-table-header ranking-table-grid ranking-table-grid-custom"
        style={{ display: 'grid', gap: tokens.spacing[2], padding: `${tokens.spacing[4]} ${tokens.spacing[4]}`, borderBottom: `1px solid var(--glass-border-light)`, background: onCategoryChange ? 'transparent' : tokens.glass.bg.light, borderRadius: onCategoryChange ? '0' : `${tokens.radius.xl} ${tokens.radius.xl} 0 0` }}>
        <Text size="sm" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px' }}>{t('rank')}</Text>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="sm" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px' }}>{t('trader')}</Text>
          <button onClick={() => setShowRules(!showRules)}
            style={{ background: 'transparent', border: `1px solid ${tokens.colors.border.primary}`, borderRadius: tokens.radius.full, width: 18, height: 18, fontSize: 11, color: tokens.colors.text.tertiary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: `all ${tokens.transition.fast}`, flexShrink: 0 }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = tokens.colors.accent.primary; e.currentTarget.style.color = tokens.colors.accent.primary; e.currentTarget.style.transform = 'scale(1.1)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary; e.currentTarget.style.color = tokens.colors.text.tertiary; e.currentTarget.style.transform = 'scale(1)' }}
            title="排名规则"
          >?</button>
        </Box>
        <Box className={`col-score ${sortColumn === 'score' ? 'active' : ''} ${justSortedColumn === 'score' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('score')} title={language === 'zh' ? 'Arena Score: 综合评分 (0-100)' : 'Arena Score: Overall rating (0-100)'} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'score' ? tokens.colors.accent.primary : tokens.colors.text.tertiary, transition: 'color 0.2s' }}>
          Score <SortIndicator active={sortColumn === 'score'} dir={sortDir} />
        </Box>
        <Box className={`roi-cell ${sortColumn === 'roi' ? 'active' : ''} ${justSortedColumn === 'roi' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('roi')} title={language === 'zh' ? `ROI: 投资回报率 (${timeRange})` : `ROI: Return on Investment (${timeRange})`} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'roi' ? tokens.colors.accent.primary : tokens.colors.text.tertiary, transition: 'color 0.2s' }}>
          ROI <SortIndicator active={sortColumn === 'roi'} dir={sortDir} />
        </Box>
        <Box className={`col-winrate ${sortColumn === 'winrate' ? 'active' : ''} ${justSortedColumn === 'winrate' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('winrate')} title={language === 'zh' ? 'Win%: 胜率' : 'Win%: Win Rate'} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'winrate' ? tokens.colors.accent.primary : tokens.colors.text.tertiary, transition: 'color 0.2s' }}>
          Win% <SortIndicator active={sortColumn === 'winrate'} dir={sortDir} />
        </Box>
        <Box className={`col-mdd ${sortColumn === 'mdd' ? 'active' : ''} ${justSortedColumn === 'mdd' ? 'just-sorted' : ''}`} as="button" onClick={() => handleSort('mdd')} title={language === 'zh' ? 'MDD: 最大回撤' : 'MDD: Max Drawdown'} data-sortable
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 700, color: sortColumn === 'mdd' ? tokens.colors.accent.primary : tokens.colors.text.tertiary, transition: 'color 0.2s' }}>
          MDD <SortIndicator active={sortColumn === 'mdd'} dir={sortDir} />
        </Box>
      </Box>
      )}

      {/* Rules explanation */}
      {showRules && (
        <Box style={{ padding: `${tokens.spacing[4]} ${tokens.spacing[5]}`, background: `${tokens.colors.accent.primary}10`, borderBottom: `1px solid ${tokens.colors.border.primary}`, fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.secondary, lineHeight: 1.7 }}>
          <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary, marginBottom: 8, display: 'block' }}>
            {language === 'zh' ? 'Arena Score 排名规则' : 'Arena Score Ranking Rules'}
          </Text>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span>{language === 'zh' ? '① 按 Arena Score 从高到低排序（0-100 分）' : '① Ranked by Arena Score (0-100)'}</span>
            <span>{language === 'zh' ? '② 分数构成：收益分（85%）+ 稳定/风险分（15%）' : '② Score: Return (85%) + Stability/Risk (15%)'}</span>
            <span>{language === 'zh' ? '③ Score 相同时，回撤更小的靠前' : '③ Lower drawdown ranks higher when Score ties'}</span>
            <span style={{ color: tokens.colors.text.tertiary, marginTop: 6 }}>
              {language === 'zh' ? '* 入榜门槛（PNL 收益）：7D > $300 | 30D > $1,000 | 90D > $3,000' : '* Entry threshold (PNL): 7D > $300 | 30D > $1,000 | 90D > $3,000'}
            </span>
            <span style={{ color: tokens.colors.text.tertiary, marginTop: 4 }}>
              {language === 'zh' ? '* ROI 计算方式因交易所而异，跨所对比时请注意差异' : '* ROI calculation varies by exchange. Use caution when comparing across exchanges.'}
            </span>
          </div>
          <button onClick={() => setShowScoreRulesModal(true)}
            style={{ marginTop: 12, padding: '6px 14px', fontSize: tokens.typography.fontSize.xs, fontWeight: tokens.typography.fontWeight.bold, color: tokens.colors.accent.primary, background: `${tokens.colors.accent.primary}15`, border: `1px solid ${tokens.colors.accent.primary}30`, borderRadius: tokens.radius.md, cursor: 'pointer', transition: tokens.transition.base, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = `${tokens.colors.accent.primary}25`; e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}50` }}
            onMouseLeave={(e) => { e.currentTarget.style.background = `${tokens.colors.accent.primary}15`; e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}30` }}>
            详细
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
              style={{ padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`, background: `${tokens.colors.accent.primary}20`, border: `1px solid ${tokens.colors.accent.primary}40`, borderRadius: tokens.radius.md, color: tokens.colors.accent.primary, cursor: 'pointer', fontSize: tokens.typography.fontSize.sm, fontWeight: tokens.typography.fontWeight.bold, transition: `all ${tokens.transition.base}` }}
              onMouseEnter={(e) => { e.currentTarget.style.background = `${tokens.colors.accent.primary}30` }}
              onMouseLeave={(e) => { e.currentTarget.style.background = `${tokens.colors.accent.primary}20` }}>
              {t('retry') || '重试'}
            </button>
          )}
        </Box>
      ) : sortedTraders.length === 0 ? (
        <Box style={{ color: tokens.colors.text.tertiary, padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`, textAlign: 'center', fontSize: tokens.typography.fontSize.md }}>
          {t('noTraderData')}
        </Box>
      ) : viewMode === 'card' ? (
        <>
          <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: tokens.spacing[3], padding: tokens.spacing[4] }}>
            {paginatedTraders.map((trader, idx) => {
              const rank = startIndex + idx + 1
              return (
                <TraderCard key={`${trader.id}-${trader.source || 'unknown'}-${startIndex + idx}`}
                  trader={trader} rank={rank} source={source} language={language}
                  searchQuery={debouncedSearch}
                  getMedalGlowClass={getMedalGlowClass} parseSourceInfo={parseSourceInfoWithT} />
              )
            })}
          </Box>
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={handlePaginationChange} />
        </>
      ) : useVirtualScroll ? (
        <div ref={virtualListRef}>
          <VirtualList items={sortedTraders} itemHeight={72} height={600} overscan={5}
            keyExtractor={(trader, idx) => `${trader.id}-${trader.source || 'unknown'}-${idx}`}
            renderItem={(trader, idx) => (
              <TraderRow trader={trader} rank={idx + 1} source={source} language={language}
                searchQuery={debouncedSearch}
                getMedalGlowClass={getMedalGlowClass} parseSourceInfo={parseSourceInfoWithT} getPnLTooltipFn={getPnLTooltip} />
            )} />
        </div>
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
          <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={handlePaginationChange} />
        </>
      )}
    </Box>
    </>
  )
}

const RankingTable = memo(RankingTableInner)
export default RankingTable
