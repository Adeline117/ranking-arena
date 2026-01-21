/**
 * 数据获取 Hook
 * 提供缓存、乐观更新、请求去重等功能
 */

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

// ============================================
// 类型定义
// ============================================

interface FetchState<T> {
  data: T | null
  error: Error | null
  isLoading: boolean
  isValidating: boolean
}

interface UseFetchOptions<T> {
  /** 初始数据 */
  initialData?: T
  /** 缓存时间（毫秒） */
  cacheTime?: number
  /** 失效时间（毫秒） */
  staleTime?: number
  /** 是否在挂载时自动获取 */
  fetchOnMount?: boolean
  /** 是否在窗口聚焦时重新获取 */
  revalidateOnFocus?: boolean
  /** 是否在网络恢复时重新获取 */
  revalidateOnReconnect?: boolean
  /** 轮询间隔（毫秒） */
  refreshInterval?: number
  /** 错误重试次数 */
  retryCount?: number
  /** 重试延迟（毫秒） */
  retryDelay?: number
  /** 数据变换函数 */
  transform?: (data: unknown) => T
  /** 依赖项（变化时重新获取） */
  deps?: unknown[]
}

// ============================================
// 缓存管理
// ============================================

interface CacheEntry<T> {
  data: T
  timestamp: number
  expiresAt: number
}

const cache = new Map<string, CacheEntry<unknown>>()
const pendingRequests = new Map<string, Promise<unknown>>()

function getCacheKey(key: string | string[]): string {
  return Array.isArray(key) ? key.join(':') : key
}

function getFromCache<T>(key: string, staleTime: number): { data: T; isStale: boolean } | null {
  const entry = cache.get(key) as CacheEntry<T> | undefined
  if (!entry) return null

  const now = Date.now()
  if (now > entry.expiresAt) {
    cache.delete(key)
    return null
  }

  return {
    data: entry.data,
    isStale: now - entry.timestamp > staleTime,
  }
}

function setCache<T>(key: string, data: T, cacheTime: number): void {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    expiresAt: Date.now() + cacheTime,
  })
}

// ============================================
// 主 Hook
// ============================================

/**
 * 通用数据获取 Hook
 * 
 * @example
 * ```tsx
 * const { data, error, isLoading, refetch } = useFetch(
 *   ['traders', timeRange],
 *   () => fetch(`/api/traders?timeRange=${timeRange}`).then(r => r.json()),
 *   { staleTime: 60000 }
 * )
 * ```
 */
