'use client'

import { useEffect, useLayoutEffect, useMemo, useCallback, useRef, useState } from 'react'
import RankingSection from './RankingSection'
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData } from './hooks'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader, CategoryCounts } from '@/lib/getInitialTraders'
import type { Trader } from '../ranking/RankingTable'
import { trackEvent } from '@/lib/analytics/track'

interface HomePageClientProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  initialIsStale?: boolean
  initialTotalCount?: number | null
  initialTotalCountIsExact?: boolean
  initialHasMore?: boolean
  initialCategoryCounts?: CategoryCounts
  initialCategoryCountsAreExact?: boolean
  /** Server-resolved range for the SSR snapshot. */
  initialTimeRange?: TimeRange
  /** Zero-based page index for the SSR snapshot. */
  initialPageIndex?: number
  /** URL state needs a matching client cohort before SSR rows may be replaced. */
  initialClientCohortPending?: boolean
}

function hasPersistedExchangeCohort(): boolean {
  // HomePageClient is loaded through the client-only Phase 2 boundary, so a
  // synchronous preference read here cannot create an SSR hydration mismatch.
  // It lets us keep default SSR rows neutral while a saved exchange scope is
  // fetched instead of briefly relabelling the all-exchange cohort.
  try {
    // Stored preferences are allowed to choose the clean landing page only.
    // A share/deep link is already a complete cohort statement; layering a
    // local exchange over `?range=30D&page=3` would make its URL lie about
    // the rows being shown and make copied/reloaded links non-reproducible.
    return (
      typeof window !== 'undefined' &&
      window.location.pathname === '/' &&
      window.location.search === '' &&
      Boolean(localStorage.getItem('ranking-exchange'))
    )
  } catch {
    return false
  }
}

/**
 * 首页客户端组件
 * 处理交互状态和数据同步
 * Server-side pagination: SSR provides first page + totalCount.
 * Client fetches subsequent pages from /api/traders on demand.
 */
