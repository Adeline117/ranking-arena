'use client'

import { useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import RankingSection from './RankingSection'
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData } from './hooks'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader, CategoryCounts } from '@/lib/getInitialTraders'
import type { Trader } from '../ranking/RankingTable'

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
export default function HomePageClient({ initialTraders, initialLastUpdated, initialTotalCount, initialCategoryCounts }: HomePageClientProps) {
  const { isLoggedIn } = useAuthSession()
  const { t } = useLanguage()
  const router = useRouter()

  // Convert InitialTrader[] to Trader[] for compatibility
  const convertedInitialTraders: Trader[] | undefined = useMemo(() =>
    initialTraders?.map(t => ({
      id: t.id,
      handle: t.handle,
      roi: t.roi,
      pnl: t.pnl,
      win_rate: t.win_rate,
      max_drawdown: t.max_drawdown,
      followers: t.followers,
      source: t.source,
      avatar_url: t.avatar_url,
      arena_score: t.arena_score,
      score_confidence: t.score_confidence,
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
  } = useTraderData({
    initialTraders: convertedInitialTraders,
    initialLastUpdated,
    initialTotalCount,
    initialCategoryCounts,
  })

  // Remove SSR ranking table now that the interactive version has rendered with data.
  // This prevents the flash of empty content that occurred when HomePage removed SSR
  // before the client had finished loading.
  useEffect(() => {
    document.getElementById('ssr-ranking-table')?.remove()
  }, [])

  // Sync time range with URL on initial load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlTimeRange = params.get('range') as TimeRange | null
    if (urlTimeRange && ['90D', '30D', '7D'].includes(urlTimeRange) && urlTimeRange !== activeTimeRange) {
      changeTimeRange(urlTimeRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    changeTimeRange(range)
    const params = new URLSearchParams(window.location.search)
    params.set('range', range)
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [changeTimeRange, router])

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
          loading={loading || isChangingTimeRange}
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
        />
      </div>
    </PullToRefresh>
  )
}
