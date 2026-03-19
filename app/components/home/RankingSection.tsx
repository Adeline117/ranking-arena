'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Box } from '../base'
import { RankingTable, type Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'

import AdvancedFilterPanel from './AdvancedFilterPanel'
import FilterStatusMessages from './FilterStatusMessages'
import ProUpgradeCTA from './ProUpgradeCTA'
import RankingFooter from './RankingFooter'
import TimeRangeSelector from './TimeRangeSelector'
import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from './useRankingFilters'

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

  // Leaderboard movers (risers/fallers)
  const [movers, setMovers] = useState<{ risers: Array<{ platform: string; trader_key: string; rank: number; arena_score: number | null; rankChange: number; handle: string | null; avatar_url: string | null }>; fallers: Array<{ platform: string; trader_key: string; rank: number; arena_score: number | null; rankChange: number; handle: string | null; avatar_url: string | null }> }>({ risers: [], fallers: [] })
  useEffect(() => {
    fetch('/api/rankings/movers')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.risers || data?.fallers) setMovers({ risers: data.risers || [], fallers: data.fallers || [] }) })
      .catch(() => {})
  }, [])

  return (
    <Box
      as="section"
      className="home-ranking-section"
      style={{
        minWidth: 0,
        contain: 'layout style',
      }}
    >
      {/* Time range selector (7D / 30D / 90D) */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 8, minHeight: 48 }}>
        <TimeRangeSelector
          activeRange={activeTimeRange}
          onChange={onTimeRangeChange}
          disabled={loading}
        />
      </Box>

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
      <div style={{ contain: 'layout style' }}>
        {(movers.risers.length > 0 || movers.fallers.length > 0) && (
          <Box style={{ marginTop: 16, marginBottom: 16 }}>
            <LeaderboardChangelog risers={movers.risers} fallers={movers.fallers} />
          </Box>
        )}
      </div>

      {/* ProUpgradeCTA — reserve space to prevent CLS when it appears */}
      <div style={{ minHeight: !isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT ? undefined : 0, contain: 'layout style' }}>
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
    </Box>
  )
}
