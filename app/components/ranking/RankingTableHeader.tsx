'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { SortIndicator } from './Icons'
import type { ColumnKey, SortColumn, SortDir } from './RankingTableTypes'

interface RankingTableHeaderProps {
  visibleColumns: ColumnKey[]
  sortColumn: SortColumn
  sortDir: SortDir
  justSortedColumn: string | null
  onSort: (col: SortColumn) => void
  showRules: boolean
  onToggleRules: () => void
  hasCategories: boolean
  timeRange: string
}

export function RankingTableHeader({
  visibleColumns,
  sortColumn,
  sortDir,
  justSortedColumn,
  onSort,
  showRules,
  onToggleRules,
  hasCategories,
  timeRange,
}: RankingTableHeaderProps) {
  const { t } = useLanguage()

  return (
    <Box className="ranking-table-header ranking-table-grid ranking-table-grid-custom"
      style={{ display: 'grid', gap: tokens.spacing[2], padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`, borderBottom: `1px solid var(--glass-border-light)`, background: hasCategories ? 'var(--color-bg-secondary)' : tokens.glass.bg.light, borderRadius: hasCategories ? '0' : `${tokens.radius.xl} ${tokens.radius.xl} 0 0`, position: 'sticky', top: 0, zIndex: 20, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', transform: 'translateZ(0)' }}>
      <Text size="xs" weight="bold" color="tertiary" style={{ textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.8px', whiteSpace: 'nowrap', fontSize: tokens.typography.fontSize.xs }}>{t('rank')}</Text>
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase', letterSpacing: '0.8px', whiteSpace: 'nowrap', fontSize: tokens.typography.fontSize.xs }}>{t('trader')}</Text>
        <button onClick={onToggleRules}
          className="info-btn-circle"
          title={t('rankingRules')}
          aria-label={t('rankingRules')}
          aria-expanded={showRules}
        >?</button>
      </Box>
      <Box className={`col-score sort-header sort-header-center${sortColumn === 'score' ? ' sort-header-active' : ''} ${justSortedColumn === 'score' ? 'just-sorted' : ''}`} as="button" onClick={() => onSort('score')} aria-sort={sortColumn === 'score' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}
      >
        {t('score')}
        <span
          title={t('arenaScoreHeaderTooltip') || "Arena's composite performance score (0-100)"}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 13,
            height: 13,
            borderRadius: '50%',
            border: `1px solid var(--color-text-tertiary)`,
            fontSize: 9,
            fontWeight: 700,
            color: 'var(--color-text-tertiary)',
            lineHeight: 1,
            cursor: 'help',
            flexShrink: 0,
            opacity: 0.65,
            fontStyle: 'normal',
          }}
          aria-label={t('arenaScoreHeaderTooltip') || "Arena's composite performance score (0-100)"}
        >
          i
        </span>
        <SortIndicator active={sortColumn === 'score'} dir={sortDir} />
      </Box>
      <Box className={`roi-cell sort-header sort-header-end${sortColumn === 'roi' ? ' sort-header-active' : ''} ${justSortedColumn === 'roi' ? 'just-sorted' : ''}`} as="button" onClick={() => onSort('roi')} title={t('roiTooltip').replace('{range}', timeRange)} aria-sort={sortColumn === 'roi' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
        {t('roi')} <SortIndicator active={sortColumn === 'roi'} dir={sortDir} />
      </Box>
      <Box className={`col-winrate sort-header sort-header-end${sortColumn === 'winrate' ? ' sort-header-active' : ''} ${justSortedColumn === 'winrate' ? 'just-sorted' : ''}`} as="button" onClick={() => onSort('winrate')} title={t('winRateTooltip')} aria-sort={sortColumn === 'winrate' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
        {t('winRateShort')} <SortIndicator active={sortColumn === 'winrate'} dir={sortDir} />
      </Box>
      <Box className={`col-mdd sort-header sort-header-end${sortColumn === 'mdd' ? ' sort-header-active' : ''} ${justSortedColumn === 'mdd' ? 'just-sorted' : ''}`} as="button" onClick={() => onSort('mdd')} title={t('mddTooltip')} aria-sort={sortColumn === 'mdd' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} data-sortable>
        {t('maxDrawdownShort')} <SortIndicator active={sortColumn === 'mdd'} dir={sortDir} />
      </Box>
      {visibleColumns.includes('sortino') && (
        <Box className={`col-sortino sort-header sort-header-end${sortColumn === 'sortino' ? ' sort-header-active' : ''} ${justSortedColumn === 'sortino' ? 'just-sorted' : ''}`} as="button" onClick={() => onSort('sortino')} title={t('sortinoTooltip') || 'Sortino Ratio'} data-sortable>
          {t('sortinoRatio')} <SortIndicator active={sortColumn === 'sortino'} dir={sortDir} />
        </Box>
      )}
      {visibleColumns.includes('alpha') && (
        <Box className={`col-alpha sort-header sort-header-end${sortColumn === 'alpha' ? ' sort-header-active' : ''} ${justSortedColumn === 'alpha' ? 'just-sorted' : ''}`} as="button" onClick={() => onSort('alpha')} title={t('alphaTooltip') || 'Alpha (excess return)'} data-sortable>
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
  )
}
