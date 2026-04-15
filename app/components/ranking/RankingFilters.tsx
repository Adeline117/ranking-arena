'use client'

import { localizedLabel } from '@/lib/utils/format'
import React, { useRef, useEffect } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import { type CategoryType } from './CategoryRankingTabs'
import {
  FilterIcon, CompareIcon, SettingsIcon, LockIconSmall,
} from './Icons'
import type { ColumnKey } from './RankingTable'
import { getFilterableStyles, type TradingStyle } from '@/lib/utils/trading-style'

const ALL_TOGGLEABLE_COLUMNS: ColumnKey[] = ['score', 'roi', 'pnl', 'winrate', 'mdd', 'sharpe', 'followers', 'trades']
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
  { value: 'S' as const, range: '90+', color: 'var(--color-score-legendary, #8b5cf6)' },
  { value: 'A' as const, range: '70-89', color: 'var(--color-score-great, #10b981)' },
  { value: 'B' as const, range: '50-69', color: 'var(--color-score-average, #eab308)' },
  { value: 'C' as const, range: '30-49', color: 'var(--color-score-below, #f97316)' },
  { value: 'D' as const, range: '<30', color: 'var(--color-score-low, #ef4444)' },
]

interface ExportRankingButtonProps {
  traders: { id: string; handle: string | null; source?: string; arena_score?: number; roi: number; pnl?: number | null; win_rate?: number | null; max_drawdown?: number | null; followers: number }[]
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

