'use client'

import React, { useState, useEffect, useRef, memo, useMemo, useCallback, useTransition } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { RankingSkeleton } from '../ui/Skeleton'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import dynamic from 'next/dynamic'
import { TraderRow } from './TraderRow'
import { TraderCard } from './TraderCard'
import { AvatarPreload } from '../ui/AvatarPreload'
import type { Trader, ColumnKey } from './RankingTable'
import { VirtualLeaderboard } from './VirtualLeaderboard'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getMedalGlowClass, parseSourceInfo as parseSourceInfoUtil, getPnLTooltip } from './utils'

// Lazy load non-critical components
const Pagination = dynamic(() => import('../ui/Pagination'), { ssr: false })

interface OptimizedRankingTableProps {
  traders: Trader[]
  loading: boolean
  error?: string | null
  onRetry?: () => void
  viewMode: 'table' | 'card'
  searchQuery?: string
  sortColumn: 'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha'
  sortDir: 'asc' | 'desc'
  onSort: (column: 'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha') => void
  currentPage: number
  onPageChange: (page: number) => void
  itemsPerPage: number
  enableVirtualScroll?: boolean
  visibleColumns: ColumnKey[]
  onSearchChange?: (query: string) => void
  timeRange?: string
  source?: string
}

// Memoized TraderRow to prevent unnecessary re-renders
const MemoizedTraderRow = memo(TraderRow, (prev, next) => {
  // Deep comparison for trader object and other props
  return (
    prev.trader.id === next.trader.id &&
    prev.trader.roi === next.trader.roi &&
    prev.trader.arena_score === next.trader.arena_score &&
    prev.trader.pnl === next.trader.pnl &&
    prev.trader.win_rate === next.trader.win_rate &&
    prev.trader.max_drawdown === next.trader.max_drawdown &&
    prev.rank === next.rank &&
    prev.searchQuery === next.searchQuery
  )
})
MemoizedTraderRow.displayName = 'MemoizedTraderRow'

// Memoized TraderCard with similar optimization
const MemoizedTraderCard = memo(TraderCard, (prev, next) => {
  return (
    prev.trader.id === next.trader.id &&
    prev.trader.roi === next.trader.roi &&
    prev.trader.arena_score === next.trader.arena_score &&
    prev.trader.pnl === next.trader.pnl &&
    prev.trader.win_rate === next.trader.win_rate &&
    prev.trader.max_drawdown === next.trader.max_drawdown &&
    prev.rank === next.rank &&
    prev.searchQuery === next.searchQuery
  )
})
MemoizedTraderCard.displayName = 'MemoizedTraderCard'

// Virtual row component for table mode
const VirtualTableRow = memo<{
  index: number
  trader: Trader
  rank: number
  searchQuery?: string
  source?: string
}>(({ index, trader, rank, searchQuery, source }) => {
  // CSS containment for performance
  const style: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '100%',
    contain: 'layout style paint',
    willChange: 'transform',
  }
  
  return (
    <div style={style}>
      <MemoizedTraderRow
        trader={trader}
        rank={rank}
        searchQuery={searchQuery}
        language="en"
        source={source}
        getMedalGlowClass={getMedalGlowClass}
        parseSourceInfo={(src: string) => parseSourceInfoUtil(src, (k: string) => k)}
        getPnLTooltipFn={getPnLTooltip}
      />
    </div>
  )
})
VirtualTableRow.displayName = 'VirtualTableRow'

