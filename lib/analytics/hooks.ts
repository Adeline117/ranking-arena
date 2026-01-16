'use client'

import { useEffect, useCallback, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { track, pageView, setUserId, getTracker } from './tracker'
import type { EventName, EventProps } from './events'

/**
 * 自动页面浏览追踪 Hook
 * 在路由变化时自动触发 page_view 事件
 */
export function usePageTracking() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    const url = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : '')
    pageView(pathname, { path: url })
  }, [pathname, searchParams])
}

/**
 * 用户身份追踪 Hook
 * 设置当前用户 ID
 */
export function useUserTracking(userId: string | undefined) {
  useEffect(() => {
    setUserId(userId)
  }, [userId])
}

/**
 * 通用事件追踪 Hook
 * 返回一个 track 函数，方便在组件中使用
 */
export function useTracking() {
  const trackEvent = useCallback(<T extends EventName>(name: T, props: EventProps<T>) => {
    track(name, props)
  }, [])

  return { track: trackEvent }
}

/**
 * 交易员点击追踪 Hook
 */
export function useTraderClickTracking(fromPage: string) {
  const trackTraderClick = useCallback((
    traderId: string,
    traderHandle: string,
    rank: number,
    source: string
  ) => {
    track('trader_click', {
      trader_id: traderId,
      trader_handle: traderHandle,
      rank,
      source,
      from_page: fromPage,
    })
  }, [fromPage])

  return { trackTraderClick }
}

/**
 * 搜索追踪 Hook
 */
export function useSearchTracking() {
  const trackSearch = useCallback((query: string, resultsCount: number, selectedResult?: string) => {
    track('search', {
      query,
      results_count: resultsCount,
      selected_result: selectedResult,
    })
  }, [])

  return { trackSearch }
}

/**
 * 性能追踪 Hook
 * 自动追踪组件渲染时间
 */
export function usePerformanceTracking(componentName: string) {
  const startTime = useRef(Date.now())
  const pathname = usePathname()

  useEffect(() => {
    const renderTime = Date.now() - startTime.current
    
    track('performance', {
      metric_name: `${componentName}_render_time`,
      value: renderTime,
      page: pathname,
    })
  }, [componentName, pathname])
}

/**
 * 错误追踪 Hook
 */
export function useErrorTracking(componentName: string) {
  const pathname = usePathname()

  const trackError = useCallback((errorType: string, errorMessage: string) => {
    track('error', {
      error_type: errorType,
      error_message: errorMessage,
      page: pathname,
      component: componentName,
    })
  }, [pathname, componentName])

  return { trackError }
}

/**
 * 图表交互追踪 Hook
 */
export function useChartTracking(traderId: string) {
  const trackChartInteraction = useCallback((
    chartType: 'equity' | 'pnl' | 'drawdown',
    action: 'view' | 'zoom' | 'hover'
  ) => {
    track('chart_interaction', {
      chart_type: chartType,
      trader_id: traderId,
      action,
    })
  }, [traderId])

  return { trackChartInteraction }
}

/**
 * 分享追踪 Hook
 */
export function useShareTracking() {
  const trackShare = useCallback((
    contentType: 'trader' | 'post' | 'group',
    contentId: string,
    platform: 'twitter' | 'telegram' | 'copy_link' | 'other'
  ) => {
    track('share', {
      content_type: contentType,
      content_id: contentId,
      platform,
    })
  }, [])

  return { trackShare }
}

/**
 * 帖子互动追踪 Hook
 */
export function usePostInteractionTracking() {
  const trackPostInteraction = useCallback((
    postId: string,
    action: 'like' | 'unlike' | 'comment' | 'bookmark' | 'repost' | 'vote',
    voteType?: 'bullish' | 'bearish' | 'wait'
  ) => {
    track('post_interaction', {
      post_id: postId,
      action,
      vote_type: voteType,
    })
  }, [])

  return { trackPostInteraction }
}

/**
 * 清理 Hook
 * 在组件卸载时确保数据上报
 */
export function useAnalyticsCleanup() {
  useEffect(() => {
    return () => {
      getTracker().flush(true)
    }
  }, [])
}
