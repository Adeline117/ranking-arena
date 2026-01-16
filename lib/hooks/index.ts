/**
 * 自定义 Hooks 统一导出
 */

export { useSubmit, useDebounceClick } from './useSubmit'
export { useCsrf, getCsrfToken, createCsrfHeaders } from './useCsrf'

// 数据获取
export {
  useFetch,
  useTraders,
  usePosts,
  useTraderDetail,
  invalidateCache,
} from './useDataFetching'

// 实时更新
export {
  useRealtime,
  usePostsRealtime,
  useTraderSnapshotsRealtime,
  useNotificationsRealtime,
  useMessagesRealtime,
  usePresence,
} from './useRealtime'

// 性能优化
export {
  useIntersectionObserver,
  useLazyLoad,
  useInfiniteScroll,
  useVisibilityTracking,
} from './useIntersectionObserver'

