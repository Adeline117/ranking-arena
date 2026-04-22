'use client'

/**
 * Data fetching hooks — migrated from SWR to React Query.
 *
 * Pure fetcher functions live in ./fetchers.ts and are
 * re-exported here for backward compatibility.
 *
 * Cache utility functions (refreshCache, clearCache, etc.) now use
 * the React Query queryClient from Providers.
 */

import { useQuery, useInfiniteQuery, type UseQueryResult } from '@tanstack/react-query'
import { queryClient } from '@/app/components/Providers'

// Re-export pure fetchers from the shared module
export { fetcher, fetcherWithAuth, fetchWithTimeout } from './fetchers'
import { fetcher, fetcherWithAuth } from './fetchers'

// ============================================
// 交易员相关 Hooks
// ============================================

interface TradersResponse {
  traders: Array<{
    id: string
    handle: string
    roi: number
    win_rate: number
    source: string
    followers?: number
  }>
  total?: number
}

interface UseTraderListOptions {
  timeRange?: string
  exchange?: string
  limit?: number
  enabled?: boolean
}

/**
 * 获取交易员排行榜
 */
export function useTraderList(options: UseTraderListOptions = {}) {
  const { timeRange = '90D', exchange, limit = 20, enabled = true } = options

  const params = new URLSearchParams({ timeRange })
  if (exchange) params.set('exchange', exchange)
  if (limit) params.set('limit', String(limit))

  const url = `/api/traders?${params.toString()}`

  return useQuery<TradersResponse>({
    queryKey: ['trader-list', timeRange, exchange, limit],
    queryFn: () => fetcher(url),
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: 30 * 60 * 1000,
  })
}

interface TraderDetailResponse {
  profile: {
    handle: string
    id: string
    bio?: string
    followers?: number
    source?: string
    avatar_url?: string
    isRegistered?: boolean
  }
  performance: {
    roi_7d?: number
    roi_30d?: number
    roi_90d?: number
    pnl?: number
    win_rate?: number
    max_drawdown?: number
  }
}

/**
 * 获取交易员详情
 */
export function useTraderDetail(handle: string | undefined) {
  const url = handle ? `/api/traders/${encodeURIComponent(handle)}` : ''

  return useQuery<TraderDetailResponse>({
    queryKey: ['trader-detail', handle],
    queryFn: () => fetcher(url),
    enabled: !!handle,
    refetchOnWindowFocus: false,
    refetchInterval: 5 * 60 * 1000,
  })
}

interface EquityResponse {
  equity: Array<{ date: string; value: number }>
  pnl: Array<{ date: string; value: number }>
  drawdown: Array<{ date: string; value: number }>
}

/**
 * 获取交易员资金曲线
 */
export function useTraderEquity(handle: string | undefined) {
  const url = handle ? `/api/traders/${encodeURIComponent(handle)}/equity` : ''

  return useQuery<EquityResponse>({
    queryKey: ['trader-equity', handle],
    queryFn: () => fetcher(url),
    enabled: !!handle,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 60 * 1000,
  })
}

interface PositionsResponse {
  positions: Array<{
    symbol: string
    side: 'long' | 'short'
    size: number
    entryPrice: number
    markPrice: number
    pnl: number
    pnlPercent: number
    leverage?: number
  }>
}

/**
 * 获取交易员持仓
 */
export function useTraderPositions(handle: string | undefined) {
  const url = handle ? `/api/traders/${encodeURIComponent(handle)}/positions` : ''

  return useQuery<PositionsResponse>({
    queryKey: ['trader-positions', handle],
    queryFn: () => fetcher(url),
    enabled: !!handle,
    refetchInterval: 5 * 60 * 1000,
  })
}

// ============================================
// 帖子相关 Hooks
// ============================================

interface Post {
  id: string
  title: string
  content: string
  author_id: string
  author_handle: string
  author_avatar_url?: string
  group_id?: string
  group_name?: string
  like_count: number
  dislike_count: number
  comment_count: number
  created_at: string
}

interface PostsResponse {
  posts: Post[]
  total?: number
  hasMore?: boolean
}

interface UsePostsOptions {
  groupId?: string
  sortBy?: 'created_at' | 'hot_score' | 'like_count'
  limit?: number
  enabled?: boolean
}

/**
 * 获取帖子列表
 */
