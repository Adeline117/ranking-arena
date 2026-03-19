'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import type { Trader } from '../ranking/RankingTableTypes'
import type { TimeRange } from './hooks/useTraderData'

// Dynamic import RankingTable — it's 674 lines + pulls in TraderRow, TraderCard, etc.
// SSR table is shown in-place as fallback until this loads (zero CLS)
const RankingTable = dynamic(() => import('../ranking/RankingTable').then(m => ({ default: m.RankingTable })), {
  ssr: false,
})

// Above-fold: keep eager
import TimeRangeSelector from './TimeRangeSelector'
import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from './useRankingFilters'

// Below-fold / non-critical: dynamic import to reduce initial JS bundle
const AdvancedFilterPanel = dynamic(() => import('./AdvancedFilterPanel'), { ssr: false })
const FilterStatusMessages = dynamic(() => import('./FilterStatusMessages'), { ssr: false })
const ProUpgradeCTA = dynamic(() => import('./ProUpgradeCTA'), { ssr: false })
const RankingFooter = dynamic(() => import('./RankingFooter'), { ssr: false })

const LeaderboardChangelog = dynamic(() => import('../ranking/LeaderboardChangelog'), { ssr: false })

interface RankingSectionProps {
  traders: Trader[]
  loading: boolean
  isLoggedIn: boolean
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  /** 数据最后更新时间 */
  lastUpdated?: string | null
  /** 错误信息 */
  error?: string | null
  /** 重试回调 */
  onRetry?: () => void
  /** Feature 4: Manual refresh callback */
  onRefresh?: () => void
  /** 所有可用的数据来源 */
  availableSources?: string[]
  /** SSR table to show while RankingTable loads */
  ssrTable?: React.ReactNode
}

/**
 * 排行榜区域组件
 * 包含时间选择器和排行榜表格
 */
export default function RankingSection({
  traders,
  loading,
  isLoggedIn,
  activeTimeRange,
  onTimeRangeChange,
  lastUpdated,
  error,
  onRetry,
  onRefresh,
  ssrTable,
}: RankingSectionProps) {
  const {
    language,
    t,
    isPro,
    premiumLoading,
    category,
    setCategory,
    showAdvancedFilter,
    showMobileFilter,
    setShowMobileFilter,
    filterConfig,
    savedFilters,
    hasActiveFilters,
    selectedExchange,
    sortColumn,
    sortDir,
    currentPage,
    searchQuery,
    source,
    advancedFiltered,
    filteredTraders,
    handleFilterChange,
    handleSortChange,
    handlePageChange,
    handleSearchChange,
    handleSaveFilter,
    handleLoadFilter,
    handleDeleteFilter,
    handleProRequired,
    handleCopyLink,
    handleResetFilters,
    handleFilterToggle,
    formatLastUpdated,
    router,
  } = useRankingFilters({ traders, activeTimeRange })

  // Track whether client RankingTable has loaded (to hide SSR fallback in-place)
  const [tableReady, setTableReady] = useState(false)
  useEffect(() => {
    // Once filteredTraders has data and we haven't set ready yet, mark ready
    // This fires after RankingTable dynamic import resolves and renders
    if (filteredTraders.length > 0 && !tableReady) {
      setTableReady(true)
    }
  }, [filteredTraders, tableReady])

  // Leaderboard movers (risers/fallers) — deferred until browser is idle to reduce TBT
  const [movers, setMovers] = useState<{ risers: Array<{ platform: string; trader_key: string; rank: number; arena_score: number | null; roiDelta: number; handle: string | null; avatar_url: string | null }>; fallers: Array<{ platform: string; trader_key: string; rank: number; arena_score: number | null; roiDelta: number; handle: string | null; avatar_url: string | null }> }>({ risers: [], fallers: [] })
  useEffect(() => {
    const doFetch = () => {
      fetch('/api/rankings/movers')
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.risers || data?.fallers) setMovers({ risers: data.risers || [], fallers: data.fallers || [] }) })
        .catch(() => {})
    }
    // Defer movers fetch — it's below-fold, non-critical data
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(doFetch, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    } else {
      const id = setTimeout(doFetch, 2000)
      return () => clearTimeout(id)
    }
  }, [])

  return (
    <section
      className="home-ranking-section contain-layout-style"
      style={{ minWidth: 0 }}
    >
      {/* Time range selector (7D / 30D / 90D) */}
      <div className="ranking-time-range-bar">
        <TimeRangeSelector
          activeRange={activeTimeRange}
          onChange={onTimeRangeChange}
          disabled={loading}
        />
      </div>

      <AdvancedFilterPanel
        showAdvancedFilter={showAdvancedFilter}
        showMobileFilter={showMobileFilter}
        onCloseMobileFilter={() => setShowMobileFilter(false)}
        filterConfig={filterConfig}
        savedFilters={savedFilters}
        onFilterChange={handleFilterChange}
        onSaveFilter={handleSaveFilter}
        onLoadFilter={handleLoadFilter}
        onDeleteFilter={handleDeleteFilter}
        hasActiveFilters={hasActiveFilters}
        isPro={isPro}
      />

      <FilterStatusMessages
        loading={loading}
        language={language}
        selectedExchange={selectedExchange}
        advancedFilteredCount={advancedFiltered.length}
        tradersCount={traders.length}
        hasActiveFilters={hasActiveFilters}
        onResetFilters={handleResetFilters}
      />

      {/* Show SSR table in-place until client RankingTable loads — zero CLS */}
      {!tableReady && ssrTable}
      <RankingTable
        traders={filteredTraders}
        loading={loading || premiumLoading}
        loggedIn={isLoggedIn}
        source={source}
        timeRange={activeTimeRange}
        isPro={isPro}
        category={category}
        onCategoryChange={setCategory}
        onProRequired={handleProRequired}
        onFilterToggle={handleFilterToggle}
        hasActiveFilters={hasActiveFilters}
        error={error}
        onRetry={onRetry}
        controlledSortColumn={sortColumn}
        controlledSortDir={sortDir}
        controlledPage={currentPage}
        controlledSearchQuery={searchQuery}
        onSortChange={handleSortChange}
        onPageChange={handlePageChange}
        onSearchChange={handleSearchChange}
      />

      {/* Leaderboard movers — risers & fallers (below fold, minimal CLS impact) */}
      <div className="contain-layout-style">
        {(movers.risers.length > 0 || movers.fallers.length > 0) && (
          <div style={{ marginTop: 16, marginBottom: 16 }}>
            <LeaderboardChangelog risers={movers.risers} fallers={movers.fallers} />
          </div>
        )}
      </div>

      {/* ProUpgradeCTA — reserve space to prevent CLS when it appears */}
      <div className="contain-layout-style" style={{ minHeight: !isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT ? undefined : 0 }}>
        {!isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT && (
          <ProUpgradeCTA
            language={language}
            t={t}
            freeLimit={FREE_LEADERBOARD_LIMIT}
            onUpgrade={() => router.push('/pricing')}
          />
        )}
      </div>

      <RankingFooter
        loading={loading}
        lastUpdated={lastUpdated}
        formatLastUpdated={formatLastUpdated}
        t={t}
      />
    </section>
  )
}
