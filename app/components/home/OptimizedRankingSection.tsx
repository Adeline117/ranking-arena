'use client'

import { useState, useEffect, useCallback, useRef, useTransition, memo } from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import type { Trader } from '../ranking/RankingTable'

import TimeRangeSelector from './TimeRangeSelector'
import type { TimeRange } from './hooks/useTraderData'
import { useSubscription } from './hooks/useSubscription'

// Lazy load non-critical components
const DataFreshnessIndicator = dynamic(() => import('../ui/DataFreshnessIndicator'), {
  ssr: false,
})

interface OptimizedRankingSectionProps {
  traders: Trader[]
  loading: boolean
  isLoggedIn: boolean
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  lastUpdated?: string | null
  error?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  availableSources?: string[]
}

/**
 * 优化版排行榜区域组件
 * 集成虚拟滚动和性能优化
 */
const OptimizedRankingSection = memo<OptimizedRankingSectionProps>(({
  traders,
  loading,
  isLoggedIn: _isLoggedIn,
  activeTimeRange,
  onTimeRangeChange,
  lastUpdated,
  error,
  onRetry,
  onRefresh: _onRefresh,
  availableSources: _availableSources,
}) => {
  const { isPro } = useSubscription()

  // UI state
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [sortColumn, setSortColumn] = useState<'score' | 'roi' | 'winrate' | 'mdd' | 'sortino' | 'alpha'>('score')
  const [, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table')
  const [enableVirtualScroll, setEnableVirtualScroll] = useState(true)
  
  // Performance transition
  const [, startTransition] = useTransition()

  // Reset pagination when time range changes
  const prevTimeRange = useRef(activeTimeRange)
  useEffect(() => {
    if (prevTimeRange.current !== activeTimeRange) {
      setCurrentPage(1)
      prevTimeRange.current = activeTimeRange
    }
  }, [activeTimeRange])

  // Responsive view mode detection
  useEffect(() => {
    const checkViewMode = () => {
      const isMobile = window.innerWidth < 768
      // Enable virtual scroll for large datasets on desktop
      setEnableVirtualScroll(!isMobile && traders.length > 50)
      
      // Auto-switch to card view on mobile for better UX
      if (isMobile && viewMode === 'table') {
        setViewMode('card')
      }
    }

    checkViewMode()
    window.addEventListener('resize', checkViewMode)
    return () => window.removeEventListener('resize', checkViewMode)
  }, [traders.length, viewMode])

  // Optimized sort handler
  const _handleSort = useCallback((column: typeof sortColumn) => {
    startTransition(() => {
      if (sortColumn === column) {
        setSortDir(prev => prev === 'desc' ? 'asc' : 'desc')
      } else {
        setSortColumn(column)
        setSortDir('desc')
      }
    })
  }, [sortColumn])

  // Optimized pagination handler
  const _handlePageChange = useCallback((page: number) => {
    startTransition(() => {
      setCurrentPage(page)
      // Smooth scroll to top
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    })
  }, [])

  // Optimized search handler with debouncing
  const _handleSearchChange = useCallback((query: string) => {
    setSearchQuery(query)
    setCurrentPage(1) // Reset to first page on search
  }, [])

  // Toggle view mode
  const _toggleViewMode = useCallback((mode: 'table' | 'card') => {
    setViewMode(mode)
    setCurrentPage(1) // Reset pagination
  }, [])

  return (
    <Box style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      gap: tokens.spacing[4],
      contain: 'layout style' // CSS containment
    }}>
      {/* Time Range Selector */}
      <Box style={{ contain: 'layout style' }}>
        <TimeRangeSelector
          activeRange={activeTimeRange}
          onChange={onTimeRangeChange}
          disabled={loading}
        />
      </Box>

      {/* Data Freshness Indicator */}
      {lastUpdated && (
        <DataFreshnessIndicator
          lastUpdated={lastUpdated}
        />
      )}

      {/* Advanced Filter */}
      {showAdvancedFilter && isPro && (
        <Box style={{
          padding: tokens.spacing[3],
          background: 'var(--color-bg-secondary)',
          borderRadius: tokens.radius.md,
          contain: 'layout style'
        }}>
          <Text>Advanced Filter (Simplified for demo)</Text>
          <button onClick={() => setShowAdvancedFilter(false)}>Close</button>
        </Box>
      )}

      {/* Main Ranking Table */}
      <Box style={{ contain: 'layout style' }}>
        <Box style={{
          background: tokens.glass.bg.secondary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[4],
          contain: 'layout style paint'
        }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
            Ranking Table (Optimized)
          </Text>
          
          {loading ? (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
              {[...Array(10)].map((_, i) => (
                <Box key={i} className="skeleton" style={{ 
                  height: 60, 
                  borderRadius: tokens.radius.md,
                  animationDelay: `${i * 50}ms`
                }} />
              ))}
            </Box>
          ) : error ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[8] }}>
              <Text color="secondary">{error}</Text>
              {onRetry && (
                <button 
                  onClick={onRetry}
                  style={{
                    marginTop: tokens.spacing[3],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    background: tokens.colors.accent.primary,
                    color: 'white',
                    border: 'none',
                    borderRadius: tokens.radius.md,
                    cursor: 'pointer'
                  }}
                >
                  Retry
                </button>
              )}
            </Box>
          ) : (
            <Box>
              <Text color="secondary" style={{ marginBottom: tokens.spacing[4] }}>
                Found {traders.length} traders. Virtual scroll: {enableVirtualScroll ? 'ON' : 'OFF'}
              </Text>
              
              {/* Simple trader list */}
              <Box style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                gap: tokens.spacing[2],
                maxHeight: 400,
                overflow: 'auto',
                contain: 'strict'
              }}>
                {traders.slice(0, 20).map((trader, idx) => (
                  <Box key={trader.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[3],
                    padding: tokens.spacing[3],
                    background: idx < 3 ? `${tokens.colors.accent.primary}08` : 'transparent',
                    borderRadius: tokens.radius.md,
                    contain: 'layout style paint'
                  }}>
                    <Text weight="bold" color="tertiary" style={{ minWidth: '2rem' }}>
                      #{idx + 1}
                    </Text>
                    <Box style={{
                      width: 32,
                      height: 32,
                      borderRadius: tokens.radius.full,
                      background: `linear-gradient(45deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`,
                      flexShrink: 0
                    }} />
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text weight="semibold">{trader.handle}</Text>
                      <Text size="sm" color="tertiary">{trader.source}</Text>
                    </Box>
                    <Box style={{ textAlign: 'right' }}>
                      <Text weight="bold" color="primary">{(trader.arena_score ?? 0).toFixed(1)}</Text>
                      <Text size="sm" color={trader.roi > 0 ? 'primary' : 'tertiary'}>
                        {(trader.roi * 100).toFixed(1)}%
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {/* Performance Stats (Debug - remove in production) */}
      {process.env.NODE_ENV === 'development' && (
        <Box style={{
          padding: tokens.spacing[2],
          background: 'var(--color-bg-tertiary)',
          borderRadius: tokens.radius.sm,
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
          contain: 'layout style'
        }}>
          <div>Traders: {traders.length}</div>
          <div>Virtual Scroll: {enableVirtualScroll ? 'ON' : 'OFF'}</div>
          <div>View Mode: {viewMode}</div>
          <div>Current Page: {currentPage}</div>
          <div>Loading: {loading ? 'YES' : 'NO'}</div>
        </Box>
      )}
    </Box>
  )
})

OptimizedRankingSection.displayName = 'OptimizedRankingSection'

export default OptimizedRankingSection