  const counts = [10, 50, 100].filter(n => n <= traders.length || n === 10)

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setShowMenu(!showMenu)}
        aria-expanded={showMenu}
        aria-haspopup="true"
        aria-label={t('exportRanking')}
        className="export-ranking-btn"
        style={{
          padding: '8px 12px', borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.colors.border.primary}`,
          background: tokens.colors.bg.secondary,
          color: tokens.colors.text.primary,
          fontSize: 12, fontWeight: 600, cursor: 'pointer',
          minHeight: 44, transition: 'all 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
        onMouseLeave={(e) => { e.currentTarget.style.background = tokens.colors.bg.secondary }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="hide-desktop">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="hide-mobile">{t('exportRanking')}</span>
      </button>
      {showMenu && (
        <div className="dropdown-enter" style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 4,
          background: tokens.colors.bg.secondary, border: `1px solid ${tokens.colors.border.primary}`,
          borderRadius: tokens.radius.md, overflow: 'hidden', zIndex: tokens.zIndex.dropdown, minWidth: 160,
          boxShadow: tokens.shadow.md,
        }}>
          <div style={{ padding: '6px 12px', fontSize: 12, color: tokens.colors.text.tertiary, fontWeight: 600 }}>CSV</div>
          {counts.map(n => (
            <button key={`csv-${n}`} onClick={() => doExport(n, 'csv')}
              style={{ display: 'block', width: '100%', padding: '6px 16px', background: 'transparent', border: 'none', color: tokens.colors.text.primary, fontSize: 13, cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >Top {n}</button>
          ))}
          <div style={{ borderTop: `1px solid ${tokens.colors.border.primary}`, margin: '4px 0' }} />
          <div style={{ padding: '6px 12px', fontSize: 12, color: tokens.colors.text.tertiary, fontWeight: 600 }}>JSON</div>
          {counts.map(n => (
            <button key={`json-${n}`} onClick={() => doExport(n, 'json')}
              style={{ display: 'block', width: '100%', padding: '6px 16px', background: 'transparent', border: 'none', color: tokens.colors.text.primary, fontSize: 13, cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={e => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >Top {n}</button>
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
}

/** Pill-style filter chip */
function FilterChip({ active, label, color, onClick }: {
  active: boolean; label: string; color?: string; onClick: () => void
}) {
  const activeColor = color || tokens.colors.accent.primary
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        borderRadius: 20,
        minHeight: 32,
        border: active
          ? `1px solid ${activeColor}`
          : `1px solid ${tokens.colors.border.primary}`,
        background: active ? `color-mix(in srgb, ${activeColor} 15%, transparent)` : 'transparent',
        color: active ? activeColor : tokens.colors.text.secondary,
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        transition: `all ${tokens.transition.fast}`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

/**
 * RankingFilters — toolbar with filter button, compare, column settings, export.
 * Style + Score filters live in the expandable panel triggered by the Filter button.
 */
export function RankingFilters({
  category, onCategoryChange, isPro, onProRequired,
  filterOpen, onFilterToggle, hasActiveFilters,
  visibleColumns, showColumnSettings, onShowColumnSettings, onToggleColumn, onResetColumns,
  styleFilter, onStyleFilterChange, hasStyleData,
  scoreGradeFilter, onScoreGradeFilterChange,
  traderTypeFilter = 'all', onTraderTypeFilterChange,
  traders, source, timeRange, categoryCounts,
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

  const activeFilterCount = (styleFilter !== 'all' ? 1 : 0) + (scoreGradeFilter !== 'all' ? 1 : 0) + (traderTypeFilter !== 'all' ? 1 : 0)

  return (
    <>
      {/* Toolbar row */}
      <Box className="ranking-toolbar-row" style={{
        padding: `6px ${tokens.spacing[4]}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: tokens.spacing[2],
        borderBottom: '1px solid var(--glass-border-light)',
        background: tokens.glass.bg.light,
        borderRadius: 0,
        flexWrap: 'wrap',
      }}>
        {/* Trader type filter — inline */}
        {onTraderTypeFilterChange && (
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {([
              { value: 'all' as const, label: t('allTraderTypes') },
              { value: 'human' as const, label: t('isHuman') },
              { value: 'bot' as const, label: t('isBot') },
            ]).map(opt => (
              <button
                key={opt.value}
                onClick={() => onTraderTypeFilterChange(opt.value)}
                style={{
                  padding: '4px 10px', borderRadius: tokens.radius.lg, minHeight: 32,
                  border: traderTypeFilter === opt.value
                    ? `1px solid ${tokens.colors.accent.primary}80`
                    : `1px solid transparent`,
                  background: traderTypeFilter === opt.value ? `${tokens.colors.accent.primary}15` : 'transparent',
                  color: traderTypeFilter === opt.value ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
                  fontSize: 12, fontWeight: traderTypeFilter === opt.value ? 700 : 500,
                  cursor: 'pointer', transition: `all ${tokens.transition.fast}`,
                }}
              >
                {opt.value === 'bot' && <span style={{ marginRight: 2 }}>{'⚡'}</span>}
                {opt.label}
              </button>
            ))}
          </Box>
        )}

        {/* Tool buttons */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0, marginLeft: 'auto' }}>
          {/* Filter toggle */}
          <Box
            data-filter-toggle
            onClick={onFilterToggle}
            onKeyDown={(e: React.KeyboardEvent) => { if ((e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onFilterToggle() } }}
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
              <span style={{
                fontSize: 10, fontWeight: 700, lineHeight: 1,
                padding: '1px 5px', borderRadius: 8,
                background: tokens.colors.accent.primary,
                color: '#fff',
                minWidth: 16, textAlign: 'center',
              }}>
                {activeFilterCount}
              </span>
            )}
          </Box>

          {/* Compare */}
          <Link href="/compare" prefetch={false} title={t('compareTraders')} className="toolbar-btn touch-target-sm" style={{ gap: 4 }}>
            <CompareIcon size={11} />
            <span>{t('compare')}</span>
            {!isPro && !BETA_PRO_FEATURES_FREE && <LockIconSmall size={7} />}
            {BETA_PRO_FEATURES_FREE && (
              <span style={{
                fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 4,
                background: 'color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 20%, transparent)',
                color: 'var(--color-pro-gradient-start, #a78bfa)',
                border: '1px solid color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 40%, transparent)',
                whiteSpace: 'nowrap', lineHeight: 1.4,
              }}>Pro</span>
            )}
          </Link>

          {/* Column settings */}
          <div ref={columnSettingsRef} style={{ position: 'relative' }}>
            <Box onClick={() => onShowColumnSettings(!showColumnSettings)} onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShowColumnSettings(!showColumnSettings) } }} title={t('columnSettingsTitle')} aria-label={t('columnSettingsTitle')} aria-expanded={showColumnSettings} role="button" tabIndex={0}
              className={`toolbar-btn touch-target-sm${showColumnSettings ? ' toolbar-btn-active' : ''}`}>
              <SettingsIcon size={11} />
            </Box>
            {showColumnSettings && (
              <Box className="dropdown-enter" style={{
                position: 'absolute', top: '100%', right: 0, marginTop: tokens.spacing[1],
                padding: tokens.spacing[3],
                background: tokens.colors.bg.primary, border: `1px solid ${tokens.colors.border.primary}`,
                borderRadius: tokens.radius.lg, boxShadow: tokens.shadow.lg, zIndex: tokens.zIndex.max, minWidth: 160,
              }} onClick={e => e.stopPropagation()}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                  {t('columnSettingsTitle')}
                </Text>
                {ALL_TOGGLEABLE_COLUMNS.map(col => (
                  <label key={col} style={{
                    display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
                    padding: `${tokens.spacing[1]} 0`, cursor: 'pointer',
                    fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.primary,
                  }}>
                    <input type="checkbox" checked={visibleColumns.includes(col)} onChange={() => onToggleColumn(col)} style={{ cursor: 'pointer' }} />
                    {localizedLabel(COLUMN_LABELS[col].zh, COLUMN_LABELS[col].en, language)}
                  </label>
                ))}
                <button onClick={onResetColumns} style={{
                  marginTop: tokens.spacing[2], padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                  fontSize: tokens.typography.fontSize.xs, color: tokens.colors.accent.primary,
                  background: 'transparent', border: `1px solid ${tokens.colors.accent.primary}40`,
                  borderRadius: tokens.radius.sm, cursor: 'pointer', width: '100%',
                }}>
                  {t('resetToDefault')}
                </button>
              </Box>
            )}
          </div>

          {/* Export */}
          {traders.length > 0 && (
            isPro ? (
              <ExportRankingButton traders={traders} source={source} timeRange={timeRange} language={language} />
            ) : (
              <button
                onClick={() => onProRequired?.()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: tokens.radius.sm,
                  border: '1px solid var(--color-border-primary)', background: 'transparent',
                  color: 'var(--color-text-tertiary)', fontSize: 12, fontWeight: 500,
                  cursor: 'pointer', opacity: 0.7,
                }}
                title={t('proFeature')}
              >
                <svg width={10} height={10} viewBox="0 0 24 24" fill="currentColor"><path d="M12 1C8.676 1 6 3.676 6 7V8H4V21H20V8H18V7C18 3.676 15.324 1 12 1ZM12 3C14.276 3 16 4.724 16 7V8H8V7C8 4.724 9.724 3 12 3Z" /></svg>
                {t('exportRankingShort')}
              </button>
            )
          )}
        </Box>
      </Box>

      {/* Expandable filter panel */}
      {filterOpen && (
        <div
          ref={filterPanelRef}
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: '1px solid var(--glass-border-light)',
            background: 'var(--color-bg-secondary, #14121C)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {/* Style filter */}
          {hasStyleData && (
            <div>
              <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('rankingStyleLabel')}
              </Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <FilterChip
                  active={styleFilter === 'all'}
                  label={t('rankingStyleAll')}
                  onClick={() => onStyleFilterChange('all')}
                />
                {getFilterableStyles().map(s => (
                  <FilterChip
                    key={s.style}
                    active={styleFilter === s.style}
                    label={localizedLabel(s.label, s.labelEn, language)}
                    onClick={() => onStyleFilterChange(s.style)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Score grade filter */}
          <div>
            <Text size="xs" weight="bold" color="tertiary" style={{ marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Score
            </Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <FilterChip
                active={scoreGradeFilter === 'all'}
                label={t('rankingStyleAll')}
                onClick={() => onScoreGradeFilterChange('all')}
              />
              {SCORE_TIERS.map(tier => (
                <FilterChip
                  key={tier.value}
                  active={scoreGradeFilter === tier.value}
                  label={`${tier.value} ${tier.range}`}
                  color={tier.color}
                  onClick={() => onScoreGradeFilterChange(tier.value)}
                />
              ))}
            </div>
          </div>

          {/* Clear all */}
          {(styleFilter !== 'all' || scoreGradeFilter !== 'all') && (
            <button
              onClick={() => { onStyleFilterChange('all'); onScoreGradeFilterChange('all') }}
              style={{
                alignSelf: 'flex-start',
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 600,
                color: tokens.colors.accent.error,
                background: 'transparent',
                border: `1px solid ${tokens.colors.accent.error}40`,
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
