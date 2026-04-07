'use client'

import { useCallback, useRef, useEffect, useReducer, useMemo, startTransition } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import { useTraderDataSync, type TraderDataPayload } from '@/lib/hooks/useBroadcastSync'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { CategoryCounts } from '@/lib/getInitialTraders'

import { FIVE_MINUTES_MS } from '@/lib/constants/time'

export type TimeRange = '90D' | '30D' | '7D' | 'COMPOSITE'
export type SortBy = 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown'
export type SortOrder = 'asc' | 'desc'

const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'
const STALE_THRESHOLD_MS = FIVE_MINUTES_MS
const PAGE_SIZE = 50

interface UseTraderDataOptions {
  autoRefreshInterval?: number
  sortBy?: SortBy
  sortOrder?: SortOrder
  initialTraders?: Trader[]
  initialLastUpdated?: string | null
  initialTotalCount?: number
  initialCategoryCounts?: CategoryCounts
}

// AbortController Map for request cancellation
const abortControllers = new Map<string, AbortController>()
let timeRangeDebounceTimer: ReturnType<typeof setTimeout> | null = null

interface TraderDataState {
  currentTraders: Trader[]
  loading: boolean
  error: string | null
  lastUpdated: string | null
  availableSources: string[]
  deferredFetchFailed: boolean
  isChangingTimeRange: boolean
  activeTimeRange: TimeRange
  totalCount: number
  categoryCounts: CategoryCounts
}

type TraderDataAction =
  | { type: 'SET_TRADERS'; traders: Trader[]; lastUpdated: string | null; availableSources?: string[] }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_TIME_RANGE'; timeRange: TimeRange }
  | { type: 'SET_CHANGING_TIME_RANGE'; isChanging: boolean }
  | { type: 'SET_DEFERRED_FETCH_FAILED'; failed: boolean }
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; traders: Trader[]; lastUpdated: string | null; availableSources: string[]; totalCount?: number; categoryCounts?: CategoryCounts }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'LOAD_ABORT' }
  | { type: 'SET_COUNTS'; totalCount: number; categoryCounts: CategoryCounts }

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
        totalCount: action.totalCount ?? state.totalCount,
        categoryCounts: action.categoryCounts ?? state.categoryCounts,
      }
    case 'LOAD_ERROR':
      return {
        ...state,
        loading: false,
        isChangingTimeRange: false,
        error: action.error,
      }
    case 'LOAD_ABORT':
      return { ...state, loading: false, isChangingTimeRange: false }
    case 'SET_COUNTS':
      return { ...state, totalCount: action.totalCount, categoryCounts: action.categoryCounts }
    default:
      return state
  }
}

/**
 * Server-side pagination hook for the homepage ranking table.
 *
 * SSR provides first page (20 traders) + totalCount + categoryCounts.
 * Client fetches subsequent pages from /api/traders on demand.
 * Category/sort changes trigger new API requests.
 */
