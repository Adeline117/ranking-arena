'use client'

import { Box } from '../base'
import { RankingTable, type Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'

import AdvancedFilterPanel from './AdvancedFilterPanel'
import FilterStatusMessages from './FilterStatusMessages'
import ProUpgradeCTA from './ProUpgradeCTA'
import RankingFooter from './RankingFooter'
import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from './useRankingFilters'

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

  return (
    <Box
      as="section"
      className="home-ranking-section"
      style={{
        minWidth: 0,
        contain: 'layout style',
      }}
    >
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

      {!isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT && (
        <ProUpgradeCTA
          language={language}
          t={t}
          freeLimit={FREE_LEADERBOARD_LIMIT}
          onUpgrade={() => router.push('/pricing')}
        />
      )}

      <RankingFooter
        loading={loading}
        lastUpdated={lastUpdated}
        formatLastUpdated={formatLastUpdated}
        t={t}
      />
    </Box>
  )
}
