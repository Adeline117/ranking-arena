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

// ============================================
// 新增：增强型埋点 Hooks
// ============================================

/**
 * 用户行为追踪 Hook
 * 追踪用户在页面上的关键操作
 */
export function useUserBehaviorTracking() {
  const pathname = usePathname()

  // 追踪滚动深度
  const trackScrollDepth = useCallback((depth: number) => {
    track('performance', {
      metric_name: 'scroll_depth',
      value: depth,
      page: pathname,
    })
  }, [pathname])

  // 追踪点击事件
  const trackClick = useCallback((
    elementName: string,
    elementType: 'button' | 'link' | 'card' | 'tab' | 'other',
    metadata?: Record<string, unknown>
  ) => {
    track('performance', {
      metric_name: `click.${elementType}.${elementName}`,
      value: 1,
      page: pathname,
      ...metadata,
    })
  }, [pathname])

  // 追踪表单提交
  const trackFormSubmit = useCallback((
    formName: string,
    success: boolean,
    errorMessage?: string
  ) => {
    track('performance', {
      metric_name: `form.${formName}.${success ? 'success' : 'error'}`,
      value: success ? 1 : 0,
      page: pathname,
      ...(errorMessage && { error: errorMessage }),
    })
  }, [pathname])

  return { trackScrollDepth, trackClick, trackFormSubmit }
}

/**
 * Premium 功能追踪 Hook
 * 追踪 Premium 相关的用户行为
 */
export function usePremiumTracking() {
  // 追踪 Premium 功能触达
  const trackPremiumFeatureView = useCallback((
    featureName: string,
    userTier: 'free' | 'pro' | 'elite' | 'enterprise'
  ) => {
    track('performance', {
      metric_name: `premium.feature_view.${featureName}`,
      value: 1,
      page: 'premium',
      tier: userTier,
    })
  }, [])

  // 追踪 Premium 升级点击
  const trackUpgradeClick = useCallback((
    source: string,
    targetTier: 'pro' | 'elite' | 'enterprise'
  ) => {
    track('performance', {
      metric_name: `premium.upgrade_click.${targetTier}`,
      value: 1,
      page: source,
    })
  }, [])

  // 追踪 Premium 功能受限提示
  const trackFeatureGate = useCallback((
    featureName: string,
    requiredTier: 'pro' | 'elite' | 'enterprise'
  ) => {
    track('performance', {
      metric_name: `premium.feature_gate.${featureName}`,
      value: 1,
      page: 'feature_gate',
      required_tier: requiredTier,
    })
  }, [])

  return { trackPremiumFeatureView, trackUpgradeClick, trackFeatureGate }
}

/**
 * 筛选追踪 Hook
 * 追踪用户的筛选行为
 */
export function useFilterTracking() {
  const pathname = usePathname()

  const trackFilter = useCallback((
    filterType: 'time_range' | 'exchange' | 'sort' | 'category' | 'other',
    filterValue: string,
    previousValue?: string
  ) => {
    track('performance', {
      metric_name: `filter.${filterType}`,
      value: 1,
      page: pathname,
      filter_value: filterValue,
      previous_value: previousValue,
    })
  }, [pathname])

  return { trackFilter }
}

/**
 * 页面停留时间追踪 Hook
 * 自动追踪用户在页面上的停留时间
 */
export function useTimeOnPage(pageName: string) {
  const startTime = useRef(Date.now())
  const pathname = usePathname()

  useEffect(() => {
    startTime.current = Date.now()

    return () => {
      const duration = Date.now() - startTime.current
      // 只追踪超过 3 秒的停留
      if (duration > 3000) {
        track('performance', {
          metric_name: `time_on_page.${pageName}`,
          value: Math.round(duration / 1000), // 转换为秒
          page: pathname,
        })
      }
    }
  }, [pageName, pathname])
}

/**
 * 交易员比较追踪 Hook
 */
export function useCompareTracking() {
  const trackCompareAction = useCallback((
    action: 'add' | 'remove' | 'view' | 'share',
    traderIds: string[],
    source?: string
  ) => {
    track('performance', {
      metric_name: `compare.${action}`,
      value: traderIds.length,
      page: source || 'compare',
      trader_ids: traderIds.join(','),
    })
  }, [])

  return { trackCompareAction }
}

/**
 * 通知追踪 Hook
 */
export function useNotificationTracking() {
  const trackNotificationAction = useCallback((
    action: 'view' | 'click' | 'dismiss' | 'settings_change',
    notificationType?: string,
    notificationId?: string
  ) => {
    track('performance', {
      metric_name: `notification.${action}`,
      value: 1,
      page: 'notifications',
      notification_type: notificationType,
      notification_id: notificationId,
    })
  }, [])

  return { trackNotificationAction }
}

/**
 * 用户引导追踪 Hook
 */
export function useOnboardingTracking() {
  const trackOnboardingStep = useCallback((
    step: number,
    stepName: string,
    action: 'view' | 'complete' | 'skip'
  ) => {
    track('performance', {
      metric_name: `onboarding.step_${step}.${action}`,
      value: 1,
      page: 'onboarding',
      step_name: stepName,
    })
  }, [])

  const trackOnboardingComplete = useCallback((
    totalSteps: number,
    skipped: boolean
  ) => {
    track('performance', {
      metric_name: skipped ? 'onboarding.skipped' : 'onboarding.completed',
      value: totalSteps,
      page: 'onboarding',
    })
  }, [])

  return { trackOnboardingStep, trackOnboardingComplete }
}