export function useFetch<T>(
  key: string | string[] | null,
  fetcher: () => Promise<T>,
  options: UseFetchOptions<T> = {}
): FetchState<T> & { refetch: () => Promise<void>; mutate: (data: T | ((prev: T | null) => T)) => void } {
  const {
    initialData,
    cacheTime = 5 * 60 * 1000, // 5 分钟
    staleTime = 0,
    fetchOnMount = true,
    revalidateOnFocus = true,
    revalidateOnReconnect = true,
    refreshInterval,
    retryCount = 3,
    retryDelay = 1000,
    transform,
    deps = [],
  } = options

  const cacheKey = key ? getCacheKey(key) : null
  const [state, setState] = useState<FetchState<T>>(() => {
    // 初始化时从缓存获取
    if (cacheKey) {
      const cached = getFromCache<T>(cacheKey, staleTime)
      if (cached) {
        return {
          data: cached.data,
          error: null,
          isLoading: false,
          isValidating: cached.isStale,
        }
      }
    }
    return {
      data: initialData ?? null,
      error: null,
      isLoading: fetchOnMount && !!key,
      isValidating: false,
    }
  })

  const mountedRef = useRef(true)
  const retryCountRef = useRef(0)

  // 执行请求
  const doFetch = useCallback(async (isRevalidating = false) => {
    if (!cacheKey) return

    // 请求去重
    const pending = pendingRequests.get(cacheKey)
    if (pending) {
      try {
        const data = await pending as T
        if (mountedRef.current) {
          setState(prev => ({
            ...prev,
            data: transform ? transform(data) : data,
            isLoading: false,
            isValidating: false,
          }))
        }
      } catch {}
      return
    }

    if (!isRevalidating) {
      setState(prev => ({ ...prev, isLoading: true, error: null }))
    } else {
      setState(prev => ({ ...prev, isValidating: true }))
    }

    const fetchPromise = fetcher()
    pendingRequests.set(cacheKey, fetchPromise)

    try {
      const rawData = await fetchPromise
      const data = transform ? transform(rawData) : rawData as T

      if (mountedRef.current) {
        setState({
          data,
          error: null,
          isLoading: false,
          isValidating: false,
        })
        setCache(cacheKey, data, cacheTime)
      }
      retryCountRef.current = 0
    } catch (err) {
      if (mountedRef.current) {
        // 重试逻辑
        if (retryCountRef.current < retryCount) {
          retryCountRef.current++
          setTimeout(() => doFetch(isRevalidating), retryDelay * retryCountRef.current)
          return
        }

        setState(prev => ({
          ...prev,
          error: err instanceof Error ? err : new Error(String(err)),
          isLoading: false,
          isValidating: false,
        }))
      }
    } finally {
      pendingRequests.delete(cacheKey)
    }
  }, [cacheKey, fetcher, cacheTime, retryCount, retryDelay, transform])

  // 手动刷新
  const refetch = useCallback(async () => {
    retryCountRef.current = 0
    await doFetch(false)
  }, [doFetch])

  // 乐观更新
  const mutate = useCallback((updater: T | ((prev: T | null) => T)) => {
    setState(prev => ({
      ...prev,
      data: typeof updater === 'function' 
        ? (updater as (prev: T | null) => T)(prev.data) 
        : updater,
    }))
    if (cacheKey) {
      const newData = typeof updater === 'function'
        ? (updater as (prev: T | null) => T)(state.data)
        : updater
      setCache(cacheKey, newData, cacheTime)
    }
  }, [cacheKey, cacheTime, state.data])

  // 挂载时获取
  useEffect(() => {
    mountedRef.current = true
    if (fetchOnMount && key) {
      // 检查缓存
      const cached = cacheKey ? getFromCache<T>(cacheKey, staleTime) : null
      if (cached && !cached.isStale) {
        setState({
          data: cached.data,
          error: null,
          isLoading: false,
          isValidating: false,
        })
      } else {
        doFetch(!!cached)
      }
    }
    return () => {
      mountedRef.current = false
    }
  }, [key, cacheKey, ...deps])

  // 窗口聚焦时重新获取
  useEffect(() => {
    if (!revalidateOnFocus || !key) return

    const onFocus = () => {
      const cached = cacheKey ? getFromCache<T>(cacheKey, staleTime) : null
      if (!cached || cached.isStale) {
        doFetch(true)
      }
    }

    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [revalidateOnFocus, key, cacheKey, staleTime, doFetch])

  // 网络恢复时重新获取
  useEffect(() => {
    if (!revalidateOnReconnect || !key) return

    const onOnline = () => doFetch(true)
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [revalidateOnReconnect, key, doFetch])

  // 轮询
  useEffect(() => {
    if (!refreshInterval || !key) return

    const timer = setInterval(() => doFetch(true), refreshInterval)
    return () => clearInterval(timer)
  }, [refreshInterval, key, doFetch])

  return { ...state, refetch, mutate }
}

// ============================================
// 便捷 Hooks
// ============================================

/**
 * 获取交易员列表
 */
export function useTraders(timeRange: string = '90D') {
  return useFetch(
    ['traders', timeRange],
    async () => {
      const res = await fetch(`/api/traders?timeRange=${timeRange}`)
      if (!res.ok) throw new Error('获取交易员列表失败')
      const data = await res.json()
      return data.traders
    },
    {
      staleTime: 60000, // 1 分钟
      revalidateOnFocus: true,
    }
  )
}

/**
 * 获取帖子列表
 */
export function usePosts(options: { limit?: number; offset?: number; groupId?: string } = {}) {
  const { limit = 20, offset = 0, groupId } = options
  
  return useFetch(
    ['posts', String(limit), String(offset), groupId || ''],
    async () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (groupId) params.set('group_id', groupId)
      
      const res = await fetch(`/api/posts?${params}`)
      if (!res.ok) throw new Error('获取帖子列表失败')
      const data = await res.json()
      return data.data?.posts || []
    },
    {
      staleTime: 30000, // 30 秒
    }
  )
}

/**
 * 获取单个交易员详情
 */
export function useTraderDetail(handle: string | undefined) {
  return useFetch(
    handle ? ['trader', handle] : null,
    async () => {
      const res = await fetch(`/api/traders/${encodeURIComponent(handle!)}`)
      if (!res.ok) throw new Error('获取交易员详情失败')
      return res.json()
    },
    {
      staleTime: 120000, // 2 分钟
    }
  )
}

// ============================================
// 清除缓存
// ============================================

export function invalidateCache(keyPattern?: string | RegExp): void {
  if (!keyPattern) {
    cache.clear()
    return
  }

  if (typeof keyPattern === 'string') {
    cache.delete(keyPattern)
    return
  }

  for (const key of cache.keys()) {
    if (keyPattern.test(key)) {
      cache.delete(key)
    }
  }
}
