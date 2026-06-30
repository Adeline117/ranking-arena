'use client'

import { localizedLabel } from '@/lib/utils/format'
import React, { useRef, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { tokens, alpha as colorAlpha } from '@/lib/design-tokens'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { type CategoryType } from './CategoryRankingTabs'
import { FilterIcon, CompareIcon, SettingsIcon, LockIconSmall } from './Icons'
import type { ColumnKey, RankingDensity } from './RankingTable'
import { getFilterableStyles, classifyStyle, type TradingStyle } from '@/lib/utils/trading-style'

const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = [
  'score',
  'roi',
  'pnl',
  'winrate',
  'mdd',
  'sharpe',
  'followers',
  'trades',
]
const COLUMN_LABELS: Record<ColumnKey, { zh: string; en: string }> = {
  score: { zh: 'Arena Score', en: 'Arena Score' },
  roi: { zh: 'ROI', en: 'ROI' },
  pnl: { zh: 'PnL', en: 'PnL' },
  winrate: { zh: '胜率', en: 'Win Rate' },
  mdd: { zh: '最大回撤', en: 'Max Drawdown' },
  sharpe: { zh: 'Sharpe', en: 'Sharpe' },
  sortino: { zh: 'Sortino', en: 'Sortino' },
  alpha: { zh: 'Alpha', en: 'Alpha' },
  style: { zh: '交易风格', en: 'Style' },
  followers: { zh: '跟单人数', en: 'Followers' },
  trades: { zh: '交易次数', en: 'Trades' },
}

const SCORE_TIERS = [
  { value: 'S' as const, range: '90+', color: 'var(--color-score-legendary)' },
  { value: 'A' as const, range: '70-89', color: 'var(--color-score-great)' },
  { value: 'B' as const, range: '50-69', color: 'var(--color-score-average)' },
  { value: 'C' as const, range: '30-49', color: 'var(--color-score-below)' },
  { value: 'D' as const, range: '<30', color: 'var(--color-score-low)' },
]

interface ExportRankingButtonProps {
  traders: {
    id: string
    handle: string | null
    source?: string
    arena_score?: number
    roi: number
    pnl?: number | null
    win_rate?: number | null
    max_drawdown?: number | null
    followers: number
    // Optional facet fields (present on full Trader objects) — used for per-chip match counts (3.2)
    trading_style?: string | null
    avg_holding_hours?: number | null
    trades_count?: number | null
    is_bot?: boolean
    trader_type?: 'human' | 'bot' | 'suspected_bot' | null
  }[]
  source?: string
  timeRange?: string
  language: string
}

/** CSV / JSON export dropdown button */
function ExportRankingButton({ traders, source, timeRange }: ExportRankingButtonProps) {
  const [showMenu, setShowMenu] = React.useState(false)
  const { t } = useLanguage()
  const { showToast } = useToast()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    if (showMenu) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  const buildRows = (count: number) =>
    traders.slice(0, count).map((t, i) => ({
      rank: i + 1,
      handle: t.handle || t.id,
      source: t.source || '',
      arena_score: t.arena_score ?? '',
      roi: t.roi,
      pnl: t.pnl ?? '',
      win_rate: t.win_rate ?? '',
      max_drawdown: t.max_drawdown ?? '',
      followers: t.followers,
    }))

  const doExport = async (count: number, format: 'csv' | 'json') => {
    setShowMenu(false)
    const rows = buildRows(count)
    const filename = `ranking-${source || 'all'}-top${count}-${timeRange || '90D'}`
    const { exportToCSV, exportToJSON } = await import('@/lib/utils/export')
    if (format === 'json') exportToJSON(rows, filename)
    else exportToCSV(rows as unknown as Record<string, unknown>[], filename)
    showToast(t('exportStarted') || `Exported Top ${count} (${format.toUpperCase()})`, 'success')
  }

  const counts = [10, 50, 100].filter((n) => n <= traders.length || n === 10)

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        aria-expanded={showMenu}
        aria-haspopup="true"
        aria-label={t('exportRanking')}
        className="export-ranking-btn hover-bg-tertiary"
        style={{
          padding: '8px 12px',
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.secondary,
          color: tokens.colors.text.primary,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.semibold,
          cursor: 'pointer',
          minHeight: 44,
          transition: 'all 0.15s',
        }}
      >
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className="hide-desktop"
        >
          <path
            d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="hide-mobile">{t('exportRanking')}</span>
      </button>
      {showMenu && (
        <div
          className="dropdown-enter"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: tokens.radius.md,
            overflow: 'hidden',
            zIndex: tokens.zIndex.dropdown,
            minWidth: 160,
            boxShadow: tokens.shadow.md,
          }}
        >
          <div
            style={{
              padding: '6px 12px',
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            CSV
          </div>
          {counts.map((n) => (
            <button
              key={`csv-${n}`}
              onClick={() => doExport(n, 'csv')}
              className="hover-bg-tertiary"
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 16px',
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Top {n}
            </button>
          ))}
          <div
            style={{ borderTop: `1px solid ${tokens.colors.border.primary}`, margin: '4px 0' }}
          />
          <div
            style={{
              padding: '6px 12px',
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            JSON
          </div>
          {counts.map((n) => (
            <button
              key={`json-${n}`}
              onClick={() => doExport(n, 'json')}
              className="hover-bg-tertiary"
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 16px',
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              Top {n}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface RankingFiltersProps {
  // Category
  category: CategoryType
  onCategoryChange: (c: CategoryType) => void
  isPro: boolean
  onProRequired?: () => void
  // Filter panel
  filterOpen: boolean
  onFilterToggle: () => void
  hasActiveFilters?: boolean
  // Column settings
  visibleColumns: ColumnKey[]
  showColumnSettings: boolean
  onShowColumnSettings: (show: boolean) => void
  onToggleColumn: (col: ColumnKey) => void
  onResetColumns: () => void
  // Trading style filter
  styleFilter: TradingStyle | 'all'
  onStyleFilterChange: (style: TradingStyle | 'all') => void
  hasStyleData: boolean
  // Score grade filter
  scoreGradeFilter: 'all' | 'S' | 'A' | 'B' | 'C' | 'D'
  onScoreGradeFilterChange: (grade: 'all' | 'S' | 'A' | 'B' | 'C' | 'D') => void
  // Trader type filter (human/bot/all)
  traderTypeFilter?: 'all' | 'human' | 'bot'
  onTraderTypeFilterChange?: (type: 'all' | 'human' | 'bot') => void
  // Export
  traders: ExportRankingButtonProps['traders']
  source?: string
  timeRange?: string
  // Server-side category counts for tab badges
  categoryCounts?: { all: number; futures: number; spot: number; onchain: number }
  // Row density toggle (1.4)
  density?: RankingDensity
  onDensityChange?: (d: RankingDensity) => void
}

/** Pill-style filter chip */
function FilterChip({
  active,
  label,
  color,
  count,
  disabled,
  onClick,
}: {
  active: boolean
  label: string
  color?: string
  /** Per-facet match count appended as `Label N` (3.2). Omit to render label only. */
  count?: number
  /** Greyed-out + non-interactive when this facet has zero matches (3.2). */
  disabled?: boolean
  onClick: () => void
}) {
  const activeColor = color || tokens.colors.accent.primary
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        padding: '5px 12px',
        borderRadius: tokens.radius.full,
        minHeight: 36,
        border: active ? `1px solid ${activeColor}` : `1px solid ${tokens.colors.border.primary}`,
        background: active ? `color-mix(in srgb, ${activeColor} 15%, transparent)` : 'transparent',
        color: active ? activeColor : tokens.colors.text.secondary,
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: active ? 700 : 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.15s ease, transform 0.1s ease',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {count != null && (
        <span
          style={{
            marginLeft: 5,
            opacity: 0.65,
            fontWeight: tokens.typography.fontWeight.semibold,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * RankingFilters — toolbar with filter button, compare, column settings, export.
 * Style + Score filters live in the expandable panel triggered by the Filter button.
 */
export function RankingFilters({
  category: _category,
  onCategoryChange: _onCategoryChange,
  isPro,
  onProRequired,
  filterOpen,
  onFilterToggle,
  hasActiveFilters,
  visibleColumns,
  showColumnSettings,
  onShowColumnSettings,
  onToggleColumn,
  onResetColumns,
  styleFilter,
  onStyleFilterChange,
  hasStyleData,
  scoreGradeFilter,
  onScoreGradeFilterChange,
  traderTypeFilter = 'all',
  onTraderTypeFilterChange,
  traders,
  source,
  timeRange,
  categoryCounts: _categoryCounts,
  density,
  onDensityChange,
}: RankingFiltersProps) {
  const { t, language } = useLanguage()
  const columnSettingsRef = useRef<HTMLDivElement>(null)
  const filterPanelRef = useRef<HTMLDivElement>(null)

  // Close column dropdown on outside click
  useEffect(() => {
    if (!showColumnSettings) return
    const handler = (e: MouseEvent) => {
      if (columnSettingsRef.current && !columnSettingsRef.current.contains(e.target as Node)) {
        onShowColumnSettings(false)
      }
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [showColumnSettings, onShowColumnSettings])

  // Close filter panel on outside click
  useEffect(() => {
    if (!filterOpen) return
    const handler = (e: MouseEvent) => {
      if (filterPanelRef.current && !filterPanelRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest?.('[data-filter-toggle]')) return
        onFilterToggle()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterOpen, onFilterToggle])

  // 3.2 — per-facet match counts over the loaded trader list. Memoized so this
  // O(n) pass only re-runs when the trader data changes (not on every render).
  const styleCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const tr of traders) {
      const style =
        tr.trading_style && tr.trading_style !== 'unknown'
          ? tr.trading_style
          : classifyStyle({
              avg_holding_hours: tr.avg_holding_hours,
              trades_count: tr.trades_count,
              win_rate: tr.win_rate,
            })
      m[style] = (m[style] || 0) + 1
    }
    return m
  }, [traders])

  const scoreCounts = useMemo(() => {
    const c: Record<'S' | 'A' | 'B' | 'C' | 'D', number> = { S: 0, A: 0, B: 0, C: 0, D: 0 }
    for (const tr of traders) {
      const s = tr.arena_score ?? 0
      if (s >= 90) c.S++
      else if (s >= 70) c.A++
      else if (s >= 50) c.B++
      else if (s >= 30) c.C++
      else c.D++
    }
    return c
  }, [traders])

  // 3.3 — persist style / score-grade / trader-type filters in the URL so a
  // filtered leaderboard is shareable, bookmarkable and back-safe. Mirrors the
  // window.history pattern in useRankingFilters (avoids forcing a Suspense
  // boundary via useSearchParams). Only non-default values are written; selecting
  // 'all' clears the param, keeping the URL clean.
  const writeFilterParam = useCallback((key: string, value: string) => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (value && value !== 'all') params.set(key, value)
    else params.delete(key)
    const qs = params.toString()
    window.history.replaceState(
      null,
      '',
      qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    )
  }, [])

  const handleStyleChange = useCallback(
    (s: TradingStyle | 'all') => {
      onStyleFilterChange(s)
      writeFilterParam('style', s)
    },
    [onStyleFilterChange, writeFilterParam]
  )
  const handleScoreChange = useCallback(
    (g: 'all' | 'S' | 'A' | 'B' | 'C' | 'D') => {
      onScoreGradeFilterChange(g)
      writeFilterParam('grade', g)
    },
    [onScoreGradeFilterChange, writeFilterParam]
  )
  const handleTraderTypeChange = useCallback(
    (ty: 'all' | 'human' | 'bot') => {
      onTraderTypeFilterChange?.(ty)
      writeFilterParam('ttype', ty)
    },
    [onTraderTypeFilterChange, writeFilterParam]
  )

  // Read filter state back from the URL once on mount (3.3 read-back on load).
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current || typeof window === 'undefined') return
    hydratedRef.current = true
    const params = new URLSearchParams(window.location.search)
    const urlStyle = params.get('style')
    const urlGrade = params.get('grade')
    const urlType = params.get('ttype')
    if (
      urlStyle &&
      urlStyle !== styleFilter &&
      getFilterableStyles().some((s) => s.style === urlStyle)
    ) {
      onStyleFilterChange(urlStyle as TradingStyle)
    }
    if (urlGrade && urlGrade !== scoreGradeFilter && ['S', 'A', 'B', 'C', 'D'].includes(urlGrade)) {
      onScoreGradeFilterChange(urlGrade as 'S' | 'A' | 'B' | 'C' | 'D')
    }
    if (
      urlType &&
      urlType !== traderTypeFilter &&
      (urlType === 'human' || urlType === 'bot') &&
      onTraderTypeFilterChange
    ) {
      onTraderTypeFilterChange(urlType)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount to hydrate from initial URL
  }, [])

  const activeFilterCount =
    (styleFilter !== 'all' ? 1 : 0) +
    (scoreGradeFilter !== 'all' ? 1 : 0) +
    (traderTypeFilter !== 'all' ? 1 : 0)

  return (
    <>
      {/* Toolbar row */}
      <Box
        className="ranking-toolbar-row"
        style={{
          padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[2],
          borderBottom: '1px solid var(--glass-border-light)',
          background: tokens.glass.bg.light,
          borderRadius: tokens.radius.none,
          flexWrap: 'wrap',
        }}
      >
        {/* Trader type filter — inline */}
        {onTraderTypeFilterChange && (
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {[
              { value: 'all' as const, label: t('allTraderTypes') },
              { value: 'human' as const, label: t('isHuman') },
              { value: 'bot' as const, label: t('isBot') },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleTraderTypeChange(opt.value)}
                style={{
                  padding: '4px 10px',
                  borderRadius: tokens.radius.lg,
                  minHeight: 36,
                  border:
                    traderTypeFilter === opt.value
                      ? `1px solid ${colorAlpha(tokens.colors.accent.primary, 50)}`
                      : `1px solid transparent`,
                  background:
                    traderTypeFilter === opt.value
                      ? `${colorAlpha(tokens.colors.accent.primary, 8)}`
                      : 'transparent',
                  color:
                    traderTypeFilter === opt.value
                      ? tokens.colors.accent.primary
                      : tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: traderTypeFilter === opt.value ? 700 : 500,
                  cursor: 'pointer',
                  transition: `all ${tokens.transition.fast}`,
                }}
              >
                {opt.value === 'bot' && <span style={{ marginRight: 2 }}>{'⚡'}</span>}
                {opt.label}
              </button>
            ))}
          </Box>
        )}

        {/* Tool buttons */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[1],
            flexShrink: 0,
            marginLeft: 'auto',
          }}
        >
          {/* Row density toggle (1.4) — segmented comfortable / compact */}
          {density && onDensityChange && (
            <Box className="view-toggle-group" role="group" aria-label={t('rowDensity')}>
              <button
                type="button"
                className={`view-toggle-btn${density === 'comfortable' ? ' view-toggle-active' : ''}`}
                aria-pressed={density === 'comfortable'}
                aria-label={t('densityComfortable')}
                title={t('densityComfortable')}
                onClick={() => onDensityChange('comfortable')}
              >
                <svg
                  width={12}
                  height={12}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <rect x="2.5" y="3" width="11" height="4" rx="1" />
                  <rect x="2.5" y="9" width="11" height="4" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                className={`view-toggle-btn${density === 'compact' ? ' view-toggle-active' : ''}`}
                aria-pressed={density === 'compact'}
                aria-label={t('densityCompact')}
                title={t('densityCompact')}
                onClick={() => onDensityChange('compact')}
              >
                <svg
                  width={12}
                  height={12}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <line x1="2.5" y1="4" x2="13.5" y2="4" />
                  <line x1="2.5" y1="8" x2="13.5" y2="8" />
                  <line x1="2.5" y1="12" x2="13.5" y2="12" />
                </svg>
              </button>
            </Box>
          )}

          {/* Filter toggle */}
          <Box
            data-filter-toggle
            onClick={onFilterToggle}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onFilterToggle()
              }
            }}
            title={t('advancedFilter')}
            aria-label={t('advancedFilter')}
            aria-expanded={filterOpen}
            role="button"
            tabIndex={0}
            className={`toolbar-btn touch-target-sm${filterOpen || hasActiveFilters ? ' toolbar-btn-active' : ''}`}
            style={{ position: 'relative', gap: 4 }}
          >
            <FilterIcon size={11} />
            <span>{t('filter')}</span>
            {activeFilterCount > 0 && (
              <span
                style={{
                  // eslint-disable-next-line no-restricted-syntax -- off-scale by design (10px count badge)
                  fontSize: 10,
                  fontWeight: tokens.typography.fontWeight.bold,
                  lineHeight: 1,
                  padding: '1px 5px',
                  borderRadius: tokens.radius.full,
                  background: tokens.colors.accent.primary,
                  color: 'var(--color-on-accent)',
                  minWidth: 16,
                  textAlign: 'center',
                }}
              >
                {activeFilterCount}
              </span>
            )}
          </Box>

          {/* Compare */}
          <Link
            href="/compare"
            prefetch={false}
            title={t('compareTraders')}
            className="toolbar-btn touch-target-sm"
            style={{ gap: 4 }}
          >
            <CompareIcon size={11} />
            <span>{t('compare')}</span>
            {!isPro && !BETA_PRO_FEATURES_FREE && <LockIconSmall size={7} />}
            {BETA_PRO_FEATURES_FREE && (
              <span
                style={{
                  // eslint-disable-next-line no-restricted-syntax -- off-scale by design (8px Pro micro-badge)
                  fontSize: 8,
                  fontWeight: tokens.typography.fontWeight.bold,
                  padding: '1px 4px',
                  // eslint-disable-next-line no-restricted-syntax -- off-scale by design (4px radius on micro-badge; nearest token is 2px off)
                  borderRadius: 4,
                  background:
                    'color-mix(in srgb, var(--color-pro-gradient-start) 20%, transparent)',
                  color: 'var(--color-pro-gradient-start)',
                  border:
                    '1px solid color-mix(in srgb, var(--color-pro-gradient-start) 40%, transparent)',
                  whiteSpace: 'nowrap',
                  lineHeight: 1.4,
                }}
              >
                Pro
              </span>
            )}
          </Link>

          {/* Column settings */}
          <div ref={columnSettingsRef} style={{ position: 'relative' }}>
            <Box
              onClick={() => onShowColumnSettings(!showColumnSettings)}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onShowColumnSettings(!showColumnSettings)
                }
              }}
              title={t('columnSettingsTitle')}
              aria-label={t('columnSettingsTitle')}
              aria-expanded={showColumnSettings}
              role="button"
              tabIndex={0}
              className={`toolbar-btn touch-target-sm${showColumnSettings ? ' toolbar-btn-active' : ''}`}
            >
              <SettingsIcon size={11} />
            </Box>
            {showColumnSettings && (
              <Box
                className="dropdown-enter"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: tokens.spacing[1],
                  padding: tokens.spacing[3],
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  borderRadius: tokens.radius.lg,
                  boxShadow: tokens.shadow.lg,
                  zIndex: tokens.zIndex.max,
                  minWidth: 160,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('columnSettingsTitle')}
                </Text>
                {ALL_TOGGLEABLE_COLUMNS.map((col) => (
                  <label
                    key={col}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[2],
                      padding: `${tokens.spacing[1]} 0`,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                      color: tokens.colors.text.primary,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={visibleColumns.includes(col)}
                      onChange={() => onToggleColumn(col)}
                      style={{ cursor: 'pointer' }}
                    />
                    {localizedLabel(COLUMN_LABELS[col].zh, COLUMN_LABELS[col].en, language)}
                  </label>
                ))}
                <button
                  onClick={onResetColumns}
                  style={{
                    marginTop: tokens.spacing[2],
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.accent.primary,
                    background: 'transparent',
                    border: `1px solid ${colorAlpha(tokens.colors.accent.primary, 25)}`,
                    borderRadius: tokens.radius.sm,
                    cursor: 'pointer',
                    width: '100%',
                  }}
                >
                  {t('resetToDefault')}
                </button>
              </Box>
            )}
          </div>

          {/* Export */}
          {traders.length > 0 &&
            (isPro ? (
              <ExportRankingButton
                traders={traders}
                source={source}
                timeRange={timeRange}
                language={language}
              />
            ) : (
              <button
                onClick={() => onProRequired?.()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  borderRadius: tokens.radius.sm,
                  border: '1px solid var(--color-border-primary)',
                  background: 'transparent',
                  color: 'var(--color-text-tertiary)',
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.medium,
                  cursor: 'pointer',
                  opacity: 0.7,
                }}
                title={t('proFeature')}
              >
                <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3Z" />
                </svg>
                {t('exportRankingShort')}
              </button>
            ))}
        </Box>
      </Box>

      {/* Expandable filter panel */}
      {filterOpen && (
        <div
          ref={filterPanelRef}
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: '1px solid var(--glass-border-light)',
            background: 'var(--color-bg-secondary)',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[3],
          }}
        >
          {/* Style filter */}
          {hasStyleData && (
            <div>
              <Text
                size="xs"
                weight="bold"
                color="tertiary"
                style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}
              >
                {t('rankingStyleLabel')}
              </Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <FilterChip
                  active={styleFilter === 'all'}
                  label={t('rankingStyleAll')}
                  count={traders.length}
                  onClick={() => handleStyleChange('all')}
                />
                {getFilterableStyles().map((s) => {
                  const n = styleCounts[s.style] || 0
                  return (
                    <FilterChip
                      key={s.style}
                      active={styleFilter === s.style}
                      label={localizedLabel(s.label, s.labelEn, language)}
                      count={n}
                      disabled={n === 0 && styleFilter !== s.style}
                      onClick={() => handleStyleChange(s.style)}
                    />
                  )
                })}
              </div>
            </div>
          )}

          {/* Score grade filter */}
          <div>
            <Text
              size="xs"
              weight="bold"
              color="tertiary"
              style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}
            >
              {t('scoreLabel')}
            </Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <FilterChip
                active={scoreGradeFilter === 'all'}
                label={t('rankingStyleAll')}
                count={traders.length}
                onClick={() => handleScoreChange('all')}
              />
              {SCORE_TIERS.map((tier) => {
                const n = scoreCounts[tier.value]
                return (
                  <FilterChip
                    key={tier.value}
                    active={scoreGradeFilter === tier.value}
                    label={`${tier.value} ${tier.range}`}
                    color={tier.color}
                    count={n}
                    disabled={n === 0 && scoreGradeFilter !== tier.value}
                    onClick={() => handleScoreChange(tier.value)}
                  />
                )
              })}
            </div>
          </div>

          {/* Clear all */}
          {(styleFilter !== 'all' || scoreGradeFilter !== 'all') && (
            <button
              onClick={() => {
                handleStyleChange('all')
                handleScoreChange('all')
              }}
              style={{
                alignSelf: 'flex-start',
                padding: '4px 12px',
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.semibold,
                color: tokens.colors.accent.error,
                background: 'transparent',
                border: `1px solid ${colorAlpha(tokens.colors.accent.error, 25)}`,
                borderRadius: tokens.radius.sm,
                cursor: 'pointer',
              }}
            >
              {t('clearAll') || 'Clear All'}
            </button>
          )}
        </div>
      )}
    </>
  )
}
