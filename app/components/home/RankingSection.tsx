'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { apiFetch } from '@/lib/utils/api-fetch'
import type { Trader } from '../ranking/RankingTableTypes'
import type { TimeRange } from './hooks/useTraderData'
import type { CategoryCounts } from '@/lib/getInitialTraders'

// Static import — RankingTable is LCP-critical. Dynamic import created a secondary
// chunk waterfall: HomePage.js loads → then RankingTable.js loads → blank gap → CLS.
// Bundling it with HomePage eliminates the gap.
import { RankingTable } from '../ranking/RankingTable'

import TimeRangeSelector from './TimeRangeSelector'
import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from './useRankingFilters'
import CategoryRankingTabs from '../ranking/CategoryRankingTabs'

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
  lastUpdated?: string | null
  error?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  availableSources?: string[]
  totalCount?: number
  categoryCounts?: CategoryCounts
  fetchPage?: (page: number, opts?: { category?: string; sortBy?: string; sortDir?: string }) => Promise<void>
  lastRefreshFailed?: boolean
}

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
  totalCount,
  categoryCounts,
  fetchPage,
  lastRefreshFailed,
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
    handleCopyLink: _handleCopyLink,
    handleResetFilters,
    handleFilterToggle,
    formatLastUpdated,
    router,
  } = useRankingFilters({ traders, activeTimeRange, totalCount, categoryCounts, fetchPage })

  // Leaderboard movers
  const [movers, setMovers] = useState<{ risers: Array<{ platform: string; trader_key: string; rank: number; arena_score: number | null; roiDelta: number; handle: string | null; avatar_url: string | null }>; fallers: Array<{ platform: string; trader_key: string; rank: number; arena_score: number | null; roiDelta: number; handle: string | null; avatar_url: string | null }> }>({ risers: [], fallers: [] })
  useEffect(() => {
    const doFetch = () => {
      apiFetch<{ risers?: typeof movers.risers; fallers?: typeof movers.fallers }>('/api/rankings/movers')
        .then(data => { if (data?.risers || data?.fallers) setMovers({ risers: data.risers || [], fallers: data.fallers || [] }) })
        .catch((err) => { if (err instanceof Error && err.name === 'AbortError') return; console.warn('[RankingSection] movers fetch failed:', err) })
    }
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(doFetch, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    } else {
      const id = setTimeout(doFetch, 2000)
      return () => clearTimeout(id)
    }
  }, [])

  return (
    <section className="home-ranking-section contain-layout-style" style={{ minWidth: 0 }}>
      {/* Period + Category tabs in one row */}
      <div className="ranking-controls-bar" style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 8,
        minHeight: 48,
        flexWrap: 'wrap',
      }}>
        <TimeRangeSelector activeRange={activeTimeRange} onChange={onTimeRangeChange} />
        <div style={{ width: 1, height: 24, background: 'var(--color-border-primary)', flexShrink: 0 }} />
        <CategoryRankingTabs
          currentCategory={category}
          onCategoryChange={setCategory}
          isPro={isPro}
          onProRequired={handleProRequired}
          categoryCounts={categoryCounts}
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
        tradersCount={totalCount || traders.length}
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
        serverTotalCount={totalCount}
        categoryCounts={categoryCounts}
      />

      <div className="contain-layout-style">
        {(movers.risers.length > 0 || movers.fallers.length > 0) && (
          <div style={{ marginTop: 16, marginBottom: 16 }}>
            <LeaderboardChangelog risers={movers.risers} fallers={movers.fallers} />
          </div>
        )}
      </div>

      <div className="contain-layout-style" style={{ minHeight: !isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT ? undefined : 0 }}>
        {!isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT && (
          <ProUpgradeCTA language={language} t={t} freeLimit={FREE_LEADERBOARD_LIMIT} onUpgrade={() => router.push('/pricing')} />
        )}
      </div>

      <RankingFooter loading={loading} lastUpdated={lastUpdated} formatLastUpdated={formatLastUpdated} t={t} onRefresh={onRefresh} lastRefreshFailed={lastRefreshFailed} />
    </section>
  )
}
