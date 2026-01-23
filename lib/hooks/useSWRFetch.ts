/**
 * SWR 数据获取层
 * 
 * 功能:
 * - 自动缓存和重验证
 * - 错误重试
 * - 乐观更新
 * - 请求去重
 * - 焦点重验证
 */

'use client'

import useSWR, { SWRConfiguration, mutate as globalMutate } from 'swr'
import useSWRMutation from 'swr/mutation'
import { supabase } from '@/lib/supabase/client'
import { useState, useEffect } from 'react'

// ============================================
// 基础 Fetcher
// ============================================

type FetcherOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  headers?: Record<string, string>
}

/**
 * 通用 API fetcher
 * 自动添加认证 token
 */
export async function apiFetcher<T>(
  url: string,
  options: FetcherOptions = {}
): Promise<T> {
  const { method = 'GET', body, headers = {} } = options
  
  // 获取当前 session token
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  }
  
  if (token) {
    requestHeaders['Authorization'] = `Bearer ${token}`
  }
  
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'include',
  })
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: '请求失败' }))
    throw new Error(error.message || error.error || `HTTP ${response.status}`)
  }
  
  const data = await response.json()
  
  // 支持标准响应格式: { success: true, data: ... } 或直接返回数据
  return data.data !== undefined ? data.data : data
}

/**
 * SWR 默认配置
 */
export const swrDefaultConfig: SWRConfiguration = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  shouldRetryOnError: true,
  errorRetryCount: 3,
  errorRetryInterval: 1000,
  dedupingInterval: 2000,
  focusThrottleInterval: 5000,
}

// ============================================
// 交易员相关 Hooks
// ============================================

export type Trader = {
  id: string
  handle: string
  nickname?: string
  avatar_url?: string
  source: string
  source_trader_id: string
  roi_7d?: number
  roi_30d?: number
  roi_90d?: number
  arena_score?: number
  followers?: number
  copiers?: number
  aum?: number
}

export type TraderPerformance = {
  roi_7d?: number
  roi_30d?: number
  roi_90d?: number
  pnl_7d?: number
  pnl_30d?: number
  pnl_90d?: number
  win_rate?: number
  max_drawdown?: number
  sharpe_ratio?: number
  arena_score?: number
}

/**
 * 获取交易员列表
 */
export function useTraders(options?: {
  timeRange?: '7d' | '30d' | '90d'
  limit?: number
  source?: string
}) {
  const { timeRange = '7d', limit = 50, source } = options || {}
  
  const params = new URLSearchParams({
    time_range: timeRange,
    limit: String(limit),
    ...(source && { source }),
  })
  
  return useSWR<{ traders: Trader[]; total: number }>(
    `/api/traders?${params}`,
    apiFetcher,
    {
      ...swrDefaultConfig,
      revalidateOnFocus: false, // 列表页不需要焦点重验证
      dedupingInterval: 5000,
    }
  )
}

/**
 * 获取单个交易员详情
 */
export function useTrader(handle: string | null) {
  return useSWR<Trader>(
    handle ? `/api/traders/${handle}` : null,
    apiFetcher,
    swrDefaultConfig
  )
}

/**
 * 获取交易员完整数据 (聚合)
 */
export function useTraderFull(handle: string | null) {
  return useSWR<{
    trader: Trader
    performance: TraderPerformance
    stats: Record<string, unknown>
    portfolio: unknown[]
    positions: unknown[]
  }>(
    handle ? `/api/traders/${handle}/full` : null,
    apiFetcher,
    {
      ...swrDefaultConfig,
      dedupingInterval: 10000, // 10秒去重
    }
  )
}

// ============================================
// 用户相关 Hooks
// ============================================

export type User = {
  id: string
  handle: string
  nickname?: string
  avatar_url?: string
  bio?: string
  subscription_tier?: 'free' | 'pro'
  follower_count?: number
  following_count?: number
}

/**
 * 获取用户资料
 */
export function useUser(handle: string | null) {
  return useSWR<User>(
    handle ? `/api/users/${handle}` : null,
    apiFetcher,
    swrDefaultConfig
  )
}

/**
 * 获取用户完整数据 (聚合)
 */
export function useUserFull(handle: string | null) {
  return useSWR<{
    profile: User
    stats: Record<string, unknown>
    posts: unknown[]
    groups: unknown[]
  }>(
    handle ? `/api/users/${handle}/full` : null,
    apiFetcher,
    {
      ...swrDefaultConfig,
      dedupingInterval: 10000,
    }
  )
}

/**
 * 获取当前登录用户
 */
export function useCurrentUser() {
  const [userId, setUserId] = useState<string | null>(null)
  
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id || null)
    })
    
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id || null)
    })
    
    return () => subscription.unsubscribe()
  }, [])
  
  return useSWR<User>(
    userId ? `/api/users/me` : null,
    apiFetcher,
    {
      ...swrDefaultConfig,
      revalidateOnFocus: true,
    }
  )
}

// ============================================
// 帖子相关 Hooks
// ============================================

