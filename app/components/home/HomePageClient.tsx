'use client'

import { useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import RankingSection from './RankingSection'
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData } from './hooks'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader } from '@/lib/getInitialTraders'
import type { Trader } from '../ranking/RankingTable'

interface HomePageClientProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

/**
 * 首页客户端组件
 * 处理交互状态和数据同步
 * 数据通过客户端fetch获取，SSR排行榜由SSRRankingTable提供
 * NOTE: ssrTable prop removed — #ssr-homepage-shell handles the Phase 1 fallback via CSS.
 * Passing ssrTable to the client was causing duplicate DOM nodes.
 */
export default function HomePageClient({ initialTraders, initialLastUpdated }: HomePageClientProps) {
  const { isLoggedIn } = useAuthSession()
  const { t } = useLanguage()
  const router = useRouter()

  // Convert InitialTrader[] to Trader[] for compatibility
  // Memoize to prevent new array reference on every render (triggers useTraderData effects)
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

  // 交易者数据管理 - 传入服务端预获取的数据
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
  } = useTraderData({
    initialTraders: convertedInitialTraders,
    initialLastUpdated,
  })

  // Sync time range with URL on initial load (avoid useSearchParams to keep page static/ISR)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlTimeRange = params.get('range') as TimeRange | null
    if (urlTimeRange && ['90D', '30D', '7D'].includes(urlTimeRange) && urlTimeRange !== activeTimeRange) {
      changeTimeRange(urlTimeRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount to sync URL param
  }, [])

  // Custom handler to update both state and URL
  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    changeTimeRange(range)
    const params = new URLSearchParams(window.location.search)
    params.set('range', range)
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [changeTimeRange, router])

  // Pull-to-refresh handler (async for PullToRefresh component)
  const handlePullRefresh = async () => {
    if (refresh) {
      await refresh()
    }
  }

  return (
    <PullToRefresh onRefresh={handlePullRefresh} disabled={loading}>
      <div style={{ position: 'relative', zIndex: 1 }}>
        {/* 排名榜区域 - 单栏布局，侧边栏由父组件处理 */}
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
        />
      </div>
    </PullToRefresh>
  )
}
