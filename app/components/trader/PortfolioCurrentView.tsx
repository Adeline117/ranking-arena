'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import PortfolioEmptyState from './PortfolioEmptyState'
import { thStyle } from './portfolio-table-utils'
import type { PortfolioItem } from '@/lib/data/trader'

interface PortfolioCurrentViewProps {
  items: PortfolioItem[]
  hoveredRow: number | null
  selectedMarket: string | null
  onHoverRow: (idx: number | null) => void
  onSelectMarket: (market: string | null) => void
}

export default function PortfolioCurrentView({
  items,
  hoveredRow,
  selectedMarket,
  onHoverRow,
  onSelectMarket,
}: PortfolioCurrentViewProps) {
  const { t } = useLanguage()

  if (items.length === 0) {
    return (
      <PortfolioEmptyState
        message={t('noCurrentPositions')}
        subMessage={t('noCurrentPositionsDesc')}
      />
    )
  }

  return (
    <Box className="portfolio-table-scroll" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 320 }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>{t('market')}</th>
            <th style={{ ...thStyle, textAlign: 'left' }}>{t('direction')}</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>{t('weight')}</th>
            <th style={{ ...thStyle, textAlign: 'right' }}>{t('pnl')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr
              key={idx}
              className="portfolio-row"
              style={{
                cursor: 'pointer',
                background: hoveredRow === idx
                  ? `${tokens.colors.accent.primary}08`
                  : (selectedMarket === item.market ? tokens.colors.bg.tertiary : 'transparent'),
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                borderLeft: hoveredRow === idx ? `3px solid ${tokens.colors.accent.primary}` : '3px solid transparent',
              }}
              onClick={() => onSelectMarket(selectedMarket === item.market ? null : item.market)}
              onMouseEnter={() => onHoverRow(idx)}
              onMouseLeave={() => onHoverRow(null)}
            >
              <td style={{ padding: tokens.spacing[4] }}>
                <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                  <CryptoIcon symbol={item.market} size={28} />
                  <Text size="sm" weight="bold" style={{ color: tokens.colors.text.primary }}>
                    {item.market}
                  </Text>
                </Box>
              </td>
              <td style={{ padding: tokens.spacing[4] }}>
                <Box style={{
                  display: 'inline-flex',
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.full,
                  background: item.direction === 'long'
                    ? `linear-gradient(135deg, ${tokens.colors.accent.success}20, ${tokens.colors.accent.success}10)`
                    : `linear-gradient(135deg, ${tokens.colors.accent.error}20, ${tokens.colors.accent.error}10)`,
                  border: `1px solid ${item.direction === 'long' ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
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
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: tokens.spacing[2] }}>
                  <Box
                    style={{
                      width: 60,
                      height: 6,
                      background: tokens.colors.bg.tertiary,
                      borderRadius: tokens.radius.full,
                      overflow: 'hidden',
                    }}
                  >
                    <Box
                      style={{
                        height: '100%',
                        width: `${Number.isFinite(item.invested) ? Math.min(item.invested, 100) : 0}%`,
                        background: `linear-gradient(90deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
                        borderRadius: tokens.radius.full,
                        transition: 'width 0.5s ease',
                      }}
                    />
                  </Box>
                  <Text size="sm" weight="bold" style={{ color: tokens.colors.text.secondary, minWidth: 40, textAlign: 'right' }}>
                    {Number.isFinite(item.invested) ? item.invested.toFixed(1) : '—'}%
                  </Text>
                </Box>
              </td>
              <td style={{ padding: tokens.spacing[4], textAlign: 'right' }}>
                <Text
                  size="sm"
                  weight="black"
                  style={{
                    color: Number.isFinite(item.pnl) ? (item.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : tokens.colors.text.tertiary,
                    fontFamily: tokens.typography.fontFamily.mono.join(', '),
                  }}
                >
                  {Number.isFinite(item.pnl) ? `${item.pnl >= 0 ? '+' : ''}${item.pnl.toFixed(2)}%` : '—'}
                </Text>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  )
}
