/**
 * 自定义 Hooks 统一导出
 *
 * 数据获取统一使用 SWR 实现（useSWR.ts）
 */

// Auth (Single Source of Truth)
export { useAuthSession, authFetch } from './useAuthSession'
export type { AuthState, AuthError, AuthSessionReturn } from './useAuthSession'

// Post Interactions (Unified across all entry points)
export { usePostComments, usePostReaction } from './usePostInteraction'
export type { Comment, CommentSubmitState } from './usePostInteraction'

export { useSubmit, useDebounceClick } from './useSubmit'
export { useCsrf, getCsrfToken, createCsrfHeaders } from './useCsrf'

// 基础数据获取（低级 API，一般不直接使用）
export { useFetch, invalidateCache } from './useDataFetching'

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

// 乐观更新
export {
  useOptimisticUpdate,
  useOptimisticLike,
  useOptimisticBookmark,
  useOptimisticFollow,
  useOptimisticList,
} from './useOptimisticUpdate'

// ============================================
// SWR 数据获取 - 推荐使用
// ============================================

// 交易员相关
export {
  useTraderList,
  useTraderList as useTraders, // 别名，向后兼容
  useTraderDetail,
  useTraderEquity,
  useTraderPositions,
} from './useSWR'

// 帖子相关
export {
  usePosts,
  usePostsInfinite,
  usePostDetail,
} from './useSWR'

// 其他数据
export {
  useMarketData,
  useUserProfile,
  useNotifications,
} from './useSWR'

// 缓存工具
export {
  refreshCache,
  refreshCacheByPattern,
  clearCache,
  prefillCache,
  fetcher,
  fetcherWithAuth,
} from './useSWR'

// 类型导出
export type {
  TradersResponse,
  TraderDetailResponse,
  EquityResponse,
  PositionsResponse,
  Post,
  PostsResponse,
  PostDetailResponse,
  MarketData,
  UserProfile,
  Notification,
  NotificationsResponse,
} from './useSWR'
