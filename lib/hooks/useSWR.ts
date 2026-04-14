'use client'

/**
 * SWR 数据获取 Hooks
 * 提供自动缓存、重新验证和错误处理
 */

import useSWR, { SWRConfiguration, mutate as globalMutate, SWRResponse } from 'swr'
import useSWRInfinite, { SWRInfiniteConfiguration } from 'swr/infinite'
import { t } from '@/lib/i18n'
import { tokenRefreshCoordinator } from '@/lib/auth/token-refresh'

// ============================================
// 请求超时配置
// ============================================

const FETCH_TIMEOUT = 15000 // 15 秒超时

/**
 * 带超时的 fetch 请求
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && (error.name === 'AbortError' || error.message === 'The user aborted a request.')) {
      const timeoutError = new Error(t('errorTimeoutCheckNetwork'))
      timeoutError.name = 'TimeoutError'
      throw timeoutError
    }
    throw error
  }
}

// ============================================
// 默认配置
// ============================================

const defaultConfig: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: true,
  dedupingInterval: 5000, // 增加到 5 秒，减少重复请求
  errorRetryCount: 2, // 减少重试次数，避免长时间等待
  errorRetryInterval: 3000, // 减少重试间隔
  shouldRetryOnError: (error) => {
    // Retry network errors + 5xx + 429 rate limit. Don't retry other 4xx.
    if (error?.status === 429) return true // rate limit — retry after backoff
    if (error?.status >= 400 && error?.status < 500) return false
    return true
  },
}

// ============================================
// 通用 fetcher
// ============================================

export async function fetcher<T>(url: string): Promise<T> {
  const startTime = performance.now()
  try {
    const response = await fetchWithTimeout(url, {
      credentials: 'include',
    })

    if (!response.ok) {
      const error = new Error(t('errorRequestFailed')) as Error & { status: number; info: unknown; url: string; duration: number }
      error.status = response.status
      error.url = url
      error.duration = Math.round(performance.now() - startTime)
      try {
        error.info = await response.json()
      } catch (_err) {
        /* parse fallback: response body is not JSON */
        error.info = await response.text()
      }
      throw error
    }

    return response.json()
  } catch (error) {
    // Enrich error with request context (Sentry breadcrumb pattern)
    if (error instanceof Error) {
      const enriched = error as Error & { url?: string; duration?: number }
      if (!enriched.url) enriched.url = url
      if (!enriched.duration) enriched.duration = Math.round(performance.now() - startTime)

      if (error.name === 'TimeoutError' || error.message.includes('timeout') || error.message.includes('超时')) {
        throw new Error(t('errorTimeout'))
      }
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error(t('errorNetworkFailed'))
      }
    }
    throw error
  }
}

export async function fetcherWithAuth<T>(url: string, token?: string): Promise<T> {
  const headers: HeadersInit = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  try {
    const response = await fetchWithTimeout(url, {
      credentials: 'include',
      headers,
    })

    // On 401 with a token, attempt refresh via coordinator and retry once
    if (response.status === 401 && token && typeof window !== 'undefined') {
      const newToken = await tokenRefreshCoordinator.forceRefresh()
      if (newToken) {
        const retryHeaders: HeadersInit = { 'Authorization': `Bearer ${newToken}` }
        const retryResponse = await fetchWithTimeout(url, {
          credentials: 'include',
          headers: retryHeaders,
        })
        if (!retryResponse.ok) {
          const error = new Error(t('errorRequestFailed')) as Error & { status: number }
          error.status = retryResponse.status
          throw error
        }
        return retryResponse.json()
      }
    }

    if (!response.ok) {
      const error = new Error(t('errorRequestFailed')) as Error & { status: number }
      error.status = response.status
      throw error
    }

    return response.json()
  } catch (error) {
    // 处理超时和网络错误
    if (error instanceof Error) {
      if (error.name === 'TimeoutError' || error.message.includes('timeout') || error.message.includes('超时')) {
        throw new Error(t('errorTimeout'))
      }
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        throw new Error(t('errorNetworkFailed'))
      }
    }
    throw error
  }
}

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

  return useSWR<TradersResponse>(
    enabled ? url : null,
    fetcher,
    {
      ...defaultConfig,
      revalidateOnFocus: false,
      refreshInterval: 30 * 60 * 1000, // 30 分钟自动刷新（数据每 30 分钟由 cron 更新）
    }
  )
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
  const url = handle ? `/api/traders/${encodeURIComponent(handle)}` : null

  return useSWR<TraderDetailResponse>(
    url,
    fetcher,
    {
      ...defaultConfig,
      revalidateOnFocus: false,
      refreshInterval: 5 * 60 * 1000, // 5 分钟刷新（enrichment 每 6 小时更新）
    }
  )
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
  const url = handle ? `/api/traders/${encodeURIComponent(handle)}/equity` : null

  return useSWR<EquityResponse>(
    url,
    fetcher,
    {
      ...defaultConfig,
      revalidateOnFocus: false,
      refreshInterval: 60 * 60 * 1000, // 60 分钟刷新资金曲线（enrichment 每 4-6 小时更新）
    }
  )
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
  const url = handle ? `/api/traders/${encodeURIComponent(handle)}/positions` : null

  return useSWR<PositionsResponse>(
    url,
    fetcher,
    {
      ...defaultConfig,
      refreshInterval: 5 * 60 * 1000, // 5 分钟刷新持仓（位置数据不需要亚分钟级刷新）
    }
  )
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

  return useSWR<PostsResponse>(
    enabled ? url : null,
    fetcher,
    {
      ...defaultConfig,
      revalidateOnFocus: false,
      refreshInterval: 60 * 1000, // 优化为 1 分钟刷新，减少请求频率
    }
  )
}