export default function HomePageClient({
  initialTraders,
  initialLastUpdated,
  initialIsStale,
  initialTotalCount,
  initialTotalCountIsExact,
  initialHasMore,
  initialCategoryCounts,
  initialCategoryCountsAreExact,
  initialTimeRange,
  initialPageIndex,
  initialClientCohortPending = false,
}: HomePageClientProps) {
  const { isLoggedIn } = useAuthSession()
  const { t } = useLanguage()
  const [requiresInitialClientCohort] = useState(
    () => initialClientCohortPending || hasPersistedExchangeCohort()
  )
  const [initialCohortStatus, setInitialCohortStatus] = useState<'ready' | 'loading' | 'failed'>(
    () => (requiresInitialClientCohort ? 'loading' : 'ready')
  )
  const [initialCohortAttempt, setInitialCohortAttempt] = useState(0)
  const pendingRangeRef = useRef<TimeRange | null>(null)

  // Convert InitialTrader[] to Trader[] for compatibility
  const convertedInitialTraders: Trader[] | undefined = useMemo(
    () =>
      initialTraders?.map((t) => ({
        id: t.id,
        handle: t.handle,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.win_rate,
        max_drawdown: t.max_drawdown,
        followers: t.followers,
        source: t.source,
        avatar_url: t.avatar_url,
        avatar_url_mirror: t.avatar_url_mirror,
        arena_score: t.arena_score,
        score_confidence: t.score_confidence,
        rank: t.rank,
        // Rank-movement signals — the SSR shape carries them but this
        // allowlist copy silently dropped them, so first-paint rows never
        // showed the ↑/↓ arrows that hydrated /api/traders rows now get.
        rank_change: t.rank_change ?? null,
        is_new: t.is_new === true,
        trades_count: t.trades_count,
      })),
    [initialTraders]
  )

  const {
    traders,
    loading,
    error,
    activeTimeRange,
    changeTimeRange,
    lastUpdated,
    availableSources,
    refresh,
    deferredFetchFailed,
    retryDeferredFetch,
    isChangingTimeRange,
    totalCount,
    totalCountIsExact,
    hasMore,
    categoryCounts,
    categoryCountsAreExact,
    fetchPage,
    lastRefreshFailed,
    staleDataWarning,
    isStale,
  } = useTraderData({
    initialTraders: convertedInitialTraders,
    initialLastUpdated,
    initialIsStale,
    initialTotalCount,
    initialTotalCountIsExact,
    initialHasMore,
    initialCategoryCounts,
    initialCategoryCountsAreExact,
    initialTimeRange,
    initialPageIndex,
  })

  useEffect(() => {
    trackEvent('landing_view', { authenticated: isLoggedIn })
  }, [isLoggedIn])

  useEffect(() => {
    if (loading || traders.length === 0) return
    trackEvent('ranking_visible', {
      period: activeTimeRange,
      visible_count: traders.length,
      total_count: totalCountIsExact && totalCount !== null ? totalCount : 'unknown',
      has_more: hasMore,
    })
  }, [activeTimeRange, hasMore, loading, totalCount, totalCountIsExact, traders.length])

  // Hide SSR ranking table only AFTER we have real data to show.
  // Previously this ran on mount (useLayoutEffect + []), which hid the SSR
  // table immediately — before React had data to replace it with. On slow
  // mobile connections (4MB JS), this created a "spinner of death" where the
  // SSR content vanished and the loading skeleton appeared for seconds or forever.
  //
  // Root fix: wait until `loading` is false (data ready) before hiding SSR.
  // Hide SSR shells when React has data to show.
  // useLayoutEffect runs BEFORE paint — on fast connections, the browser
  // never shows the SSR table (it's hidden before first paint).
  // On slow connections (SSR already painted), we collapse it instantly
  // since any transition would show "double content" (SSR + React stacked).
  // Hide SSR period controls immediately on mount to prevent double-selector flash.
  // React always renders its own TimeRangeSelector, so SSR controls are redundant.
  useLayoutEffect(() => {
    const ssrControls = document.querySelector(
      '#ssr-ranking-table .ssr-controls'
    ) as HTMLElement | null
    if (ssrControls) ssrControls.style.display = 'none'
  }, [])

  // Hide the complete first-paint shell once React data is ready. Keeping the
  // source strip and both sidebar placeholders in the same shell prevents a
  // one-column → three-column jump while the deferred client bundle downloads.
  useLayoutEffect(() => {
    if (loading || initialCohortStatus !== 'ready') return
    const el = document.getElementById('ssr-home-content-shell')
    if (el) el.style.display = 'none'
  }, [initialCohortStatus, loading])

  const handleInitialCohortSettled = useCallback((succeeded: boolean) => {
    setInitialCohortStatus(succeeded ? 'ready' : 'failed')
  }, [])

  const retryInitialCohort = useCallback(() => {
    // The first client cohort intentionally withholds server-default rows. A
    // failed request must remain retryable; refreshing the previously loaded
    // default cohort would never make the target URL safe to reveal.
    setInitialCohortStatus('loading')
    setInitialCohortAttempt((attempt) => attempt + 1)
  }, [])

  const handleTimeRangeChange = useCallback(
    (range: TimeRange) => {
      if (range === activeTimeRange) {
        pendingRangeRef.current = null
        // This forwards a click back to the visible range as an explicit
        // cancellation of a pending 30D/7D request. Without it the stale
        // request could still commit after the user has switched back.
        changeTimeRange(range)
        return
      }
      trackEvent('ranking_filter', { kind: 'period', value: range })
      pendingRangeRef.current = range
      changeTimeRange(range)
    },
    [activeTimeRange, changeTimeRange]
  )

  // A range URL is a statement about the rows on screen. Only rewrite it
  // after useTraderData has atomically committed the matching successful
  // range cohort; failed requests keep both the old rows and their old URL.
  useEffect(() => {
    if (pendingRangeRef.current !== activeTimeRange) return
    pendingRangeRef.current = null
    const params = new URLSearchParams(window.location.search)
    params.delete('range')
    params.delete('page')
    if (activeTimeRange !== '90D') params.set('range', activeTimeRange)
    const query = params.toString()
    window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname)
  }, [activeTimeRange])

  const handlePullRefresh = async () => {
    if (refresh) {
      await refresh()
    }
  }

  const shouldWithholdRows = initialCohortStatus !== 'ready'

  return (
    <PullToRefresh onRefresh={handlePullRefresh} disabled={loading || shouldWithholdRows}>
      <div style={{ position: 'relative', zIndex: 1 }}>
        <RankingSection
          traders={shouldWithholdRows ? [] : traders}
          loading={
            shouldWithholdRows ? initialCohortStatus === 'loading' : loading && traders.length === 0
          }
          isRefreshing={
            !shouldWithholdRows && (loading || isChangingTimeRange) && traders.length > 0
          }
          isLoggedIn={isLoggedIn}
          activeTimeRange={activeTimeRange}
          onTimeRangeChange={handleTimeRangeChange}
          lastUpdated={lastUpdated}
          error={initialCohortStatus === 'failed' ? t('failedToLoadRankings') : error}
          onRetry={
            shouldWithholdRows
              ? retryInitialCohort
              : deferredFetchFailed
                ? retryDeferredFetch
                : refresh
          }
          onRefresh={shouldWithholdRows ? retryInitialCohort : refresh}
          availableSources={availableSources}
          totalCount={totalCount}
          totalCountIsExact={totalCountIsExact}
          hasMore={hasMore}
          categoryCounts={categoryCounts}
          categoryCountsAreExact={categoryCountsAreExact}
          initialPageIndex={initialPageIndex}
          requiresInitialCohortFetch={requiresInitialClientCohort}
          initialCohortAttempt={initialCohortAttempt}
          onInitialCohortSettled={handleInitialCohortSettled}
          fetchPage={fetchPage}
          lastRefreshFailed={lastRefreshFailed}
          staleDataWarning={staleDataWarning}
          isStale={isStale}
        />

        {/* API CTA — subtle banner for developer discovery */}
        <Link
          href="/api-docs"
          prefetch={false}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            marginTop: tokens.spacing[4],
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            textDecoration: 'none',
            transition: `all ${tokens.transition.base}`,
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          {t('apiCtaBanner')}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.5 }}
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </Link>
      </div>
    </PullToRefresh>
  )
}
