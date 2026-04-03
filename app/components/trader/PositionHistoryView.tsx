'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import PortfolioEmptyState from './PortfolioEmptyState'
import PositionHistoryCard from './PositionHistoryCard'
import { thStyle, formatPrice, formatDateTime } from './portfolio-table-utils'
import type { ExtendedPositionHistoryItem } from './portfolio-table-utils'
import type { PositionHistoryItem } from '@/lib/data/trader'

interface PositionHistoryViewProps {
  sortedHistory: (PositionHistoryItem | ExtendedPositionHistoryItem)[]
  hasExtendedFields: boolean
  sortBy: 'openTime' | 'closeTime' | 'pnl'
  sortOrder: 'asc' | 'desc'
  historyExpanded: boolean
  hoveredRow: number | null
  collapsedCount: number
  onSortByChange: (value: 'openTime' | 'closeTime' | 'pnl') => void
  onSortOrderToggle: () => void
  onHistoryExpandedToggle: () => void
  onHoverRow: (idx: number | null) => void
}

export default function PositionHistoryView({
  sortedHistory,
  hasExtendedFields,
  sortBy,
  sortOrder,
  historyExpanded,
  hoveredRow,
  collapsedCount,
  onSortByChange,
  onSortOrderToggle,
  onHistoryExpandedToggle,
  onHoverRow,
}: PositionHistoryViewProps) {
  const { t, language } = useLanguage()

  if (sortedHistory.length === 0) {
    return (
      <PortfolioEmptyState
        message={t('noPositionHistory')}
        subMessage={t('noPositionHistoryDesc')}
      />
    )
  }

  const displayedHistory = historyExpanded ? sortedHistory : sortedHistory.slice(0, collapsedCount)

  return (
    <Box>
      {/* Sort Controls */}
      <Box style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[4],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.lg,
      }}>
        <Text size="xs" color="tertiary">{t('sortBy')}</Text>
        <select
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value as 'openTime' | 'closeTime' | 'pnl')}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.xs,
            cursor: 'pointer',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          <option value="openTime">{t('openTime')}</option>
          <option value="closeTime">{t('closeTime')}</option>
          <option value="pnl">{t('pnl')}</option>
        </select>
        <button
          onClick={onSortOrderToggle}
          style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.primary,
            color: tokens.colors.text.primary,
            fontSize: tokens.typography.fontSize.sm,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {sortOrder === 'desc'
              ? <path d="M12 5v14M5 12l7 7 7-7" />
              : <path d="M12 19V5M5 12l7-7 7 7" />}
          </svg>
          {sortOrder === 'desc' ? t('descending') : t('ascending')}
        </button>
      </Box>

      {/* History List */}
      {hasExtendedFields ? (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {displayedHistory.map((item, idx) => (
            <PositionHistoryCard
              key={idx}
              position={item as ExtendedPositionHistoryItem}
              index={idx}
            />
          ))}
          {sortedHistory.length > collapsedCount && (
            <ExpandCollapseButton
              expanded={historyExpanded}
              totalCount={sortedHistory.length}
              onToggle={onHistoryExpandedToggle}
            />
          )}
        </Box>
      ) : (
        <Box>
          <Box className="portfolio-table-scroll" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, textAlign: 'left' }}>{t('symbol')}</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>{t('direction')}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>{t('entryPrice')}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>{t('exitPrice')}</th>
                  <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer', color: sortBy === 'pnl' ? tokens.colors.accent.primary : undefined }} onClick={() => { onSortByChange('pnl'); if (sortBy === 'pnl') onSortOrderToggle() }}>
                    {t('pnl')} {sortBy === 'pnl' && (sortOrder === 'desc' ? '\u2193' : '\u2191')}
                  </th>
                  <th style={{ ...thStyle, textAlign: 'right', cursor: 'pointer', color: sortBy === 'closeTime' ? tokens.colors.accent.primary : undefined }} onClick={() => { onSortByChange('closeTime'); if (sortBy === 'closeTime') onSortOrderToggle() }}>
                    {t('closeTime')} {sortBy === 'closeTime' && (sortOrder === 'desc' ? '\u2193' : '\u2191')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedHistory.map((item, idx) => (
                  <tr
                    key={idx}
                    className="portfolio-row"
                    style={{
                      background: hoveredRow === 100 + idx ? `${tokens.colors.accent.primary}05` : 'transparent',
                      transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                    onMouseEnter={() => onHoverRow(100 + idx)}
                    onMouseLeave={() => onHoverRow(null)}
                  >
                    <td style={{ padding: tokens.spacing[4] }}>
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                        <CryptoIcon symbol={item.symbol} size={20} />
                        <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                          {item.symbol}
                        </Text>
                      </Box>
                    </td>
                    <td style={{ padding: tokens.spacing[4] }}>
                      <Box style={{
                        display: 'inline-flex',
                        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.full,
                        background: item.direction === 'long' ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
                      }}>
                        <Text size="xs" style={{
                          color: item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error,
                          fontWeight: tokens.typography.fontWeight.bold,
                        }}>
                          {item.direction === 'long' ? t('long') : t('short')}
                        </Text>
                      </Box>
                    </td>
                    <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                      <Text size="sm" style={{ color: tokens.colors.text.secondary, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                        {formatPrice(item.entryPrice)}
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                      <Text size="sm" style={{ color: tokens.colors.text.secondary, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                        {formatPrice(item.exitPrice)}
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                      <Text
                        size="sm"
                        weight="bold"
                        style={{
                          color: item.pnlPct >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
                          fontFamily: tokens.typography.fontFamily.mono.join(', '),
                        }}
                      >
                        {(item.pnlPct ?? 0) >= 0 ? '+' : ''}{(item.pnlPct ?? 0).toFixed(2)}%
                      </Text>
                    </td>
                    <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                        {item.closeTime ? formatDateTime(item.closeTime, language) : '-'}
                      </Text>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
          {sortedHistory.length > collapsedCount && (
            <ExpandCollapseButton
              expanded={historyExpanded}
              totalCount={sortedHistory.length}
              onToggle={onHistoryExpandedToggle}
              style={{ marginTop: tokens.spacing[3] }}
            />
          )}
        </Box>
      )}
    </Box>
  )
}

function ExpandCollapseButton({
  expanded,
  totalCount,
  onToggle,
  style,
}: {
  expanded: boolean
  totalCount: number
  onToggle: () => void
  style?: React.CSSProperties
}) {
  const { t } = useLanguage()

  return (
    <button
      onClick={onToggle}
      style={{
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        background: tokens.colors.bg.tertiary,
        color: tokens.colors.text.secondary,
        fontSize: tokens.typography.fontSize.sm,
        fontWeight: tokens.typography.fontWeight.medium,
        cursor: 'pointer',
        transition: `all ${tokens.transition.base}`,
        fontFamily: tokens.typography.fontFamily.sans.join(', '),
        width: '100%',
        textAlign: 'center',
        ...style,
      }}
    >
      {expanded ? t('collapse') : `${t('expandAll')} (${totalCount})`}
    </button>
  )
}
