'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { PortfolioItem, PositionHistoryItem } from '@/lib/data/trader'
import type { ExtendedPositionHistoryItem } from './portfolio-table-utils'
import PortfolioTableHeader from './PortfolioTableHeader'
import PortfolioCurrentView from './PortfolioCurrentView'
import PositionHistoryView from './PositionHistoryView'
import MarketDetailDrawer from './MarketDetailDrawer'

interface PortfolioTableProps {
  items: PortfolioItem[]
  history?: (PositionHistoryItem | ExtendedPositionHistoryItem)[]
  isPro?: boolean
  onUnlock?: () => void
}

type ViewMode = 'current' | 'history'

/**
 * Portfolio页面 - 显示当前持仓和历史仓位
 * 现代化设计，流畅动画
 */
export default function PortfolioTable({ items, history = [], isPro = true, onUnlock: _onUnlock }: PortfolioTableProps) {
  const { t } = useLanguage()
  const [viewMode, setViewMode] = useState<ViewMode>('current')
  const [selectedMarket, setSelectedMarket] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'openTime' | 'closeTime' | 'pnl'>('openTime')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [mounted, setMounted] = useState(false)
  const [hoveredRow, setHoveredRow] = useState<number | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)

  // 默认只显示3条，展开后显示全部
  const COLLAPSED_COUNT = 3

  useEffect(() => {
    setMounted(true)
  }, [])

  // 排序历史记录
  const sortedHistory = [...history].sort((a, b) => {
    let aValue: number, bValue: number

    if (sortBy === 'pnl') {
      aValue = a.pnlPct || 0
      bValue = b.pnlPct || 0
    } else if (sortBy === 'closeTime') {
      aValue = a.closeTime ? new Date(a.closeTime).getTime() : 0
      bValue = b.closeTime ? new Date(b.closeTime).getTime() : 0
    } else {
      aValue = a.openTime ? new Date(a.openTime).getTime() : 0
      bValue = b.openTime ? new Date(b.openTime).getTime() : 0
    }

    return sortOrder === 'desc' ? bValue - aValue : aValue - bValue
  })

  // 检查是否有扩展字段
  const hasExtendedFields = history.some(item =>
    'positionType' in item || 'maxPositionSize' in item || 'pnlUsd' in item
  )

  // Empty state when no current positions and no history
  if (items.length === 0 && history.length === 0) {
    return (
      <Box
        className="portfolio-table glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          padding: `${tokens.spacing[8]} ${tokens.spacing[6]}`,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[3],
        }}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, color: tokens.colors.text.tertiary }}>
          <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
          <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
          <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
        </svg>
        <Text size="sm" weight="bold" color="secondary">{t('noOpenPositions')}</Text>
        <Text size="xs" color="tertiary">{t('noPositionHistoryDesc')}</Text>
      </Box>
    )
  }

  return (
    <>
      <Box
        className="portfolio-table glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          overflow: 'hidden',
          boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(20px)',
          transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
          position: 'relative',
        }}
      >
        {/* Pro Lock Overlay — PortfolioProLock removed in cleanup */}

        {/* Header */}
        <PortfolioTableHeader viewMode={viewMode} onViewModeChange={setViewMode} />

        {/* Content */}
        <Box style={{ padding: tokens.spacing[5], filter: isPro ? 'none' : 'blur(3px)', pointerEvents: isPro ? 'auto' : 'none' }}>
          {viewMode === 'current' ? (
            <PortfolioCurrentView
              items={items}
              hoveredRow={hoveredRow}
              selectedMarket={selectedMarket}
              onHoverRow={setHoveredRow}
              onSelectMarket={setSelectedMarket}
            />
          ) : (
            <PositionHistoryView
              sortedHistory={sortedHistory}
              hasExtendedFields={hasExtendedFields}
              sortBy={sortBy}
              sortOrder={sortOrder}
              historyExpanded={historyExpanded}
              hoveredRow={hoveredRow}
              collapsedCount={COLLAPSED_COUNT}
              onSortByChange={setSortBy}
              onSortOrderToggle={() => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc')}
              onHistoryExpandedToggle={() => setHistoryExpanded(!historyExpanded)}
              onHoverRow={setHoveredRow}
            />
          )}
        </Box>
      </Box>

      {/* Market Detail Drawer */}
      {selectedMarket && (
        <MarketDetailDrawer
          selectedMarket={selectedMarket}
          onClose={() => setSelectedMarket(null)}
        />
      )}
    </>
  )
}
