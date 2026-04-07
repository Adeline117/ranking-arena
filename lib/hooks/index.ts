/**
 * 自定义 Hooks 统一导出
 *
 * 数据获取统一使用 SWR 实现（useSWR.ts）
 */

// Auth (Single Source of Truth)
export { useAuthSession, authFetch } from './useAuthSession'
export type { AuthState, AuthError, AuthSessionReturn } from './useAuthSession'

// Token Refresh Coordinator (for components doing raw fetch with auth)
export {
  tokenRefreshCoordinator,
  fetchWithTokenRefresh,
} from '@/lib/auth/token-refresh'

// Post Interactions (Unified across all entry points)
export { usePostComments, usePostReaction } from './usePostInteraction'
export type { Comment, CommentSubmitState } from './usePostInteraction'

export { useSubmit, useDebounceClick } from './useSubmit'
export { useCsrf, getCsrfToken, createCsrfHeaders } from './useCsrf'
export { useDebounce, useDebouncedCallback } from './useDebounce'

// Async Action (Unified loading, error handling, duplicate prevention)
export { useAsyncAction, useLoadingAction } from './useAsyncAction'
export type { AsyncActionOptions, AsyncActionReturn } from './useAsyncAction'

// Touch Gestures (Mobile)
export { useSwipeGesture, useSwipeNavigation } from './useSwipeGesture'
export type { SwipeDirection } from './useSwipeGesture'

// 实时更新
export {
  useRealtime,
  usePostsRealtime,
  useTraderSnapshotsRealtime,
  useNotificationsRealtime,
  useMessagesRealtime,
} from './useRealtime'

// Presence (standalone, with heartbeat + DB sync)
export { usePresence, formatLastSeen } from './usePresence'

// 交易员实时持仓
export {
  useTraderPositionsRealtime,
  useTraderAllPositions,
  useSymbolPositions,
  useTraderPositionSummary,
} from './useTraderPositionsRealtime'

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

export { usePWAInstall } from './usePWAInstall'