/**
 * 无限加载帖子列表
 */
export function usePostsInfinite(options: UsePostsOptions = {}) {
  const { groupId, sortBy = 'created_at', limit = 20, enabled = true } = options

  const getKey = (pageIndex: number, previousPageData: PostsResponse | null) => {
    if (!enabled) return null
    if (previousPageData && !previousPageData.hasMore) return null

    const params = new URLSearchParams()
    if (groupId) params.set('group_id', groupId)
    if (sortBy) params.set('sort_by', sortBy)
    params.set('limit', String(limit))
    params.set('offset', String(pageIndex * limit))

    return `/api/posts?${params.toString()}`
  }

  const config: SWRInfiniteConfiguration<PostsResponse> = {
    revalidateOnFocus: false,
    revalidateFirstPage: false,
    initialSize: 1,
    errorRetryCount: 2,
  }

  return useSWRInfinite<PostsResponse>(getKey, fetcher, config)
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
  const url = postId ? `/api/posts/${postId}` : null

  return useSWR<PostDetailResponse>(
    url,
    fetcher,
    {
      ...defaultConfig,
      revalidateOnFocus: false,
    }
  )
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
  return useSWR<MarketData>(
    '/api/market',
    fetcher,
    {
      ...defaultConfig,
      refreshInterval: 30 * 1000, // 优化为 30 秒刷新，减少请求频率
      revalidateOnFocus: false, // Already refreshing every 30s; focus refetch adds flicker
    }
  )
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
  const url = handle ? `/api/users/${encodeURIComponent(handle)}` : null

  return useSWR<UserProfile>(
    url,
    () => (url ? fetcherWithAuth(url, token) : Promise.reject('No URL')),
    {
      ...defaultConfig,
      revalidateOnFocus: false,
    }
  )
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
  const url = userId ? '/api/notifications' : null

  return useSWR<NotificationsResponse>(
    url,
    () => (url ? fetcherWithAuth(url, token) : Promise.reject('No URL')),
    {
      ...defaultConfig,
      refreshInterval: 60 * 1000, // 优化为 1 分钟刷新，减少请求频率
      revalidateOnFocus: false, // Already refreshing every 60s; focus refetch adds redundant request
    }
  )
}

// ============================================
// 缓存操作工具
// ============================================

/**
 * 手动刷新指定 key 的缓存
 */
export function refreshCache(key: string) {
  return globalMutate(key)
}

/**
 * 刷新所有匹配模式的缓存
 */
export function refreshCacheByPattern(pattern: RegExp) {
  return globalMutate(
    (key: string) => typeof key === 'string' && pattern.test(key),
    undefined,
    { revalidate: true }
  )
}

/**
 * 清除指定 key 的缓存
 */
export function clearCache(key: string) {
  return globalMutate(key, undefined, { revalidate: false })
}

/**
 * 预填充缓存数据
 */
export function prefillCache<T>(key: string, data: T) {
  return globalMutate(key, data, { revalidate: false })
}

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
