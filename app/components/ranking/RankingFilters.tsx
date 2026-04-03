'use client'

import { localizedLabel } from '@/lib/utils/format'
import React, { useRef, useEffect } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useToast } from '../ui/Toast'
import CategoryRankingTabs, { type CategoryType } from './CategoryRankingTabs'
import { ProLabel } from '../premium/PremiumGate'
import {
  FilterIcon, CompareIcon, TableViewIcon, CardViewIcon, SettingsIcon, LockIconSmall,
} from './Icons'
import type { ColumnKey, ViewMode } from './RankingTable'
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
        <div style={{
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
  // View mode
  viewMode: ViewMode
  onToggleViewMode: (mode: ViewMode) => void
  onResetViewModeToAuto: () => void
  hasManualViewMode: boolean
  // Filter
  onFilterToggle?: () => void
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
  // Trader type filter (human/bot/all)
  traderTypeFilter?: 'all' | 'human' | 'bot'
  onTraderTypeFilterChange?: (type: 'all' | 'human' | 'bot') => void
  // Export
  traders: ExportRankingButtonProps['traders']
  source?: string
  timeRange?: string
}

/**
 * RankingFilters — toolbar with category tabs, view toggle, filters, column settings, export
 */
export function RankingFilters({
  category, onCategoryChange, isPro, onProRequired,
  viewMode, onToggleViewMode, onResetViewModeToAuto, hasManualViewMode,
  onFilterToggle, hasActiveFilters,
  visibleColumns, showColumnSettings, onShowColumnSettings, onToggleColumn, onResetColumns,
  styleFilter, onStyleFilterChange, hasStyleData,
  traderTypeFilter = 'all', onTraderTypeFilterChange,
  traders, source, timeRange,
}: RankingFiltersProps) {
  const { t, language } = useLanguage()
  const columnSettingsRef = useRef<HTMLDivElement>(null)

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

  return (
    <>
      {/* Category tabs row */}
      <Box className="ranking-toolbar-row" style={{
        padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: tokens.spacing[2],
        borderBottom: '1px solid var(--glass-border-light)',
        background: tokens.glass.bg.light,
        borderRadius: 0, flexWrap: 'wrap',
      }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
            <Text size="xs" weight="bold" color="secondary">{t('categoryType')}</Text>
            <ProLabel size="xs" />
          </Box>
          <CategoryRankingTabs
            currentCategory={category}
            onCategoryChange={onCategoryChange}
            isPro={isPro}
            onProRequired={onProRequired}
          />
        </Box>

        {/* Tool buttons */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
          {/* View toggle */}
          <Box className="view-toggle-group">
            <button onClick={() => onToggleViewMode('table')} title={t('tableView')} aria-label={t('tableView')} aria-pressed={viewMode === 'table'} className={`view-toggle-btn touch-target-sm${viewMode === 'table' ? ' view-toggle-active' : ''}`}>
              <TableViewIcon size={12} />
            </button>
            <button onClick={() => onToggleViewMode('card')} title={t('cardView')} aria-label={t('cardView')} aria-pressed={viewMode === 'card'} className={`view-toggle-btn touch-target-sm${viewMode === 'card' ? ' view-toggle-active' : ''}`}>
              <CardViewIcon size={12} />
            </button>
            {hasManualViewMode && (
              <button onClick={onResetViewModeToAuto} title={t('resetAutoLayout')} className="view-toggle-btn touch-target-sm" style={{ fontSize: tokens.typography.fontSize.xs, opacity: 0.6 }}>
                Auto
              </button>
            )}
          </Box>

          {/* Filter button */}
          <Box onClick={onFilterToggle} title={t('advancedFilter')} aria-label={t('advancedFilter')} role="button" tabIndex={0}
            className={`toolbar-btn touch-target-sm${hasActiveFilters ? ' toolbar-btn-active' : ''}`}
            style={{ position: 'relative', gap: 4 }}
          >
            <FilterIcon size={11} />
            <span>{t('filter')}</span>
            {!isPro && <LockIconSmall size={7} />}
            {BETA_PRO_FEATURES_FREE && (
              <span style={{
                fontSize: 8, fontWeight: 700, padding: '1px 4px', borderRadius: 4,
                background: 'color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 20%, transparent)',
                color: 'var(--color-pro-gradient-start, #a78bfa)',
                border: '1px solid color-mix(in srgb, var(--color-pro-gradient-start, #a78bfa) 40%, transparent)',
                whiteSpace: 'nowrap', lineHeight: 1.4,
              }}>Pro</span>
            )}
            {hasActiveFilters && (
              <Box style={{ position: 'absolute', top: 2, right: 2, width: 4, height: 4, borderRadius: '50%', background: tokens.colors.accent.primary }} />
            )}
          </Box>

          {/* Compare button */}
          <Link href="/compare" prefetch={false} title={t('compareTraders')} className="toolbar-btn touch-target-sm" style={{ gap: 4 }}>
            <CompareIcon size={11} />
            <span>{t('compare')}</span>
            {!isPro && <LockIconSmall size={7} />}
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
            <Box onClick={() => onShowColumnSettings(!showColumnSettings)} title={t('columnSettingsTitle')} aria-label={t('columnSettingsTitle')} aria-expanded={showColumnSettings} role="button" tabIndex={0}
              className={`toolbar-btn touch-target-sm${showColumnSettings ? ' toolbar-btn-active' : ''}`}>
              <SettingsIcon size={11} />
            </Box>
            {showColumnSettings && (
              <Box style={{
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

      {/* Trader type filter row (human/bot/all) */}
      {onTraderTypeFilterChange && (
        <Box style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[1],
          padding: `${tokens.spacing[1]} ${tokens.spacing[4]}`,
          borderBottom: '1px solid var(--glass-border-light)',
          flexWrap: 'wrap', background: tokens.glass.bg.light, minHeight: 44,
        }}>
          <Text size="xs" weight="bold" color="tertiary" style={{ flexShrink: 0 }}>
            {t('traderTypeFilter')}:
          </Text>
          {([
            { value: 'all' as const, label: t('allTraderTypes') },
            { value: 'human' as const, label: t('isHuman') },
            { value: 'bot' as const, label: t('isBot') },
          ]).map(opt => (
            <button
              key={opt.value}
              onClick={() => onTraderTypeFilterChange(opt.value)}
              style={{
                padding: '6px 12px', borderRadius: tokens.radius.lg, minHeight: 36,
                border: traderTypeFilter === opt.value
                  ? `1px solid ${tokens.colors.accent.primary}80`
                  : `1px solid ${tokens.colors.border.primary}`,
                background: traderTypeFilter === opt.value ? `${tokens.colors.accent.primary}20` : 'transparent',
                color: traderTypeFilter === opt.value ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                fontSize: 12, fontWeight: traderTypeFilter === opt.value ? 700 : 500,
                cursor: 'pointer', transition: `all ${tokens.transition.fast}`,
              }}
            >
              {opt.value === 'bot' && <span style={{ marginRight: 3 }}>{'⚡'}</span>}
              {opt.label}
            </button>
          ))}
        </Box>
      )}

      {/* Inline style filter row */}
      {hasStyleData && (
        <Box style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[1],
          padding: `${tokens.spacing[1]} ${tokens.spacing[4]}`,
          borderBottom: '1px solid var(--glass-border-light)',
          flexWrap: 'wrap', background: tokens.glass.bg.light, minHeight: 44,
        }}>
          <Text size="xs" weight="bold" color="tertiary" style={{ flexShrink: 0 }}>
            {t('rankingStyleLabel')}:
          </Text>
          {[
            { value: 'all' as const, label: t('rankingStyleAll') },
            ...getFilterableStyles().map(s => ({ value: s.style, label: localizedLabel(s.label, s.labelEn, language) })),
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => onStyleFilterChange(opt.value)}
              style={{
                padding: '6px 12px', borderRadius: tokens.radius.lg, minHeight: 36,
                border: styleFilter === opt.value
                  ? `1px solid ${tokens.colors.accent.primary}80`
                  : `1px solid ${tokens.colors.border.primary}`,
                background: styleFilter === opt.value ? `${tokens.colors.accent.primary}20` : 'transparent',
                color: styleFilter === opt.value ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                fontSize: 12, fontWeight: styleFilter === opt.value ? 700 : 500,
                cursor: 'pointer', transition: `all ${tokens.transition.fast}`,
              }}
            >
              {opt.label}
            </button>
          ))}
          <Box style={{ width: 1, height: 16, background: tokens.colors.border.primary, margin: `0 ${tokens.spacing[1]}` }} />
        </Box>
      )}
    </>
  )
}
