'use client'

import { useEffect, useLayoutEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
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
  initialTotalCount?: number
  initialCategoryCounts?: CategoryCounts
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
  initialTotalCount,
  initialCategoryCounts,
}: HomePageClientProps) {
  const { isLoggedIn } = useAuthSession()
  const { t } = useLanguage()
  const router = useRouter()

  // Convert InitialTrader[] to Trader[] for compatibility
  const convertedInitialTraders: Trader[] | undefined = useMemo(
    () =>
      initialTraders?.map((t, idx) => ({
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
        rank: idx + 1,
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
    categoryCounts,
    fetchPage,
    lastRefreshFailed,
    staleDataWarning,
  } = useTraderData({
    initialTraders: convertedInitialTraders,
    initialLastUpdated,
    initialTotalCount,
    initialCategoryCounts,
  })

  useEffect(() => {
    trackEvent('landing_view', { authenticated: isLoggedIn })
  }, [isLoggedIn])

  useEffect(() => {
    if (loading || traders.length === 0) return
    trackEvent('ranking_visible', {
      period: activeTimeRange,
      visible_count: traders.length,
      total_count: totalCount,
    })
  }, [activeTimeRange, loading, totalCount, traders.length])

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
    if (loading) return
    const el = document.getElementById('ssr-home-content-shell')
    if (el) el.style.display = 'none'
  }, [loading])

  // Sync time range with URL on initial load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlTimeRange = params.get('range') as TimeRange | null
    if (
      urlTimeRange &&
      ['90D', '30D', '7D'].includes(urlTimeRange) &&
      urlTimeRange !== activeTimeRange
    ) {
      changeTimeRange(urlTimeRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  const handleTimeRangeChange = useCallback(
    (range: TimeRange) => {
      trackEvent('ranking_filter', { kind: 'period', value: range })
      changeTimeRange(range)
      const params = new URLSearchParams(window.location.search)
      params.set('range', range)
      router.replace(`?${params.toString()}`, { scroll: false })
    },
    [changeTimeRange, router]
  )

  const handlePullRefresh = async () => {
    if (refresh) {
      await refresh()
    }
  }

  return (
    <PullToRefresh onRefresh={handlePullRefresh} disabled={loading}>
      <div style={{ position: 'relative', zIndex: 1 }}>
        <RankingSection
          traders={traders}
          loading={loading && traders.length === 0}
          isRefreshing={(loading || isChangingTimeRange) && traders.length > 0}
          isLoggedIn={isLoggedIn}
          activeTimeRange={activeTimeRange}
          onTimeRangeChange={handleTimeRangeChange}
          lastUpdated={lastUpdated}
          error={error}
          onRetry={deferredFetchFailed ? retryDeferredFetch : refresh}
          onRefresh={refresh}
          availableSources={availableSources}
          totalCount={totalCount}
          categoryCounts={categoryCounts}
          fetchPage={fetchPage}
          lastRefreshFailed={lastRefreshFailed}
          staleDataWarning={staleDataWarning}
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
