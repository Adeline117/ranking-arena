'use client'

import { useState, useEffect, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
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
import CategoryRankingTabs, { type CategoryType } from '../ranking/CategoryRankingTabs'
import { trackEvent } from '@/lib/analytics/track'

const AdvancedFilterPanel = dynamic(() => import('./AdvancedFilterPanel'), { ssr: false })
const FilterStatusMessages = dynamic(() => import('./FilterStatusMessages'), { ssr: false })
const ProGate = dynamic(() => import('../ui/ProGate'), { ssr: false })
const ProUpsellModal = dynamic(
  () => import('../ui/ProGate').then((m) => ({ default: m.ProUpsellModal })),
  { ssr: false }
)
const RankingFooter = dynamic(() => import('./RankingFooter'), { ssr: false })
const LeaderboardChangelog = dynamic(() => import('../ranking/LeaderboardChangelog'), {
  ssr: false,
})

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
  totalCount?: number
  categoryCounts?: CategoryCounts
  fetchPage?: (
    page: number,
    opts?: { category?: string; sortBy?: string; sortDir?: string }
  ) => Promise<void>
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
  categoryCounts,
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
  } = useRankingFilters({ traders, activeTimeRange, totalCount, categoryCounts, fetchPage })

  // Unified paywall: callback-style gates (locked tabs, export) open the
  // shared upsell modal instead of a dead-end toast.
  const [proUpsellOpen, setProUpsellOpen] = useState(false)
  const onProRequired = useCallback(() => {
    handleProRequired() // tracking only
    setProUpsellOpen(true)
  }, [handleProRequired])

  // Leaderboard movers
  const [movers, setMovers] = useState<{
    risers: Array<{
      platform: string
      trader_key: string
      rank: number
      arena_score: number | null
      roiDelta: number
      handle: string | null
      avatar_url: string | null
    }>
    fallers: Array<{
      platform: string
      trader_key: string
      rank: number
      arena_score: number | null
      roiDelta: number
      handle: string | null
      avatar_url: string | null
    }>
  }>({ risers: [], fallers: [] })
  useEffect(() => {
    const doFetch = () => {
      apiFetch<{ risers?: typeof movers.risers; fallers?: typeof movers.fallers }>(
        '/api/rankings/movers'
      )
        .then((data) => {
          if (data?.risers || data?.fallers)
            setMovers({ risers: data.risers || [], fallers: data.fallers || [] })
        })
        .catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') return
          console.warn('[RankingSection] movers fetch failed:', err)
        })
    }
    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(doFetch, { timeout: 5000 })
      return () => cancelIdleCallback(id)
    } else {
      const id = setTimeout(doFetch, 2000)
      return () => clearTimeout(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

      {!loading && !premiumLoading && error && filteredTraders.length === 0 && (
        <div
          style={{
            padding: tokens.spacing[6],
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          <div style={{ marginBottom: 8, color: 'var(--color-error, #e53935)' }}>
            {t('failedToLoadRankings')}
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>{error}</div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="tap-target"
              style={{
                padding: '8px 20px',
                borderRadius: 6,
                border: '1px solid var(--color-border-primary)',
                background: 'var(--color-accent-primary)',
                color: '#fff',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {t('retry')}
            </button>
          )}
        </div>
      )}

      {!loading && !premiumLoading && filteredTraders.length === 0 && !error && (
        <div
          style={{
            padding: tokens.spacing[6],
            textAlign: 'center',
            color: tokens.colors.text.tertiary,
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          {hasActiveFilters ? t('noTradersMatchFilters') : t('failedToLoadRankings')}
          {hasActiveFilters ? (
            <button
              onClick={handleResetFilters}
              className="tap-target"
              style={{
                margin: '12px auto 0',
                padding: '6px 16px',
                borderRadius: 6,
                border: '1px solid var(--color-border-primary)',
                background: 'transparent',
                color: 'var(--color-accent-primary)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {t('resetFilters')}
            </button>
          ) : (
            onRetry && (
              // Unfiltered + loaded + empty = the fetch came back empty (a soft
              // failure). Offer a real retry instead of telling the user to
              // "refresh shortly" (which read as if it were still loading).
              <button
                onClick={onRetry}
                className="tap-target"
                style={{
                  display: 'block',
                  margin: '12px auto 0',
                  padding: '8px 20px',
                  borderRadius: 6,
                  border: '1px solid var(--color-border-primary)',
                  background: 'var(--color-accent-primary)',
                  color: '#fff',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {t('retry')}
              </button>
            )
          )}
        </div>
      )}

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
        categoryCounts={categoryCounts}
      />

      <div className="contain-layout-style">
        {(movers.risers.length > 0 || movers.fallers.length > 0) && (
          <div style={{ marginTop: 16, marginBottom: 16 }}>
            <LeaderboardChangelog risers={movers.risers} fallers={movers.fallers} />
          </div>
        )}
      </div>

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
