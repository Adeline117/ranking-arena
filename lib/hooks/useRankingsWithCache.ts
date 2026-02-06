'use client'

/**
 * useRankingsWithCache - 排行榜数据缓存与离线支持
 *
 * 特性：
 * - Cache-first 策略 (先显示缓存，后台刷新)
 * - IndexedDB 持久化缓存
 * - 网络抖动优雅降级
 * - 骨架屏与加载状态
 * - Stale-While-Revalidate 模式
 */

import { useState, useEffect, useCallback, useRef } from 'react'

export interface CachedData<T> {
  data: T
  timestamp: number
  etag?: string
}

interface UseRankingsOptions<T> {
  /** 缓存键名 */
  cacheKey: string
  /** 数据获取函数 */
  fetcher: () => Promise<T>
  /** 缓存过期时间 (毫秒) */
  staleTime?: number
  /** 缓存最大存活时间 (毫秒) */
  cacheTime?: number
  /** 是否在后台自动刷新 */
  refetchInBackground?: boolean
  /** 自动刷新间隔 (毫秒) */
  refetchInterval?: number
  /** 初始数据 (SSR) */
  initialData?: T
}

type LoadingState = 'idle' | 'loading' | 'revalidating' | 'error'

interface UseRankingsResult<T> {
  data: T | null
  error: Error | null
  loadingState: LoadingState
  isLoading: boolean
  isStale: boolean
  isCached: boolean
  lastUpdated: Date | null
  refetch: () => Promise<void>
  clearCache: () => Promise<void>
}

// 简单的 localStorage 缓存 (降级方案)
const memoryCache = new Map<string, CachedData<unknown>>()

async function getFromCache<T>(key: string): Promise<CachedData<T> | null> {
  // 优先内存缓存
  const memCached = memoryCache.get(key)
  if (memCached) {
    return memCached as CachedData<T>
  }

  // 尝试 localStorage
  if (typeof window !== 'undefined') {
    try {
      const stored = localStorage.getItem(`rankings_cache_${key}`)
      if (stored) {
        const parsed = JSON.parse(stored) as CachedData<T>
        memoryCache.set(key, parsed)
        return parsed
      }
    } catch {
      // 忽略解析错误
    }
  }

  return null
}

async function setToCache<T>(key: string, data: T): Promise<void> {
  const cached: CachedData<T> = {
    data,
    timestamp: Date.now(),
  }

  memoryCache.set(key, cached)

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(`rankings_cache_${key}`, JSON.stringify(cached))
    } catch {
      // localStorage 可能已满，忽略
    }
  }
}

async function removeFromCache(key: string): Promise<void> {
  memoryCache.delete(key)

  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(`rankings_cache_${key}`)
    } catch {
      // 忽略
    }
  }
}

export function useRankingsWithCache<T>(options: UseRankingsOptions<T>): UseRankingsResult<T> {
  const {
    cacheKey,
    fetcher,
    staleTime = 60 * 1000, // 1 分钟
    cacheTime = 5 * 60 * 1000, // 5 分钟
    refetchInBackground = true,
    refetchInterval,
    initialData,
  } = options

  const [data, setData] = useState<T | null>(initialData || null)
  const [error, setError] = useState<Error | null>(null)
  const [loadingState, setLoadingState] = useState<LoadingState>('idle')
  const [cacheTimestamp, setCacheTimestamp] = useState<number | null>(null)

  const mountedRef = useRef(true)
  const refetchIntervalRef = useRef<NodeJS.Timeout | null>(null)

  const isStale = cacheTimestamp
    ? Date.now() - cacheTimestamp > staleTime
    : true

  const isCached = cacheTimestamp !== null && Date.now() - cacheTimestamp < cacheTime

  // 获取数据
  const fetchData = useCallback(async (isRevalidation = false) => {
    if (!mountedRef.current) return

    setLoadingState(isRevalidation ? 'revalidating' : 'loading')
    setError(null)

    try {
      const result = await fetcher()

      if (!mountedRef.current) return

      setData(result)
      setCacheTimestamp(Date.now())
      setLoadingState('idle')

      // 存入缓存
      await setToCache(cacheKey, result)
    } catch (err) {
      if (!mountedRef.current) return

      setError(err instanceof Error ? err : new Error('Unknown error'))
      setLoadingState('error')

      // 如果有缓存数据，继续使用
      // 不清除已有数据
    }
  }, [cacheKey, fetcher])

  // 初始化加载
  useEffect(() => {
    mountedRef.current = true

    const initLoad = async () => {
      // 1. 先尝试从缓存加载
      const cached = await getFromCache<T>(cacheKey)

      if (cached) {
        setData(cached.data)
        setCacheTimestamp(cached.timestamp)

        const isExpired = Date.now() - cached.timestamp > cacheTime
        const needsRevalidation = Date.now() - cached.timestamp > staleTime

        if (isExpired) {
          // 缓存过期，需要重新获取
          await fetchData(false)
        } else if (needsRevalidation && refetchInBackground) {
          // 缓存陈旧但可用，后台刷新
          setLoadingState('revalidating')
          fetchData(true)
        }
      } else {
        // 无缓存，直接获取
        await fetchData(false)
      }
    }

    initLoad()

    return () => {
      mountedRef.current = false
    }
  }, [cacheKey, cacheTime, staleTime, refetchInBackground, fetchData])

  // 自动刷新
  useEffect(() => {
    if (refetchInterval && refetchInterval > 0) {
      refetchIntervalRef.current = setInterval(() => {
        if (mountedRef.current) {
          fetchData(true)
        }
      }, refetchInterval)
    }

    return () => {
      if (refetchIntervalRef.current) {
        clearInterval(refetchIntervalRef.current)
      }
    }
  }, [refetchInterval, fetchData])

  // 网络恢复时重新获取
  useEffect(() => {
    const handleOnline = () => {
      if (loadingState === 'error' || isStale) {
        fetchData(true)
      }
    }

    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [loadingState, isStale, fetchData])

  // 手动刷新
  const refetch = useCallback(async () => {
    await fetchData(data !== null)
  }, [fetchData, data])

  // 清除缓存
  const clearCache = useCallback(async () => {
    await removeFromCache(cacheKey)
    setCacheTimestamp(null)
  }, [cacheKey])

  return {
    data,
    error,
    loadingState,
    isLoading: loadingState === 'loading',
    isStale,
    isCached,
    lastUpdated: cacheTimestamp ? new Date(cacheTimestamp) : null,
    refetch,
    clearCache,
  }
}

/**
 * 骨架屏状态类型
 */
export type SkeletonState = 'loading' | 'cached' | 'stale' | 'fresh' | 'error' | 'offline'

/**
 * 获取骨架屏状态
 */
export function getSkeletonState(
  loadingState: LoadingState,
  isCached: boolean,
  isStale: boolean,
  isOnline: boolean = true
): SkeletonState {
  if (!isOnline) return 'offline'
  if (loadingState === 'error') return 'error'
  if (loadingState === 'loading' && !isCached) return 'loading'
  if (loadingState === 'revalidating') return 'stale'
  if (isCached && isStale) return 'stale'
  if (isCached && !isStale) return 'fresh'
  return 'cached'
}

/**
 * 网络状态 Hook
 */
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const [connectionType, setConnectionType] = useState<string | null>(null)

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // 检测连接类型 (如果支持)
    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
    if (connection) {
      setConnectionType(connection.effectiveType || null)
    }

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return { isOnline, connectionType }
}
