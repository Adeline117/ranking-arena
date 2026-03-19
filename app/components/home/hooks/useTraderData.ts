'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import { useTraderDataSync, type TraderDataPayload } from '@/lib/hooks/useBroadcastSync'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

import { FIVE_MINUTES_MS } from '@/lib/constants/time'

export type TimeRange = '90D' | '30D' | '7D' | 'COMPOSITE'
export type SortBy = 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown'
export type SortOrder = 'asc' | 'desc'

// 本地存储 key
const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'

// Feature 4: Stale threshold for visibility-based refresh (5 minutes)
const STALE_THRESHOLD_MS = FIVE_MINUTES_MS

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
// AbortController Map for request cancellation
const abortControllers = new Map<string, AbortController>()
// Debounce timer for time range switching (prevents rapid-fire API calls)
let timeRangeDebounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 交易员数据获取与管理 Hook
 *
 * 核心功能：
 * - 按时间段（7D/30D/90D）获取排行榜交易员数据
 * - 内存缓存 + 请求去重，避免重复网络请求
 * - SSR 初始数据注入，配合 requestIdleCallback 延迟加载完整数据
 * - BroadcastChannel 多窗口数据同步
 * - Page Visibility API 智能刷新（隐藏时暂停，可见时检查过期）
 * - AbortController 请求取消（切换时间段时取消旧请求）
 *
 * @param options - 配置选项
 * @returns 交易员数据、加载状态、时间段控制等
 *
 * @example
 * ```tsx
 * const { traders, loading, activeTimeRange, changeTimeRange } = useTraderData({
 *   initialTraders: serverTraders,
 *   initialLastUpdated: serverTimestamp,
 * })
 * ```
 */
