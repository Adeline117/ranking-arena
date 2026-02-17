'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '../base'
import dynamic from 'next/dynamic'
const RankingSection = dynamic(() => import('./RankingSection'), { ssr: true })
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData, useAuth } from './hooks'
import { useLanguage } from '../Providers/LanguageProvider'
import type { Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader } from '@/lib/getInitialTraders'

interface HomePageClientProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

/**
 * 首页客户端组件
 * 处理交互状态和数据同步
 */
export default function HomePageClient({
  initialTraders,
  initialLastUpdated,
}: HomePageClientProps) {
  const { isLoggedIn } = useAuth()
  const { t } = useLanguage()
  const router = useRouter()

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
    initialTraders: initialTraders as Trader[] | undefined,
    initialLastUpdated,
  })

  // Sync time range with URL on initial load (avoid useSearchParams to keep page static/ISR)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlTimeRange = params.get('range') as TimeRange | null
    if (urlTimeRange && ['90D', '30D', '7D'].includes(urlTimeRange) && urlTimeRange !== activeTimeRange) {
      changeTimeRange(urlTimeRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run once on mount

  // Custom handler to update both state and URL
  const handleTimeRangeChange = (range: TimeRange) => {
    changeTimeRange(range)
    const params = new URLSearchParams(window.location.search)
    params.set('range', range)
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  // Pull-to-refresh handler (async for PullToRefresh component)
  const handlePullRefresh = async () => {
    if (refresh) {
      await refresh()
    }
  }

  return (
    <PullToRefresh onRefresh={handlePullRefresh} disabled={loading}>
      <Box
        as="main"
        style={{
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* 排名榜区域 - 单栏布局，侧边栏由父组件处理 */}
        <RankingSection
          traders={traders}
          loading={loading || isChangingTimeRange}
          isLoggedIn={isLoggedIn}
          activeTimeRange={activeTimeRange}
          onTimeRangeChange={handleTimeRangeChange}
          lastUpdated={lastUpdated}
          error={error || (deferredFetchFailed ? t('dataLoadIncomplete') : null)}
          onRetry={deferredFetchFailed ? retryDeferredFetch : refresh}
          onRefresh={refresh}
          availableSources={availableSources}
        />
      </Box>
    </PullToRefresh>
  )
}
