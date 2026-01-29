'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Box } from '../base'
import RankingSection from './RankingSection'
import PullToRefresh from '../ui/PullToRefresh'
import { useTraderData } from './hooks'
import type { Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'
import type { InitialTrader } from '@/lib/getInitialTraders'

interface HomePageClientProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  isLoggedIn: boolean
}

/**
 * 首页客户端组件
 * 处理交互状态和数据同步
 */
export default function HomePageClient({
  initialTraders,
  initialLastUpdated,
  isLoggedIn
}: HomePageClientProps) {
  const searchParams = useSearchParams()
  const router = useRouter()

  // 交易者数据管理 - 传入服务端预获取的数据
  const {
    traders,
    loading,
    activeTimeRange,
    changeTimeRange,
    lastUpdated,
    availableSources,
    refresh,
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

  // Custom handler to update both state and URL
  const handleTimeRangeChange = (range: TimeRange) => {
    changeTimeRange(range)
    // Update URL without full navigation
    const params = new URLSearchParams(searchParams.toString())
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
        className="container-padding page-enter has-mobile-nav"
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          position: 'relative',
          zIndex: 1,
          padding: '16px 16px',
        }}
      >
        {/* 排名榜区域 - 单栏布局，侧边栏由父组件处理 */}
        <RankingSection
          traders={traders}
          loading={loading}
          isLoggedIn={isLoggedIn}
          activeTimeRange={activeTimeRange}
          onTimeRangeChange={handleTimeRangeChange}
          lastUpdated={lastUpdated}
          onRefresh={refresh}
          availableSources={availableSources}
        />
      </Box>
    </PullToRefresh>
  )
}