export function useTraderData(options: UseTraderDataOptions = {}) {
  // Feature 4: Default 5 min refresh when visible (reduced from 10 min)
  const {
    autoRefreshInterval = FIVE_MINUTES_MS,
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
  const [isChangingTimeRange, setIsChangingTimeRange] = useState(false)

  // 多窗口同步
  const { broadcast, on } = useTraderDataSync()

  // 时间范围状态 - 固定初始值避免 hydration mismatch
  const [activeTimeRange, setActiveTimeRange] = useState<TimeRange>('90D')

  // 客户端 hydration 后从 URL params 或 localStorage 读取偏好
  // URL param (?window=7d) takes priority for shareable links
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlWindow = params.get('window')?.toUpperCase()
    if (urlWindow === '90D' || urlWindow === '30D' || urlWindow === '7D') {
      setActiveTimeRange(urlWindow)
      return
    }
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

    // Cancel any existing request for this time range
    const existingController = abortControllers.get(timeRange)
    if (existingController) {
      existingController.abort()
    }
    const controller = new AbortController()
    abortControllers.set(timeRange, controller)

    const requestPromise = (async (): Promise<CachedData> => {
      try {
        // Progressive loading: fetch 200 initially (covers 4+ pages of pagination).
        // Full 1000 only loaded when user searches or scrolls past page 4.
        const fetchLimit = forceRefresh ? 200 : 200
        let url: string
        if (timeRange === 'COMPOSITE') {
          url = `/api/rankings?window=composite&limit=${fetchLimit}`
          if (sortBy && sortBy !== 'arena_score') {
            url += `&sort_by=${sortBy}&sort_dir=${sortOrder || 'desc'}`
          }
        } else {
          url = `/api/traders?timeRange=${timeRange}&limit=${fetchLimit}`
          if (sortBy && sortBy !== 'arena_score') {
            url += `&sortBy=${sortBy}&order=${sortOrder || 'desc'}`
          }
        }
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) {
          const errorMsg = `${tRef.current('loadFailed')} (${response.status})`
          setError(errorMsg)
          return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
        }

        // Safe JSON parsing
        let data
        try {
          data = await response.json()
        } catch (_parseError) {
          const errorMsg = tRef.current('errorDataFormat') || '数据格式错误'
          setError(errorMsg)
          return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
        }
        // Normalize response shape (rankings API has different structure)
        let normalizedTraders = data.traders || []
        if (timeRange === 'COMPOSITE' && normalizedTraders.length > 0 && normalizedTraders[0].trader_key) {
          normalizedTraders = normalizedTraders.map((t: Record<string, unknown>) => ({
            id: t.trader_key as string,
            handle: (t.display_name as string) || (t.trader_key as string),
            roi: (t.metrics as Record<string, unknown>)?.roi ?? 0,
            pnl: (t.metrics as Record<string, unknown>)?.pnl ?? 0,
            win_rate: (t.metrics as Record<string, unknown>)?.win_rate ?? null,
            max_drawdown: (t.metrics as Record<string, unknown>)?.max_drawdown ?? null,
            trades_count: (t.metrics as Record<string, unknown>)?.trades_count ?? null,
            followers: (t.metrics as Record<string, unknown>)?.followers ?? null,
            source: t.platform as string,
            avatar_url: t.avatar_url as string | null,
            arena_score: (t.metrics as Record<string, unknown>)?.arena_score ?? 0,
            rank: t.rank as number,
            profitability_score: t.profitability_score ?? null,
            risk_control_score: t.risk_control_score ?? null,
            execution_score: t.execution_score ?? null,
            score_completeness: t.score_completeness ?? null,
            trading_style: t.trading_style ?? null,
            avg_holding_hours: t.avg_holding_hours ?? null,
            style_confidence: t.style_confidence ?? null,
            is_bot: t.is_bot ?? false,
            trader_type: t.trader_type ?? null,
          }))
        }
        const cached: CachedData = {
          traders: normalizedTraders,
          lastUpdated: data.lastUpdated || data.as_of || null,
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
        // Don't set error for aborted requests
        if (err instanceof Error && err.name === 'AbortError') {
          return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
        }
        const errorMsg = err instanceof Error ? err.message : tRef.current('errorNetworkFailed')
        setError(errorMsg)
        return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
      } finally {
        // 请求完成后移除 pending 标记和 AbortController
        pendingRequests.delete(cacheKey)
        abortControllers.delete(timeRange)
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
      // Don't show error for aborted requests
      if (!(err instanceof Error && err.name === 'AbortError')) {
        const errorMsg = err instanceof Error ? err.message : tRef.current('loadFailed')
        setError(errorMsg)
        setCurrentTraders([])
        setLastUpdated(null)
        setAvailableSources([])
      }
    } finally {
      setLoading(false)
      setIsChangingTimeRange(false)
    }
  }, [activeTimeRange, loadTimeRange])

  // Seed cache with initial data if provided
  const initialDataSeeded = useRef(false)
  useEffect(() => {
    if (hasInitialData && !initialDataSeeded.current) {
      initialDataSeeded.current = true
      // Seed the cache with initial data for the active time range (default 90D)
      tradersCache.current.set(activeTimeRange, {
        traders: initialTraders!,
        lastUpdated: initialLastUpdated || null,
        fetchedAt: Date.now(),
      })
    }
  }, [hasInitialData, initialTraders, initialLastUpdated])

  // 初次加载和时间段切换时加载数据
  // Skip initial fetch if we have server-provided data for 90D
  // Performance: Defer full data fetch until after LCP using requestIdleCallback
  const isInitialMount = useRef(true)
  useEffect(() => {
    // If we have initial data and we're on 90D on INITIAL mount, defer full fetch
    if (hasInitialData && activeTimeRange === '90D' && isInitialMount.current) {
      isInitialMount.current = false
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
    isInitialMount.current = false

    // If cache already has this time range, use it instantly (no loading flash)
    if (tradersCache.current.has(activeTimeRange)) {
      const cached = tradersCache.current.get(activeTimeRange)!
      setCurrentTraders(cached.traders)
      setLastUpdated(cached.lastUpdated)
      setAvailableSources(cached.availableSources || [])
      setLoading(false)
      setIsChangingTimeRange(false)
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

  // Prefetch other time ranges in idle time for instant period switching
  // Stagger requests by 2s each to avoid bursting rate limits
  const prefetchedRef = useRef(false)
  useEffect(() => {
    if (prefetchedRef.current || loading || currentTraders.length === 0) return
    prefetchedRef.current = true
    const otherRanges: TimeRange[] = (['90D', '30D', '7D'] as TimeRange[]).filter(r => r !== activeTimeRange)
    const staggerMs = 2000 // 2s between each prefetch to avoid rate limit bursts
    const timers: ReturnType<typeof setTimeout>[] = []

    const prefetch = () => {
      otherRanges.forEach((range, idx) => {
        if (!tradersCache.current.has(range)) {
          const timer = setTimeout(() => {
            // Only prefetch if user hasn't already switched to this range (cache miss)
            if (!tradersCache.current.has(range)) {
              loadTimeRange(range, false).catch(() => {})
            }
          }, idx * staggerMs)
          timers.push(timer)
        }
      })
    }

    let idleId: number | null = null
    if ('requestIdleCallback' in window) {
      idleId = requestIdleCallback(prefetch, { timeout: 8000 })
    } else {
      const id = setTimeout(prefetch, 4000)
      timers.push(id)
    }

    return () => {
      if (idleId !== null) cancelIdleCallback(idleId)
      timers.forEach(t => clearTimeout(t))
    }
  }, [loading, currentTraders.length, activeTimeRange, loadTimeRange])
  
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
        .catch(() => { // eslint-disable-line no-restricted-syntax -- intentional fire-and-forget
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

  // 切换时间段（带 300ms 防抖，防止快速切换触发多个并发请求）
  const changeTimeRange = useCallback((range: TimeRange) => {
    if (range === activeTimeRange) return

    // Show optimistic UI state immediately
    setIsChangingTimeRange(true)

    // Cancel any pending debounce
    if (timeRangeDebounceTimer !== null) {
      clearTimeout(timeRangeDebounceTimer)
    }

    // Cancel in-flight requests for all time ranges except the target
    for (const [tr, controller] of abortControllers.entries()) {
      if (tr !== range) {
        controller.abort()
        abortControllers.delete(tr)
      }
    }

    // Debounce: only commit the switch after 300ms of inactivity
    timeRangeDebounceTimer = setTimeout(() => {
      timeRangeDebounceTimer = null
      setActiveTimeRange(range)
    }, 300)
  }, [activeTimeRange])

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
    isChangingTimeRange,
  }
}
