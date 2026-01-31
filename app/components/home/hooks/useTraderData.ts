'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import { useTraderDataSync, type TraderDataPayload } from '@/lib/hooks/useBroadcastSync'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export type TimeRange = '90D' | '30D' | '7D'
export type SortBy = 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown'
export type SortOrder = 'asc' | 'desc'

// 本地存储 key
const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'

// Feature 4: Stale threshold for visibility-based refresh (5 minutes)
const STALE_THRESHOLD_MS = 5 * 60 * 1000

interface CachedData {
  traders: Trader[]
  lastUpdated: string | null
  fetchedAt: number // timestamp when data was fetched
  availableSources?: string[] // 所有可用来源
}

interface UseTraderDataOptions {
  autoRefreshInterval?: number // 自动刷新间隔（毫秒）
  sortBy?: SortBy
  sortOrder?: SortOrder
  initialTraders?: Trader[] // Server-side pre-fetched traders for SSR
  initialLastUpdated?: string | null // Server-side last updated timestamp
}

// 全局请求去重 Map（跨组件实例共享，避免并发重复请求）
const pendingRequests = new Map<string, Promise<CachedData>>()

export function useTraderData(options: UseTraderDataOptions = {}) {
  // Feature 4: Default 5 min refresh when visible (reduced from 10 min)
  const {
    autoRefreshInterval = 5 * 60 * 1000,
    sortBy,
    sortOrder,
    initialTraders,
    initialLastUpdated,
  } = options

  const { t } = useLanguage()
  // Ref to avoid triggering useCallback re-creation when t changes
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])

  // Use initial data if provided (SSR optimization)
  const hasInitialData = initialTraders && initialTraders.length > 0

  // 使用 Map 缓存已加载的数据
  const tradersCache = useRef<Map<string, CachedData>>(new Map())
  const [currentTraders, setCurrentTraders] = useState<Trader[]>(initialTraders || [])
  const [loading, setLoading] = useState(!hasInitialData) // Don't show loading if we have initial data
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(initialLastUpdated || null)
  const [availableSources, setAvailableSources] = useState<string[]>([])
  const [deferredFetchFailed, setDeferredFetchFailed] = useState(false)

  // 多窗口同步
  const { broadcast, on } = useTraderDataSync()

  // 时间范围状态 - 固定初始值避免 hydration mismatch
  const [activeTimeRange, setActiveTimeRange] = useState<TimeRange>('90D')

  // 客户端 hydration 后从 localStorage 读取偏好
  useEffect(() => {
    const saved = localStorage.getItem(TIME_RANGE_STORAGE_KEY)
    if (saved === '90D' || saved === '30D' || saved === '7D') {
      setActiveTimeRange(saved)
    }
  }, [])

  // 监听其他窗口的数据更新
  useEffect(() => {
    const unsubscribe = on('TRADER_DATA_UPDATED', (payload: TraderDataPayload) => {
      // 只处理当前时间段的数据
      if (payload.timeRange === activeTimeRange) {
        // 更新本地缓存和状态
        const cached: CachedData = {
          traders: payload.traders as Trader[],
          lastUpdated: payload.lastUpdated,
          fetchedAt: Date.now(),
        }
        tradersCache.current.set(activeTimeRange, cached)
        setCurrentTraders(cached.traders)
        setLastUpdated(cached.lastUpdated)
      }
    })

    return unsubscribe
  }, [activeTimeRange, on])

  // 加载单个时间段数据（含请求去重）
  // 使用渐进式加载：先快速加载 50 条显示，再后台加载完整 1000 条
  const loadTimeRange = useCallback(async (timeRange: TimeRange, forceRefresh = false): Promise<CachedData> => {
    // 检查缓存（非强制刷新时）
    if (!forceRefresh && tradersCache.current.has(timeRange)) {
      const cached = tradersCache.current.get(timeRange)
      // 如果缓存数据足够多（>100条），直接返回
      if (cached && cached.traders.length > 100) {
        return cached
      }
    }

    // 请求去重：如果有相同 key 的请求正在进行，复用该 Promise
    const cacheKey = `${timeRange}-${forceRefresh ? 'force' : 'normal'}`
    if (pendingRequests.has(cacheKey)) {
      return pendingRequests.get(cacheKey)!
    }

    const requestPromise = (async (): Promise<CachedData> => {
      try {
        // Feature 1: Include sort params in fetch URL
        // Load enough data for client-side search/sort. RankingTable caps at 1000 (slice(0,1000)).
        // SSR already provides 50 traders; 500 here covers filtering while being 83% smaller than 3000.
        let url = `/api/traders?timeRange=${timeRange}&limit=500`
        if (sortBy && sortBy !== 'arena_score') {
          url += `&sortBy=${sortBy}&order=${sortOrder || 'desc'}`
        }
        const response = await fetch(url)
        if (!response.ok) {
          const errorMsg = `${tRef.current('loadFailed')} (${response.status})`
          setError(errorMsg)
          return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
        }
        const data = await response.json()
        const cached: CachedData = {
          traders: data.traders || [],
          lastUpdated: data.lastUpdated || null,
          fetchedAt: Date.now(),
          availableSources: data.availableSources || [],
        }

        // 更新缓存
        tradersCache.current.set(timeRange, cached)
        setError(null)

        // 广播数据更新到其他窗口
        broadcast('TRADER_DATA_UPDATED', {
          timeRange,
          traders: cached.traders,
          lastUpdated: cached.lastUpdated || '',
        })

        return cached
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : tRef.current('errorNetworkFailed')
        setError(errorMsg)
        return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
      } finally {
        // 请求完成后移除 pending 标记
        pendingRequests.delete(cacheKey)
      }
    })()

    pendingRequests.set(cacheKey, requestPromise)
    return requestPromise
  }, [broadcast, sortBy, sortOrder])

  // 加载当前选中时间段的数据
  const loadCurrentData = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const cached = await loadTimeRange(activeTimeRange, forceRefresh)
      setCurrentTraders(cached.traders)
      setLastUpdated(cached.lastUpdated)
      setAvailableSources(cached.availableSources || [])
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : tRef.current('loadFailed')
      setError(errorMsg)
      setCurrentTraders([])
      setLastUpdated(null)
      setAvailableSources([])
    } finally {
      setLoading(false)
    }
  }, [activeTimeRange, loadTimeRange])

  // Seed cache with initial data if provided
  const initialDataSeeded = useRef(false)
  useEffect(() => {
    if (hasInitialData && !initialDataSeeded.current) {
      initialDataSeeded.current = true
      // Seed the cache with initial data for 90D
      tradersCache.current.set('90D', {
        traders: initialTraders!,
        lastUpdated: initialLastUpdated || null,
        fetchedAt: Date.now(),
      })
    }
  }, [hasInitialData, initialTraders, initialLastUpdated])

  // 初次加载和时间段切换时加载数据
  // Skip initial fetch if we have server-provided data for 90D
  // Performance: Defer full data fetch until after LCP using requestIdleCallback
  useEffect(() => {
    // If we have initial data and we're on 90D, defer full fetch to avoid blocking LCP
    if (hasInitialData && activeTimeRange === '90D') {
      // Use initial data immediately - don't block for full fetch
      setLoading(false)

      // Defer full 500 trader fetch until browser is idle (after LCP)
      const deferredFetch = () => {
        // Only fetch full data if user hasn't switched time range
        if (activeTimeRange === '90D') {
          setDeferredFetchFailed(false)
          loadTimeRange('90D', false).then(cached => {
            // Only update if we got more data than initial
            if (cached.traders.length > (initialTraders?.length || 0)) {
              setCurrentTraders(cached.traders)
              setLastUpdated(cached.lastUpdated)
              setAvailableSources(cached.availableSources || [])
            }
          }).catch(() => {
            // Graceful degradation — we still have initial data but flag the failure
            // so UI can optionally show a retry prompt
            setDeferredFetchFailed(true)
          })
        }
      }

      // Use requestIdleCallback to defer fetch, with 3s timeout fallback
      if ('requestIdleCallback' in window) {
        const idleId = requestIdleCallback(deferredFetch, { timeout: 3000 })
        return () => cancelIdleCallback(idleId)
      } else {
        // Safari fallback: wait 2s after page load
        const timerId = setTimeout(deferredFetch, 2000)
        return () => clearTimeout(timerId)
      }
    }

    // If cache already has this time range, use it
    if (tradersCache.current.has(activeTimeRange)) {
      const cached = tradersCache.current.get(activeTimeRange)!
      setCurrentTraders(cached.traders)
      setLastUpdated(cached.lastUpdated)
      setAvailableSources(cached.availableSources || [])
      setLoading(false)
      return
    }
    loadCurrentData()
  }, [loadCurrentData, activeTimeRange, hasInitialData, loadTimeRange, initialTraders?.length])

  // 保存时间段偏好到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, activeTimeRange)
    }
  }, [activeTimeRange])
  
  // Feature 4: Smarter auto-refresh with Page Visibility API
  useEffect(() => {
    if (autoRefreshInterval <= 0) return

    let intervalId: ReturnType<typeof setInterval> | null = null

    const silentRefresh = () => {
      loadTimeRange(activeTimeRange, true)
        .then(cached => {
          setCurrentTraders(cached.traders)
          setLastUpdated(cached.lastUpdated)
          setAvailableSources(cached.availableSources || [])
        })
        .catch(() => {
          // Silent refresh failure - loadTimeRange already sets error
        })
    }

    const startInterval = () => {
      if (intervalId) clearInterval(intervalId)
      intervalId = setInterval(silentRefresh, autoRefreshInterval)
    }

    const stopInterval = () => {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab hidden: pause refresh
        stopInterval()
      } else {
        // Tab visible: check if data is stale
        const cached = tradersCache.current.get(activeTimeRange)
        const isStale = !cached || (Date.now() - cached.fetchedAt > STALE_THRESHOLD_MS)
        if (isStale) {
          silentRefresh()
        }
        startInterval()
      }
    }

    // Start interval only if tab is visible
    if (!document.hidden) {
      startInterval()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      stopInterval()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [autoRefreshInterval, activeTimeRange, loadTimeRange])

  // 切换时间段
  const changeTimeRange = useCallback((range: TimeRange) => {
    setActiveTimeRange(range)
  }, [])

  // 刷新数据
  const refresh = useCallback(() => {
    return loadCurrentData(true)
  }, [loadCurrentData])

  // 清除缓存
  const clearCache = useCallback(() => {
    tradersCache.current.clear()
  }, [])

  // Retry deferred fetch (called from UI when deferredFetchFailed is true)
  const retryDeferredFetch = useCallback(() => {
    setDeferredFetchFailed(false)
    loadTimeRange(activeTimeRange, false).then(cached => {
      if (cached.traders.length > currentTraders.length) {
        setCurrentTraders(cached.traders)
        setLastUpdated(cached.lastUpdated)
        setAvailableSources(cached.availableSources || [])
      }
    }).catch(() => {
      setDeferredFetchFailed(true)
    })
  }, [activeTimeRange, loadTimeRange, currentTraders.length])

  return {
    traders: currentTraders,
    loading,
    error,
    activeTimeRange,
    lastUpdated,
    availableSources,
    changeTimeRange,
    refresh,
    clearCache,
    deferredFetchFailed,
    retryDeferredFetch,
  }
}