export default function OptimizedRankingTable({
  traders,
  loading,
  error,
  onRetry,
  viewMode,
  searchQuery = '',
  sortColumn,
  sortDir,
  onSort,
  currentPage,
  onPageChange,
  itemsPerPage = 50,
  enableVirtualScroll = true,
  visibleColumns,
  onSearchChange,
  timeRange,
  source,
}: OptimizedRankingTableProps) {
  const { t } = useLanguage()
  const [isPending, startTransition] = useTransition()
  const parentRef = useRef<HTMLDivElement>(null)

  // Debounced search query to reduce re-renders
  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 150)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Memoized filtered and sorted traders
  const sortedTraders = useMemo(() => {
    let data = [...traders]
    
    // Apply search filter
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim().toLowerCase()
      data = data.filter(t => {
        const handle = (t.handle || t.id || '').toLowerCase()
        return handle.includes(q) || t.id.toLowerCase().includes(q)
      })
    }

    // Apply sorting
    return data.sort((a, b) => {
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

  // Virtual scrolling setup
  const rowVirtualizer = useVirtualizer({
    count: sortedTraders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72, // Estimated row height
    overscan: 5,
    enabled: enableVirtualScroll && viewMode === 'table' && sortedTraders.length > 20,
  })

  // Pagination for non-virtual mode
  const totalPages = Math.ceil(sortedTraders.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedTraders = enableVirtualScroll ? sortedTraders : sortedTraders.slice(startIndex, endIndex)

  const handleSort = useCallback((column: typeof sortColumn) => {
    startTransition(() => {
      onSort(column)
    })
  }, [onSort])

  const handlePaginationChange = useCallback((page: number) => {
    startTransition(() => {
      onPageChange(page)
    })
  }, [onPageChange])

  // CSS grid template for desktop layout
  const desktopGridTemplate = useMemo(() => {
    const columns = ['60px', '1fr'] // rank, trader info
    if (visibleColumns.includes('score')) columns.push('120px')
    if (visibleColumns.includes('roi')) columns.push('100px')
    if (visibleColumns.includes('winrate')) columns.push('80px')
    if (visibleColumns.includes('mdd')) columns.push('80px')
    return columns.join(' ')
  }, [visibleColumns])

  if (loading) {
    return <RankingSkeleton />
  }

  if (error) {
    return (
      <Box style={{ padding: `${tokens.spacing[10]} ${tokens.spacing[4]}`, textAlign: 'center' }}>
        <Text size="md" color="secondary">{error}</Text>
        {onRetry && (
          <button onClick={onRetry} style={{
            padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
            background: `${tokens.colors.accent.primary}20`,
            border: `1px solid ${tokens.colors.accent.primary}40`,
            borderRadius: tokens.radius.md,
            color: tokens.colors.accent.primary,
            cursor: 'pointer',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.bold,
            transition: `all ${tokens.transition.base}`,
            marginTop: tokens.spacing[3],
          }}>
            {t('retry')}
          </button>
        )}
      </Box>
    )
  }

  if (sortedTraders.length === 0) {
    return (
      <Box style={{ padding: `${tokens.spacing[12]} ${tokens.spacing[4]}`, textAlign: 'center' }}>
        <Text size="md" weight="semibold" color="secondary">
          {debouncedSearch.trim() ? t('noMatchingTraders') : t('noTraderData')}
        </Text>
      </Box>
    )
  }

  return (
    <>
      {/* Preload top trader avatars for better LCP */}
      <AvatarPreload
        avatarUrls={sortedTraders.slice(0, 10).map(t => t.avatar_url)}
        maxPreload={10}
      />

      <Box
        className="glass-card ranking-table-container"
        style={{
          boxShadow: `${tokens.shadow.lg}, 0 0 0 1px var(--glass-border-light)`,
          overflow: 'hidden',
          background: tokens.glass.bg.secondary,
          backdropFilter: tokens.glass.blur.lg,
          WebkitBackdropFilter: tokens.glass.blur.lg,
          border: tokens.glass.border.light,
          borderRadius: tokens.radius.xl,
          contain: 'layout style paint', // CSS containment
        }}
      >
        {/* Dynamic CSS for grid layout */}
        <style>{`
          @media (min-width: 768px) {
            .ranking-table-grid-optimized {
              display: grid;
              grid-template-columns: ${desktopGridTemplate};
              gap: ${tokens.spacing[2]};
              align-items: center;
              padding: ${tokens.spacing[3]} ${tokens.spacing[4]};
            }
          }
        `}</style>

        {viewMode === 'card' ? (
          // Card view with CSS grid optimization
          <Box style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
            gap: tokens.spacing[3],
            padding: tokens.spacing[4],
            contain: 'layout style',
          }}>
            {paginatedTraders.map((trader, idx) => {
              const rank = enableVirtualScroll ? idx + 1 : startIndex + idx + 1
              return (
                <MemoizedTraderCard
                  key={`${trader.id}-${trader.source || 'unknown'}`}
                  trader={trader}
                  rank={rank}
                  source={source}
                  language="en"
                  searchQuery={debouncedSearch}
                  getMedalGlowClass={getMedalGlowClass}
                  parseSourceInfo={(src: string) => parseSourceInfoUtil(src, (k: string) => k)}
                />
              )
            })}
          </Box>
        ) : enableVirtualScroll && sortedTraders.length > 20 ? (
          // Virtual scrolling table for large datasets
          <Box
            ref={parentRef}
            style={{
              height: 600, // Fixed height for virtual scrolling
              overflow: 'auto',
              contain: 'strict',
            }}
          >
            <div style={{
              height: rowVirtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}>
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const trader = sortedTraders[virtualItem.index]
                const rank = virtualItem.index + 1
                
                return (
                  <div
                    key={virtualItem.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                      contain: 'layout style paint',
                    }}
                  >
                    <VirtualTableRow
                      index={virtualItem.index}
                      trader={trader}
                      rank={rank}
                      searchQuery={debouncedSearch}
                      source={source}
                    />
                  </div>
                )
              })}
            </div>
          </Box>
        ) : (
          // Standard table view for smaller datasets
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {isPending && (
              <Box style={{
                position: 'absolute',
                inset: 0,
                zIndex: 10,
                background: 'var(--color-overlay-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backdropFilter: 'blur(1px)',
              }}>
                <div className="spinner" />
              </Box>
            )}
            
            {paginatedTraders.map((trader, idx) => {
              const rank = startIndex + idx + 1
              return (
                <MemoizedTraderRow
                  key={`${trader.id}-${trader.source || 'unknown'}`}
                  trader={trader}
                  rank={rank}
                  searchQuery={debouncedSearch}
                  language="en"
                  source={source}
                  getMedalGlowClass={getMedalGlowClass}
                  parseSourceInfo={(src: string) => parseSourceInfoUtil(src, (k: string) => k)}
                  getPnLTooltipFn={getPnLTooltip}
                />
              )
            })}
          </Box>
        )}

        {/* Pagination for non-virtual mode */}
        {!enableVirtualScroll && totalPages > 1 && (
          <Box style={{ 
            padding: tokens.spacing[4], 
            borderTop: `1px solid var(--glass-border-light)`,
            contain: 'layout style',
          }}>
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={handlePaginationChange}
            />
          </Box>
        )}
      </Box>
    </>
  )
}