/**
 * Analytics 模块统一导出
 */

// 事件类型
export * from './events'

// 追踪器
export {
  Tracker,
  getTracker,
  track,
  pageView,
  setUserId,
} from './tracker'

// React Hooks
export {
  usePageTracking,
  useUserTracking,
  useTracking,
  useTraderClickTracking,
  useSearchTracking,
  usePerformanceTracking,
  useErrorTracking,
  useChartTracking,
  useShareTracking,
  usePostInteractionTracking,
  useAnalyticsCleanup,
} from './hooks'