export function useTraderData(options: UseTraderDataOptions = {}) {
  const {
    autoRefreshInterval = FIVE_MINUTES_MS,
    initialTraders,
    initialLastUpdated,
    initialTotalCount = 0,
    initialCategoryCounts = { all: 0, futures: 0, spot: 0, onchain: 0 },
  } = options

  const { t } = useLanguage()
  const tRef = useRef(t)
  useEffect(() => { tRef.current = t }, [t])

  const hasInitialData = initialTraders && initialTraders.length > 0

  const [state, dispatch] = useReducer(traderDataReducer, {
    currentTraders: initialTraders || [],
    loading: !hasInitialData,
    error: null,
    lastUpdated: initialLastUpdated || null,
    availableSources: [],
    deferredFetchFailed: false,
    isChangingTimeRange: false,
    activeTimeRange: '90D',
    totalCount: initialTotalCount,
    categoryCounts: initialCategoryCounts,
  })

  const { broadcast, on } = useTraderDataSync()

  // Ref to access latest totalCount inside fetchPage without adding it as a dependency
  // (adding state.totalCount to fetchPage's deps caused a re-fetch loop)
  const totalCountRef = useRef(initialTotalCount)

  // Read time range preference from URL or localStorage
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

  // Keep totalCount ref in sync with state
  useEffect(() => { totalCountRef.current = state.totalCount }, [state.totalCount])

  // Multi-tab sync
  useEffect(() => {
    const unsubscribe = on('TRADER_DATA_UPDATED', (payload: TraderDataPayload) => {
      if (payload.timeRange === state.activeTimeRange) {
        startTransition(() => {
          dispatch({ type: 'SET_TRADERS', traders: payload.traders as Trader[], lastUpdated: payload.lastUpdated })
        })
      }
    })
    return unsubscribe
  }, [state.activeTimeRange, on])

  /**
   * Fetch a specific page from the API.
   * This is the core server-side pagination function.
   */
  const fetchPage = useCallback(async (
    page: number,
    opts?: { category?: string; sortBy?: string; sortDir?: string; timeRange?: TimeRange }
  ): Promise<void> => {
    const timeRange = opts?.timeRange || state.activeTimeRange
    const category = opts?.category
    const sortBy = opts?.sortBy || 'arena_score'
    const sortDir = opts?.sortDir || 'desc'

    // Cancel existing request
    const cancelKey = `page-${timeRange}`
    const existing = abortControllers.get(cancelKey)
    if (existing) existing.abort()
    const controller = new AbortController()
    abortControllers.set(cancelKey, controller)

    dispatch({ type: 'LOAD_START' })

    try {
      let url = `/api/traders?timeRange=${timeRange}&limit=${PAGE_SIZE}&page=${page}`
      if (category && category !== 'all') {
        url += `&category=${category}`
      }
      if (sortBy !== 'arena_score') {
        url += `&sortBy=${sortBy}&order=${sortDir}`
      }

      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`${tRef.current('loadFailed')} (${response.status})`)
      }

      const data = await response.json()
      const traders: Trader[] = (data.traders || []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        handle: (t.handle as string) || null,
        roi: t.roi != null ? Number(t.roi) : null,
        pnl: t.pnl != null ? Number(t.pnl) : null,
        win_rate: t.win_rate != null ? Number(t.win_rate) : null,
        max_drawdown: t.max_drawdown != null ? Number(t.max_drawdown) : null,
        trades_count: t.trades_count != null ? Number(t.trades_count) : null,
        followers: t.followers != null ? Number(t.followers) : null,
        source: t.source as string,
        avatar_url: t.avatar_url as string | null,
        arena_score: t.arena_score != null ? Number(t.arena_score) : null,
        rank: t.rank as number,
        profitability_score: t.profitability_score ?? null,
        risk_control_score: t.risk_control_score ?? null,
        execution_score: t.execution_score ?? null,
        score_completeness: t.score_completeness ?? null,
        trading_style: t.trading_style ?? null,
        avg_holding_hours: t.avg_holding_hours != null ? Number(t.avg_holding_hours) : null,
        style_confidence: t.style_confidence ?? null,
        is_bot: t.is_bot ?? false,
        trader_type: t.trader_type ?? null,
        sharpe_ratio: t.sharpe_ratio != null ? Number(t.sharpe_ratio) : null,
        sortino_ratio: t.sortino_ratio != null ? Number(t.sortino_ratio) : null,
        calmar_ratio: t.calmar_ratio != null ? Number(t.calmar_ratio) : null,
        profit_factor: t.profit_factor != null ? Number(t.profit_factor) : null,
      }))

      startTransition(() => {
        dispatch({
          type: 'LOAD_SUCCESS',
          traders,
          lastUpdated: data.lastUpdated || data.as_of || null,
          availableSources: data.availableSources || [],
          totalCount: data.totalCount ?? totalCountRef.current,
        })
      })

      // Broadcast for multi-tab sync
      broadcast('TRADER_DATA_UPDATED', {
        timeRange,
        traders,
        lastUpdated: data.lastUpdated || '',
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        dispatch({ type: 'LOAD_ABORT' })
        return
      }
      const errorMsg = err instanceof Error ? err.message : tRef.current('errorNetworkFailed')
      dispatch({ type: 'LOAD_ERROR', error: errorMsg })
    } finally {
      abortControllers.delete(cancelKey)
    }
  }, [state.activeTimeRange, broadcast])
  // NOTE: state.totalCount was deliberately REMOVED from this dependency array.
  // Including it caused a re-fetch loop: each LOAD_SUCCESS updates totalCount →
  // fetchPage gets new identity → useEffect re-runs → triggers another fetch → loop.
  // totalCount is only used as a fallback default (line 242) which is safe to be stale.

  // Seed cache with initial data
  const initialDataSeeded = useRef(false)
  useEffect(() => {
    if (hasInitialData && !initialDataSeeded.current) {
      initialDataSeeded.current = true
      dispatch({ type: 'SET_LOADING', loading: false })
    }
  }, [hasInitialData])

  // When time range changes (and it's not the initial 90D with SSR data), fetch page 0
  const isInitialMount = useRef(true)
  useEffect(() => {
    if (hasInitialData && state.activeTimeRange === '90D' && isInitialMount.current) {
      isInitialMount.current = false
      dispatch({ type: 'SET_LOADING', loading: false })
      return
    }
    isInitialMount.current = false
    fetchPage(0, { timeRange: state.activeTimeRange })
  }, [state.activeTimeRange, hasInitialData, fetchPage])

  // Save time range preference
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(TIME_RANGE_STORAGE_KEY, state.activeTimeRange)
    }
  }, [state.activeTimeRange])

  // Visibility-based auto-refresh
  useEffect(() => {
    if (autoRefreshInterval <= 0) return

    let intervalId: ReturnType<typeof setInterval> | null = null
    let lastFetchTime = Date.now()

    const silentRefresh = () => {
      lastFetchTime = Date.now()
      fetchPage(0).catch(() => {})
    }

    const startInterval = () => {
      if (intervalId) clearInterval(intervalId)
      intervalId = setInterval(silentRefresh, autoRefreshInterval)
    }

    const stopInterval = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null }
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopInterval()
      } else {
        const isStale = Date.now() - lastFetchTime > STALE_THRESHOLD_MS
        if (isStale) silentRefresh()
        startInterval()
      }
    }

    if (!document.hidden) startInterval()
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      stopInterval()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [autoRefreshInterval, fetchPage])

  // Time range switching with debounce
  const changeTimeRange = useCallback((range: TimeRange) => {
    if (range === state.activeTimeRange) return
    dispatch({ type: 'SET_CHANGING_TIME_RANGE', isChanging: true })

    if (timeRangeDebounceTimer !== null) clearTimeout(timeRangeDebounceTimer)

    for (const [tr, controller] of abortControllers.entries()) {
      if (tr !== `page-${range}`) {
        controller.abort()
        abortControllers.delete(tr)
      }
    }

    timeRangeDebounceTimer = setTimeout(() => {
      timeRangeDebounceTimer = null
      dispatch({ type: 'SET_TIME_RANGE', timeRange: range })
    }, 300)
  }, [state.activeTimeRange])

  const refresh = useCallback(() => {
    return fetchPage(0)
  }, [fetchPage])

  const retryDeferredFetch = useCallback(() => {
    dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: false })
    fetchPage(0).catch(() => {
      dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: true })
    })
  }, [fetchPage])

  const result = useMemo(() => ({
    traders: state.currentTraders,
    loading: state.loading,
    error: state.error,
    activeTimeRange: state.activeTimeRange,
    lastUpdated: state.lastUpdated,
    availableSources: state.availableSources,
    changeTimeRange,
    refresh,
    clearCache: () => {},
    deferredFetchFailed: state.deferredFetchFailed,
    retryDeferredFetch,
    isChangingTimeRange: state.isChangingTimeRange,
    totalCount: state.totalCount,
    categoryCounts: state.categoryCounts,
    fetchPage,
  }), [
    state.currentTraders, state.loading, state.error, state.activeTimeRange,
    state.lastUpdated, state.availableSources, state.deferredFetchFailed,
    state.isChangingTimeRange, state.totalCount, state.categoryCounts,
    changeTimeRange, refresh, retryDeferredFetch, fetchPage,
  ])

  return result
}
