'use client'

import { useCallback, useRef, useEffect, useReducer, useMemo, startTransition } from 'react'
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

// --- Consolidated state via useReducer to prevent cascading re-renders ---

interface TraderDataState {
  currentTraders: Trader[]
  loading: boolean
  error: string | null
  lastUpdated: string | null
  availableSources: string[]
  deferredFetchFailed: boolean
  isChangingTimeRange: boolean
  activeTimeRange: TimeRange
}

type TraderDataAction =
  | { type: 'SET_TRADERS'; traders: Trader[]; lastUpdated: string | null; availableSources?: string[] }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_TIME_RANGE'; timeRange: TimeRange }
  | { type: 'SET_CHANGING_TIME_RANGE'; isChanging: boolean }
  | { type: 'SET_DEFERRED_FETCH_FAILED'; failed: boolean }
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; traders: Trader[]; lastUpdated: string | null; availableSources: string[] }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'LOAD_ABORT' }

function traderDataReducer(state: TraderDataState, action: TraderDataAction): TraderDataState {
  switch (action.type) {
    case 'SET_TRADERS':
      return {
        ...state,
        currentTraders: action.traders,
        lastUpdated: action.lastUpdated,
        availableSources: action.availableSources || state.availableSources,
      }
    case 'SET_LOADING':
      return { ...state, loading: action.loading }
    case 'SET_ERROR':
      return { ...state, error: action.error }
    case 'SET_TIME_RANGE':
      return { ...state, activeTimeRange: action.timeRange }
    case 'SET_CHANGING_TIME_RANGE':
      return { ...state, isChangingTimeRange: action.isChanging }
    case 'SET_DEFERRED_FETCH_FAILED':
      return { ...state, deferredFetchFailed: action.failed }
    case 'LOAD_START':
      return { ...state, loading: true, error: null }
    case 'LOAD_SUCCESS':
      return {
        ...state,
        loading: false,
        isChangingTimeRange: false,
        error: null,
        currentTraders: action.traders,
        lastUpdated: action.lastUpdated,
        availableSources: action.availableSources,
      }
    case 'LOAD_ERROR':
      return {
        ...state,
        loading: false,
        isChangingTimeRange: false,
        error: action.error,
        currentTraders: [],
        lastUpdated: null,
        availableSources: [],
      }
    case 'LOAD_ABORT':
      return { ...state, loading: false, isChangingTimeRange: false }
    default:
      return state
  }
}

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
 * - useReducer consolidates state updates to minimize re-renders (TBT optimization)
 * - startTransition for non-urgent state updates (e.g. trader list changes)
 *
 * @param options - 配置选项
 * @returns 交易员数据、加载状态、时间段控制等
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

  // Consolidated state via useReducer — prevents cascading re-renders from
  // multiple setState calls (was causing high TBT)
  const [state, dispatch] = useReducer(traderDataReducer, {
    currentTraders: initialTraders || [],
    loading: !hasInitialData,
    error: null,
    lastUpdated: initialLastUpdated || null,
    availableSources: [],
    deferredFetchFailed: false,
    isChangingTimeRange: false,
    activeTimeRange: '90D',
  })

  // 使用 Map 缓存已加载的数据
  const tradersCache = useRef<Map<string, CachedData>>(new Map())

  // 多窗口同步
  const { broadcast, on } = useTraderDataSync()

  // 客户端 hydration 后从 URL params 或 localStorage 读取偏好
  // URL param (?window=7d) takes priority for shareable links
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlWindow = params.get('window')?.toUpperCase()
    if (urlWindow === '90D' || urlWindow === '30D' || urlWindow === '7D') {
      dispatch({ type: 'SET_TIME_RANGE', timeRange: urlWindow })
      return
    }
    const saved = localStorage.getItem(TIME_RANGE_STORAGE_KEY)
    if (saved === '90D' || saved === '30D' || saved === '7D') {
      dispatch({ type: 'SET_TIME_RANGE', timeRange: saved })
    }
  }, [])

  // 监听其他窗口的数据更新
  useEffect(() => {
    const unsubscribe = on('TRADER_DATA_UPDATED', (payload: TraderDataPayload) => {
      // 只处理当前时间段的数据
      if (payload.timeRange === state.activeTimeRange) {
        // 更新本地缓存和状态
        const cached: CachedData = {
          traders: payload.traders as Trader[],
          lastUpdated: payload.lastUpdated,
          fetchedAt: Date.now(),
        }
        tradersCache.current.set(state.activeTimeRange, cached)
        // Use startTransition for non-urgent trader list update
        startTransition(() => {
          dispatch({ type: 'SET_TRADERS', traders: cached.traders, lastUpdated: cached.lastUpdated })
        })
      }
    })

    return unsubscribe
  }, [state.activeTimeRange, on])

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
        // Progressive loading: fetch 50 initially (covers ~2 pages of visible ranking).
        // Full data loaded on-demand when user scrolls or searches.
        const fetchLimit = 50
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
          dispatch({ type: 'SET_ERROR', error: errorMsg })
          return tradersCache.current.get(timeRange) || { traders: [], lastUpdated: null, fetchedAt: 0 }
        }

        // Safe JSON parsing
        let data
        try {
          data = await response.json()
        } catch (_parseError) {
          const errorMsg = tRef.current('errorDataFormat') || '数据格式错误'
          dispatch({ type: 'SET_ERROR', error: errorMsg })
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
        dispatch({ type: 'SET_ERROR', error: null })

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
        dispatch({ type: 'SET_ERROR', error: errorMsg })
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
    dispatch({ type: 'LOAD_START' })
    try {
      const cached = await loadTimeRange(state.activeTimeRange, forceRefresh)
      // Use startTransition: updating the trader list is non-urgent
      startTransition(() => {
        dispatch({
          type: 'LOAD_SUCCESS',
          traders: cached.traders,
          lastUpdated: cached.lastUpdated,
          availableSources: cached.availableSources || [],
        })
      })
    } catch (err) {
      // Don't show error for aborted requests
      if (err instanceof Error && err.name === 'AbortError') {
        dispatch({ type: 'LOAD_ABORT' })
      } else {
        const errorMsg = err instanceof Error ? err.message : tRef.current('loadFailed')
        dispatch({ type: 'LOAD_ERROR', error: errorMsg })
      }
    }
  }, [state.activeTimeRange, loadTimeRange])

  // Seed cache with initial data if provided
  const initialDataSeeded = useRef(false)
  useEffect(() => {
    if (hasInitialData && !initialDataSeeded.current) {
      initialDataSeeded.current = true
      // Seed the cache with initial data for the active time range (default 90D)
      tradersCache.current.set(state.activeTimeRange, {
        traders: initialTraders!,
        lastUpdated: initialLastUpdated || null,
        fetchedAt: Date.now(),
      })
    }
  }, [hasInitialData, initialTraders, initialLastUpdated, state.activeTimeRange])

  // 初次加载和时间段切换时加载数据
  // Skip initial fetch if we have server-provided data for 90D
  // Performance: Defer full data fetch until after LCP using requestIdleCallback
  const isInitialMount = useRef(true)
  useEffect(() => {
    // If we have initial data and we're on 90D on INITIAL mount, defer full fetch
    if (hasInitialData && state.activeTimeRange === '90D' && isInitialMount.current) {
      isInitialMount.current = false
      // Use initial data immediately - don't block for full fetch
      dispatch({ type: 'SET_LOADING', loading: false })

      // Defer full 500 trader fetch until browser is idle (after LCP)
      const deferredFetch = () => {
        // Only fetch full data if user hasn't switched time range
        if (state.activeTimeRange === '90D') {
          dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: false })
          loadTimeRange('90D', false).then(cached => {
            // Only update if we got more data than initial
            if (cached.traders.length > (initialTraders?.length || 0)) {
              startTransition(() => {
                dispatch({
                  type: 'SET_TRADERS',
                  traders: cached.traders,
                  lastUpdated: cached.lastUpdated,
                  availableSources: cached.availableSources || [],
                })
              })
            }
          }).catch(() => {
            // Graceful degradation — we still have initial data but flag the failure
            // so UI can optionally show a retry prompt
            dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: true })
          })
        }
      }

      // Use requestIdleCallback to defer fetch, with 5s timeout fallback
      // Increased from 3s to 5s to avoid competing with LCP/TBT budget
      if ('requestIdleCallback' in window) {
        const idleId = requestIdleCallback(deferredFetch, { timeout: 5000 })
        return () => cancelIdleCallback(idleId)
      } else {
        // Safari fallback: wait 3s after page load
        const timerId = setTimeout(deferredFetch, 3000)
        return () => clearTimeout(timerId)
      }
    }
    isInitialMount.current = false

    // If cache already has this time range, use it instantly (no loading flash)
    if (tradersCache.current.has(state.activeTimeRange)) {
      const cached = tradersCache.current.get(state.activeTimeRange)!
      startTransition(() => {
        dispatch({
          type: 'LOAD_SUCCESS',
          traders: cached.traders,
          lastUpdated: cached.lastUpdated,
          availableSources: cached.availableSources || [],
        })
      })
      return
    }
    loadCurrentData()
  }, [loadCurrentData, state.activeTimeRange, hasInitialData, loadTimeRange, initialTraders?.length])

  // 保存时间段偏好到 localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, state.activeTimeRange)
    }
  }, [state.activeTimeRange])

  // Prefetch other time ranges in idle time for instant period switching
  // Stagger requests by 2s each to avoid bursting rate limits
  const prefetchedRef = useRef(false)
  useEffect(() => {
    if (prefetchedRef.current || state.loading || state.currentTraders.length === 0) return
    prefetchedRef.current = true
    const otherRanges: TimeRange[] = (['90D', '30D', '7D'] as TimeRange[]).filter(r => r !== state.activeTimeRange)
    const staggerMs = 5000 // 5s between each prefetch — prioritize initial load
    const timers: ReturnType<typeof setTimeout>[] = []

    const prefetch = () => {
      otherRanges.forEach((range, idx) => {
        if (!tradersCache.current.has(range)) {
          const timer = setTimeout(() => {
            // Only prefetch if user hasn't already switched to this range (cache miss)
            if (!tradersCache.current.has(range)) {
              loadTimeRange(range, false).catch(() => {}) // eslint-disable-line no-restricted-syntax -- fire-and-forget
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
  }, [state.loading, state.currentTraders.length, state.activeTimeRange, loadTimeRange])

  // Feature 4: Smarter auto-refresh with Page Visibility API
  // Debounced visibility handler to avoid rapid state updates when switching tabs quickly
  useEffect(() => {
    if (autoRefreshInterval <= 0) return

    let intervalId: ReturnType<typeof setInterval> | null = null
    let visibilityDebounceTimer: ReturnType<typeof setTimeout> | null = null

    const silentRefresh = () => {
      loadTimeRange(state.activeTimeRange, true)
        .then(cached => {
          startTransition(() => {
            dispatch({
              type: 'SET_TRADERS',
              traders: cached.traders,
              lastUpdated: cached.lastUpdated,
              availableSources: cached.availableSources || [],
            })
          })
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
      // Debounce visibility changes by 150ms to avoid rapid tab-switching overhead
      if (visibilityDebounceTimer) clearTimeout(visibilityDebounceTimer)
      visibilityDebounceTimer = setTimeout(() => {
        visibilityDebounceTimer = null
        if (document.hidden) {
          // Tab hidden: pause refresh
          stopInterval()
        } else {
          // Tab visible: check if data is stale
          const cached = tradersCache.current.get(state.activeTimeRange)
          const isStale = !cached || (Date.now() - cached.fetchedAt > STALE_THRESHOLD_MS)
          if (isStale) {
            silentRefresh()
          }
          startInterval()
        }
      }, 150)
    }

    // Start interval only if tab is visible
    if (!document.hidden) {
      startInterval()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      stopInterval()
      if (visibilityDebounceTimer) clearTimeout(visibilityDebounceTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [autoRefreshInterval, state.activeTimeRange, loadTimeRange])

  // 切换时间段（带 300ms 防抖，防止快速切换触发多个并发请求）
  const changeTimeRange = useCallback((range: TimeRange) => {
    if (range === state.activeTimeRange) return

    // Show optimistic UI state immediately
    dispatch({ type: 'SET_CHANGING_TIME_RANGE', isChanging: true })

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
      dispatch({ type: 'SET_TIME_RANGE', timeRange: range })
    }, 300)
  }, [state.activeTimeRange])

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
    dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: false })
    loadTimeRange(state.activeTimeRange, false).then(cached => {
      if (cached.traders.length > state.currentTraders.length) {
        startTransition(() => {
          dispatch({
            type: 'SET_TRADERS',
            traders: cached.traders,
            lastUpdated: cached.lastUpdated,
            availableSources: cached.availableSources || [],
          })
        })
      }
    }).catch(() => {
      dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: true })
    })
  }, [state.activeTimeRange, loadTimeRange, state.currentTraders.length])

  // Memoize the return object to prevent unnecessary re-renders in consumers
  const result = useMemo(() => ({
    traders: state.currentTraders,
    loading: state.loading,
    error: state.error,
    activeTimeRange: state.activeTimeRange,
    lastUpdated: state.lastUpdated,
    availableSources: state.availableSources,
    changeTimeRange,
    refresh,
    clearCache,
    deferredFetchFailed: state.deferredFetchFailed,
    retryDeferredFetch,
    isChangingTimeRange: state.isChangingTimeRange,
  }), [
    state.currentTraders,
    state.loading,
    state.error,
    state.activeTimeRange,
    state.lastUpdated,
    state.availableSources,
    state.deferredFetchFailed,
    state.isChangingTimeRange,
    changeTimeRange,
    refresh,
    clearCache,
    retryDeferredFetch,
  ])

  return result
}
