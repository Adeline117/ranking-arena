/**
 * 自定义 Hooks 统一导出
 */

// Auth (Single Source of Truth)
export { useAuthSession, authFetch } from './useAuthSession'
export type { AuthState, AuthError, AuthSessionReturn } from './useAuthSession'

// Post Interactions (Unified across all entry points)
export { usePostComments, usePostReaction } from './usePostInteraction'
export type { Comment, CommentSubmitState } from './usePostInteraction'

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

// 乐观更新
export {
  useOptimisticUpdate,
  useOptimisticLike,
  useOptimisticBookmark,
  useOptimisticFollow,
  useOptimisticList,
} from './useOptimisticUpdate'

// SWR 数据获取（推荐使用）
export {
  useTraderList,
  useTraderDetail as useTraderDetailSWR,
  useTraderEquity,
  useTraderPositions,
  usePosts as usePostsSWR,
  usePostsInfinite,
  usePostDetail,
  useMarketData,
  useUserProfile,
  useNotifications,
  refreshCache,
  refreshCacheByPattern,
  clearCache,
  prefillCache,
  fetcher,
  fetcherWithAuth,
} from './useSWR'

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