export type Post = {
  id: string
  title: string
  content?: string
  author_handle: string
  author_avatar_url?: string
  created_at: string
  like_count: number
  comment_count: number
  group_id?: string
  group_name?: string
}

/**
 * 获取帖子列表
 */
export function usePosts(options?: {
  groupId?: string
  authorHandle?: string
  sortBy?: 'created_at' | 'like_count' | 'hot_score'
  limit?: number
}) {
  const { groupId, authorHandle, sortBy = 'created_at', limit = 20 } = options || {}
  
  const params = new URLSearchParams({
    sort_by: sortBy,
    sort_order: 'desc',
    limit: String(limit),
    ...(groupId && { group_id: groupId }),
    ...(authorHandle && { author_handle: authorHandle }),
  })
  
  return useSWR<{ posts: Post[] }>(
    `/api/posts?${params}`,
    apiFetcher,
    {
      ...swrDefaultConfig,
      revalidateOnFocus: false,
    }
  )
}

/**
 * 获取单个帖子
 */
export function usePost(postId: string | null) {
  return useSWR<Post>(
    postId ? `/api/posts/${postId}` : null,
    apiFetcher,
    swrDefaultConfig
  )
}

// ============================================
// 小组相关 Hooks
// ============================================

export type Group = {
  id: string
  name: string
  description?: string
  avatar_url?: string
  member_count: number
  post_count: number
  is_premium_only?: boolean
  created_at: string
}

/**
 * 获取小组列表
 */
export function useGroups(options?: {
  limit?: number
  sortBy?: 'member_count' | 'created_at'
}) {
  const { limit = 20, sortBy = 'member_count' } = options || {}
  
  const params = new URLSearchParams({
    limit: String(limit),
    sort_by: sortBy,
  })
  
  return useSWR<{ groups: Group[] }>(
    `/api/groups?${params}`,
    apiFetcher,
    {
      ...swrDefaultConfig,
      revalidateOnFocus: false,
    }
  )
}

/**
 * 获取单个小组
 */
export function useGroup(groupId: string | null) {
  return useSWR<Group>(
    groupId ? `/api/groups/${groupId}` : null,
    apiFetcher,
    swrDefaultConfig
  )
}

// ============================================
// 通知相关 Hooks
// ============================================

export type Notification = {
  id: string
  type: string
  title: string
  message?: string
  read: boolean
  created_at: string
  data?: Record<string, unknown>
}

/**
 * 获取通知列表
 */
export function useNotifications(options?: {
  unreadOnly?: boolean
  limit?: number
}) {
  const { unreadOnly = false, limit = 50 } = options || {}
  
  const params = new URLSearchParams({
    limit: String(limit),
    ...(unreadOnly && { unread_only: 'true' }),
  })
  
  return useSWR<{ notifications: Notification[]; unread_count: number }>(
    `/api/notifications?${params}`,
    apiFetcher,
    {
      ...swrDefaultConfig,
      refreshInterval: 30000, // 30秒自动刷新
    }
  )
}

// ============================================
// Mutation Hooks
// ============================================

/**
 * 通用 mutation fetcher
 */
async function mutationFetcher<T>(
  url: string,
  { arg }: { arg: { method: 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown } }
): Promise<T> {
  return apiFetcher(url, arg)
}

/**
 * 帖子点赞 mutation
 */
export function usePostLikeMutation(postId: string) {
  return useSWRMutation(
    `/api/posts/${postId}/like`,
    mutationFetcher,
    {
      onSuccess: () => {
        // 重新验证帖子列表
        globalMutate((key) => typeof key === 'string' && key.startsWith('/api/posts'))
      },
    }
  )
}

/**
 * 关注用户 mutation
 */
export function useFollowMutation() {
  return useSWRMutation(
    '/api/follow',
    mutationFetcher,
    {
      onSuccess: () => {
        globalMutate((key) => typeof key === 'string' && key.includes('/api/users/'))
      },
    }
  )
}

// ============================================
// 工具函数
// ============================================

/**
 * 手动重新验证缓存
 */
export function revalidate(keyPattern: string | RegExp) {
  if (typeof keyPattern === 'string') {
    globalMutate(keyPattern)
  } else {
    globalMutate((key) => typeof key === 'string' && keyPattern.test(key))
  }
}

/**
 * 清除所有缓存
 */
export function clearAllCache() {
  globalMutate(() => true, undefined, { revalidate: false })
}

/**
 * 预加载数据
 */
export function prefetch<T>(url: string): Promise<T> {
  return apiFetcher<T>(url).then((data) => {
    globalMutate(url, data, { revalidate: false })
    return data
  })
}

const swrFetchHooks = {
  useTraders,
  useTrader,
  useTraderFull,
  useUser,
  useUserFull,
  useCurrentUser,
  usePosts,
  usePost,
  useGroups,
  useGroup,
  useNotifications,
  revalidate,
  clearAllCache,
  prefetch,
}
export default swrFetchHooks
