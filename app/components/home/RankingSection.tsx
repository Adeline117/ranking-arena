'use client'

import { useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import type { Trader } from '../ranking/RankingTableTypes'
import type { TimeRange } from './hooks/useTraderData'
import type { CategoryCounts } from '@/lib/getInitialTraders'

// Static import — RankingTable is LCP-critical. Dynamic import created a secondary
// chunk waterfall: HomePage.js loads → then RankingTable.js loads → blank gap → CLS.
// Bundling it with HomePage eliminates the gap.
import { RankingTable } from '../ranking/RankingTable'

import TimeRangeSelector from './TimeRangeSelector'
import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from './useRankingFilters'
import CategoryRankingTabs, { type CategoryType } from '../ranking/CategoryRankingTabs'
import { trackEvent } from '@/lib/analytics/track'
import ExchangeScopeNotice from './ExchangeScopeNotice'
import SearchElsewhereMatches from './SearchElsewhereMatches'

const AdvancedFilterPanel = dynamic(() => import('./AdvancedFilterPanel'), { ssr: false })
const FilterStatusMessages = dynamic(() => import('./FilterStatusMessages'), { ssr: false })
const ProGate = dynamic(() => import('../ui/ProGate'), { ssr: false })
const ProUpsellModal = dynamic(
  () => import('../ui/ProGate').then((m) => ({ default: m.ProUpsellModal })),
  { ssr: false }
)
const RankingFooter = dynamic(() => import('./RankingFooter'), { ssr: false })

interface RankingSectionProps {
  traders: Trader[]
  loading: boolean
  /** Background refresh (period switch / poll) with rows still visible — dims table, shows header spinner. */
  isRefreshing?: boolean
  isLoggedIn: boolean
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  lastUpdated?: string | null
  error?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  availableSources?: string[]
  totalCount?: number | null
  totalCountIsExact?: boolean
  hasMore?: boolean
  categoryCounts?: CategoryCounts
  categoryCountsAreExact?: boolean
  /** Zero-based page paired with the SSR trader snapshot. */
  initialPageIndex?: number
  /** A direct URL requested a cohort the SSR reader does not implement. */
  requiresInitialCohortFetch?: boolean
  /** Incremented by the parent to retry a failed direct-link cohort. */
  initialCohortAttempt?: number
  /** Prevents target UI labels/rows until that initial client request succeeds. */
  onInitialCohortSettled?: (succeeded: boolean) => void
  fetchPage?: (
    page: number,
    opts?: { category?: string; sortBy?: string; sortDir?: string; exchange?: string }
  ) => Promise<boolean>
  lastRefreshFailed?: boolean
  staleDataWarning?: boolean
  /** Source-watermark freshness from the shared 48-hour server contract. */
  isStale?: boolean
}

export default function RankingSection({
  traders,
  loading,
  isRefreshing = false,
  isLoggedIn,
  activeTimeRange,
  onTimeRangeChange,
  lastUpdated,
  error,
  onRetry,
  onRefresh,
  totalCount,
  totalCountIsExact,
  hasMore,
  categoryCounts,
  categoryCountsAreExact,
  initialPageIndex,
  requiresInitialCohortFetch,
  initialCohortAttempt,
  onInitialCohortSettled,
  fetchPage,
  lastRefreshFailed,
  staleDataWarning,
  isStale = false,
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
    clearExchange,
    sortColumn,
    sortDir,
    currentPage,
    searchQuery,
    source,
    advancedFiltered,
    filteredTraders,
    searchMatchesElsewhere,
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
  } = useRankingFilters({
    traders,
    activeTimeRange,
    totalCount,
    categoryCounts,
    initialPageIndex,
    requiresInitialCohortFetch,
    initialCohortAttempt,
    onInitialCohortSettled,
    fetchPage,
  })

  // Unified paywall: callback-style gates (locked tabs, export) open the
  // shared upsell modal instead of a dead-end toast.
  const [proUpsellOpen, setProUpsellOpen] = useState(false)
  const onProRequired = useCallback(() => {
    handleProRequired() // tracking only
    setProUpsellOpen(true)
  }, [handleProRequired])

  const handleCategoryChange = useCallback(
    (nextCategory: CategoryType) => {
      trackEvent('ranking_filter', { kind: 'category', value: nextCategory })
      setCategory(nextCategory)
    },
    [setCategory]
  )

  return (
    <section className="home-ranking-section contain-layout-style" style={{ minWidth: 0 }}>
      {/* Period + Category tabs in one row */}
      <div
        className="ranking-controls-bar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
          minHeight: 48,
          flexWrap: 'wrap',
        }}
      >
        <TimeRangeSelector activeRange={activeTimeRange} onChange={onTimeRangeChange} />
        {isRefreshing && (
          <span
            role="status"
            aria-live="polite"
            style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-accent-primary)"
              strokeWidth="2.5"
              style={{ animation: 'spin 1s linear infinite' }}
            >
              <circle cx="12" cy="12" r="10" opacity={0.25} />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
            <span className="sr-only">{t('refreshing')}</span>
          </span>
        )}
        <div
          style={{ width: 1, height: 24, background: 'var(--color-border-primary)', flexShrink: 0 }}
        />
        <CategoryRankingTabs
          currentCategory={category}
          onCategoryChange={handleCategoryChange}
          isPro={isPro}
          onProRequired={onProRequired}
          categoryCounts={categoryCounts}
          categoryCountsAreExact={categoryCountsAreExact}
        />
      </div>

      <ExchangeScopeNotice exchange={selectedExchange} onClear={clearExchange} />

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
        tradersCount={totalCountIsExact === true ? totalCount : null}
        hasActiveFilters={hasActiveFilters}
        onResetFilters={handleResetFilters}
      />

      {staleDataWarning && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: 8,
            borderRadius: 6,
            background: 'var(--color-warning-bg, rgba(255, 180, 0, 0.1))',
            color: 'var(--color-warning-text, #b8860b)',
            fontSize: 13,
            lineHeight: 1.4,
          }}
        >
          {t('staleDataRecovering')}
        </div>
      )}

      <SearchElsewhereMatches traders={searchMatchesElsewhere} />

      {/* Error + empty states are rendered once, by RankingTable (it was
          previously duplicated here, producing two messages / two retry
          buttons and contradictory stale copy). */}
      <RankingTable
        traders={filteredTraders}
        loading={loading || premiumLoading}
        isRefreshing={isRefreshing}
        loggedIn={isLoggedIn}
        source={source}
        timeRange={activeTimeRange}
        isPro={isPro}
        category={category}
        onCategoryChange={handleCategoryChange}
        onProRequired={onProRequired}
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
        totalCountIsExact={totalCountIsExact}
        hasMore={hasMore}
        categoryCounts={categoryCounts}
        categoryCountsAreExact={categoryCountsAreExact}
        isStale={isStale}
        onResetFilters={handleResetFilters}
      />

      <div
        className="contain-layout-style"
        style={{
          minHeight:
            !isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT ? undefined : 0,
        }}
      >
        {!isPro && !loading && advancedFiltered.length > FREE_LEADERBOARD_LIMIT && (
          <ProGate
            variant="inline"
            description={t('showingTopFreeLimit').replace(
              '{limit}',
              String(FREE_LEADERBOARD_LIMIT)
            )}
          />
        )}
      </div>

      <ProUpsellModal
        open={proUpsellOpen}
        onClose={() => setProUpsellOpen(false)}
        featureKey="proFilterTooltip"
      />

      <RankingFooter
        loading={loading}
        lastUpdated={lastUpdated}
        formatLastUpdated={formatLastUpdated}
        t={t}
        onRefresh={onRefresh}
        lastRefreshFailed={lastRefreshFailed}
        isStale={isStale}
      />
    </section>
  )
}