export function usePosts(options: UsePostsOptions = {}) {
  const { groupId, sortBy = 'created_at', limit = 20, enabled = true } = options

  const params = new URLSearchParams()
  if (groupId) params.set('group_id', groupId)
  if (sortBy) params.set('sort_by', sortBy)
  if (limit) params.set('limit', String(limit))

  const url = `/api/posts?${params.toString()}`

  return useQuery<PostsResponse>({
    queryKey: ['posts', groupId, sortBy, limit],
    queryFn: () => fetcher(url),
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000,
  })
}

/**
 * 无限加载帖子列表
 */
export function usePostsInfinite(options: UsePostsOptions = {}) {
  const { groupId, sortBy = 'created_at', limit = 20, enabled = true } = options

  return useInfiniteQuery<PostsResponse>({
    queryKey: ['posts-infinite', groupId, sortBy, limit],
    queryFn: ({ pageParam = 0 }) => {
      const params = new URLSearchParams()
      if (groupId) params.set('group_id', groupId)
      if (sortBy) params.set('sort_by', sortBy)
      params.set('limit', String(limit))
      params.set('offset', String((pageParam as number) * limit))
      return fetcher(`/api/posts?${params.toString()}`)
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined
      return (lastPageParam as number) + 1
    },
    enabled,
    refetchOnWindowFocus: false,
    retry: 2,
  })
}

interface PostDetailResponse {
  post: Post
  comments: Array<{
    id: string
    content: string
    author_handle: string
    author_avatar_url?: string
    created_at: string
    like_count: number
    replies?: Array<{
      id: string
      content: string
      author_handle: string
      created_at: string
    }>
  }>
}

/**
 * 获取帖子详情
 */
export function usePostDetail(postId: string | undefined) {
  const url = postId ? `/api/posts/${postId}` : ''

  return useQuery<PostDetailResponse>({
    queryKey: ['post-detail', postId],
    queryFn: () => fetcher(url),
    enabled: !!postId,
    refetchOnWindowFocus: false,
  })
}

// ============================================
// 市场数据 Hooks
// ============================================

interface MarketData {
  prices: Array<{
    symbol: string
    price: number
    change24h: number
    changePercent24h: number
  }>
  updatedAt: string
}

/**
 * 获取市场数据
 */
export function useMarketData() {
  return useQuery<MarketData>({
    queryKey: ['market-data'],
    queryFn: () => fetcher('/api/market'),
    refetchInterval: 30 * 1000,
    refetchOnWindowFocus: false,
  })
}

// ============================================
// 用户相关 Hooks
// ============================================

interface UserProfile {
  id: string
  handle: string
  bio?: string
  avatar_url?: string
  email?: string
  created_at: string
}

/**
 * 获取用户资料
 */
export function useUserProfile(handle: string | undefined, token?: string) {
  const url = handle ? `/api/users/${encodeURIComponent(handle)}` : ''

  return useQuery<UserProfile>({
    queryKey: ['user-profile', handle],
    queryFn: () => fetcherWithAuth(url, token),
    enabled: !!handle,
    refetchOnWindowFocus: false,
  })
}

// ============================================
// 通知 Hooks
// ============================================

interface Notification {
  id: string
  type: string
  title: string
  message: string
  read: boolean
  created_at: string
}

interface NotificationsResponse {
  notifications: Notification[]
  unreadCount: number
}

/**
 * 获取通知列表
 */
export function useNotifications(userId: string | undefined, token?: string) {
  const url = userId ? '/api/notifications' : ''

  return useQuery<NotificationsResponse>({
    queryKey: ['notifications', userId],
    queryFn: () => fetcherWithAuth(url, token),
    enabled: !!userId,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: true,
  })
}

// ============================================
// 缓存操作工具
// ============================================

/**
 * 手动刷新指定 key 的缓存
 */
export function refreshCache(key: string) {
  return queryClient.invalidateQueries({ queryKey: [key] })
}

/**
 * 刷新所有匹配模式的缓存
 */
export function refreshCacheByPattern(pattern: RegExp) {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = JSON.stringify(query.queryKey)
      return pattern.test(key)
    },
  })
}

/**
 * 清除指定 key 的缓存
 */
export function clearCache(key: string) {
  return queryClient.removeQueries({ queryKey: [key] })
}

/**
 * 预填充缓存数据
 */
export function prefillCache<T>(key: string, data: T) {
  return queryClient.setQueryData([key], data)
}

// ============================================
// Backward-compat: SWRResponse shape adapter
// ============================================

/**
 * @deprecated — provided for backward compat during migration.
 * React Query's UseQueryResult has the same data/error/isLoading shape.
 */
type SWRResponse<T = unknown> = UseQueryResult<T>

// ============================================
// 类型导出
// ============================================

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
  SWRResponse,
}
