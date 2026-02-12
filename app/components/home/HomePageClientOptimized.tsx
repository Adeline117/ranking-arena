'use client'

import { useEffect, useCallback, memo } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Box } from '../base'
import dynamic from 'next/dynamic'
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData, useAuth } from './hooks'
import { useLanguage } from '../Providers/LanguageProvider'
import type { Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader } from '@/lib/getInitialTraders'

// Dynamically import the optimized ranking section
const OptimizedRankingSection = dynamic(() => import('./OptimizedRankingSection'), {
  ssr: true,
  loading: () => (
    <Box style={{ minHeight: '60vh', contain: 'layout style' }}>
      <div className="skeleton" style={{ 
        height: 400, 
        borderRadius: 'var(--radius-lg)', 
        contain: 'layout style paint' 
      }} />
    </Box>
  ),
})

interface HomePageClientOptimizedProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
}

/**
 * Optimized 首页客户端组件
 * 集成虚拟滚动和性能优化
 * 使用 CSS containment 和 memo 优化
 */
const HomePageClientOptimized = memo<HomePageClientOptimizedProps>(({
  initialTraders,
  initialLastUpdated,
}) => {
  const { isLoggedIn } = useAuth()
  const { t } = useLanguage()
  const searchParams = useSearchParams()
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

  // Sync time range with URL on initial load
  useEffect(() => {
    const urlTimeRange = searchParams.get('range') as TimeRange | null
    if (urlTimeRange && ['90D', '30D', '7D'].includes(urlTimeRange) && urlTimeRange !== activeTimeRange) {
      changeTimeRange(urlTimeRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run once on mount

  // Optimized handler to update both state and URL
  const handleTimeRangeChange = useCallback((range: TimeRange) => {
    changeTimeRange(range)
    // Update URL without full navigation
    const params = new URLSearchParams(searchParams.toString())
    params.set('range', range)
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [changeTimeRange, searchParams, router])

  // Optimized pull-to-refresh handler
  const handlePullRefresh = useCallback(async () => {
    if (refresh) {
      await refresh()
    }
  }, [refresh])

  return (
    <PullToRefresh onRefresh={handlePullRefresh} disabled={loading}>
      <Box
        as="main"
        style={{
          position: 'relative',
          zIndex: 1,
          contain: 'layout style', // CSS containment for performance
        }}
      >
        {/* Load performance optimization CSS */}
        <link 
          rel="stylesheet" 
          href="/styles/performance-optimizations.css"
          media="print"
          onLoad={(e) => {
            const target = e.target as HTMLLinkElement
            target.media = 'all'
          }}
        />
        
        {/* 排名榜区域 - 使用优化版本组件 */}
        <OptimizedRankingSection
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
})

HomePageClientOptimized.displayName = 'HomePageClientOptimized'

export default HomePageClientOptimized