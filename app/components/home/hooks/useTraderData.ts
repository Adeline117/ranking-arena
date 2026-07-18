'use client'

import { useCallback, useRef, useEffect, useReducer, useMemo, startTransition } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import { useTraderDataSync, type TraderDataPayload } from '@/lib/hooks/useBroadcastSync'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { CategoryCounts } from '@/lib/getInitialTraders'
import { resolveExchangeSlug } from '@/lib/constants/exchanges'

import { FIVE_MINUTES_MS } from '@/lib/constants/time'

export type TimeRange = '90D' | '30D' | '7D' | 'COMPOSITE'
export type SortBy = 'arena_score' | 'roi' | 'win_rate' | 'max_drawdown'
export type SortOrder = 'asc' | 'desc'

const TIME_RANGE_STORAGE_KEY = 'ranking_time_range'
// Debounce for rapid tab-flicking. Kept short: with the dim-not-overlay refresh UI
// the old rows stay visible, so a long debounce only delays the fetch start.
export const TIME_RANGE_DEBOUNCE_MS = 150
const AUTO_REFRESH_MS = 60_000 // 60s — rankings update frequently with event-driven pipeline
const STALE_THRESHOLD_MS = AUTO_REFRESH_MS
const PAGE_SIZE = 50

interface UseTraderDataOptions {
  autoRefreshInterval?: number
  sortBy?: SortBy
  sortOrder?: SortOrder
  initialTraders?: Trader[]
  initialLastUpdated?: string | null
  initialIsStale?: boolean
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
  lastRefreshFailed: boolean
  /** Source-watermark freshness from the shared server contract. */
  isStale: boolean
  /** True when consecutive auto-refresh failures exceed threshold (3+) */
  staleDataWarning: boolean
}

type TraderDataAction =
  | {
      type: 'SET_TRADERS'
      traders: Trader[]
      lastUpdated: string | null
      availableSources?: string[]
      isStale?: boolean
    }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_TIME_RANGE'; timeRange: TimeRange }
  | { type: 'SET_CHANGING_TIME_RANGE'; isChanging: boolean }
  | { type: 'SET_DEFERRED_FETCH_FAILED'; failed: boolean }
  | { type: 'LOAD_START' }
  | {
      type: 'LOAD_SUCCESS'
      traders: Trader[]
      lastUpdated: string | null
      availableSources: string[]
      totalCount?: number
      categoryCounts?: CategoryCounts
      isStale: boolean
    }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'LOAD_ABORT' }
  | { type: 'SET_COUNTS'; totalCount: number; categoryCounts: CategoryCounts }
  | { type: 'SET_STALE_DATA_WARNING'; warning: boolean }

function traderDataReducer(state: TraderDataState, action: TraderDataAction): TraderDataState {
  switch (action.type) {
    case 'SET_TRADERS':
      return {
        ...state,
        currentTraders: action.traders,
        lastUpdated: action.lastUpdated,
        availableSources: action.availableSources || state.availableSources,
        isStale: action.isStale ?? state.isStale,
      }
    case 'SET_LOADING':
      // Invariant: loading=false implies isChangingTimeRange=false.
      // The fingerprint dedup at fetchPage skips LOAD_SUCCESS on cache hit and
      // dispatches SET_LOADING(false) instead — without this invariant the spinner
      // would stay forever.
      return {
        ...state,
        loading: action.loading,
        isChangingTimeRange: action.loading ? state.isChangingTimeRange : false,
      }
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
        lastRefreshFailed: false,
        isStale: action.isStale,
        staleDataWarning: false,
      }
    case 'LOAD_ERROR':
      // If we already have traders (from SSR or previous fetch), silently keep them
      // instead of showing error UI — prevents CLS from error box replacing content.
      // Set lastRefreshFailed so footer can show subtle staleness indicator.
      return {
        ...state,
        loading: false,
        isChangingTimeRange: false,
        error: state.currentTraders.length > 0 ? null : action.error,
        lastRefreshFailed: state.currentTraders.length > 0,
      }
    case 'LOAD_ABORT':
      return { ...state, loading: false, isChangingTimeRange: false }
    case 'SET_COUNTS':
      return { ...state, totalCount: action.totalCount, categoryCounts: action.categoryCounts }
    case 'SET_STALE_DATA_WARNING':
      return { ...state, staleDataWarning: action.warning }
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
    autoRefreshInterval = AUTO_REFRESH_MS,
    initialTraders,
    initialLastUpdated,
    initialIsStale = false,
    initialTotalCount = 0,
    initialCategoryCounts = { all: 0, futures: 0, spot: 0, onchain: 0 },
  } = options

  const { t } = useLanguage()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

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
    lastRefreshFailed: false,
    isStale: initialIsStale,
    staleDataWarning: false,
  })

  // Track consecutive auto-refresh failures for stale data warning
  const refreshFailCountRef = useRef(0)

  const { broadcast, on } = useTraderDataSync()

  // Ref to access latest totalCount inside fetchPage without adding it as a dependency
  // (adding state.totalCount to fetchPage's deps caused a re-fetch loop)
  const totalCountRef = useRef(initialTotalCount)

  // Fingerprint to skip dispatching LOAD_SUCCESS when auto-refresh data is identical.
  // Without this, every 5-min refresh creates a new array reference → triggers full
  // re-render cascade through 5 useMemo chains → 50 TraderRow memo checks.
  const dataFingerprintRef = useRef('')

  // URL → state sync is handled by HomePageClient.tsx (the single owner).
  // It calls changeTimeRange() which properly sets isChangingTimeRange + debounce.
  // Previously this hook ALSO read ?range= and dispatched SET_TIME_RANGE directly,
  // creating a race (two dispatches for same URL param) and skipping the spinner.
  // Root-cause fix: removed duplicate — HomePageClient is the single source of truth.

  // Keep totalCount ref in sync with state
  useEffect(() => {
    totalCountRef.current = state.totalCount
  }, [state.totalCount])

  // Multi-tab sync
  useEffect(() => {
    const unsubscribe = on('TRADER_DATA_UPDATED', (payload: TraderDataPayload) => {
      if (payload.timeRange === state.activeTimeRange) {
        startTransition(() => {
          dispatch({
            type: 'SET_TRADERS',
            traders: payload.traders as Trader[],
            lastUpdated: payload.lastUpdated,
            isStale: payload.isStale,
          })
        })
      }
    })
    return unsubscribe
  }, [state.activeTimeRange, on])

  /**
   * Sticky filter state — fetchPage remembers the last-set values for each
   * filter dimension. Callers only pass what they want to CHANGE; everything
   * else is carried forward automatically. This prevents any caller from
   * accidentally dropping a filter (the root-root-root cause of the exchange
   * page bug where pagination/sort/refresh lost the exchange param).
   */
  const stickyFilters = useRef<{
    category?: string
    sortBy: string
    sortDir: string
    exchange?: string
  }>({ sortBy: 'arena_score', sortDir: 'desc' })

  /**
   * Fetch a specific page from the API.
   * This is the core server-side pagination function.
   *
   * Filter persistence: any filter passed in opts is "sticky" — it persists
   * across subsequent calls until explicitly changed. Pass `exchange: undefined`
   * or `exchange: ''` to explicitly clear a sticky filter.
   */
  const fetchPage = useCallback(
    async (
      page: number,
      opts?: {
        category?: string
        sortBy?: string
        sortDir?: string
        timeRange?: TimeRange
        exchange?: string
        /** Background auto-refresh: skip LOAD_START so the table never dims/spins.
            Data lands via LOAD_SUCCESS (fingerprint-deduped) without UI churn. */
        silent?: boolean
      }
    ): Promise<void> => {
      // Merge opts into sticky filters — only override what caller explicitly passes
      if (opts) {
        if ('category' in opts) stickyFilters.current.category = opts.category
        if ('sortBy' in opts) stickyFilters.current.sortBy = opts.sortBy || 'arena_score'
        if ('sortDir' in opts) stickyFilters.current.sortDir = opts.sortDir || 'desc'
        if ('exchange' in opts) stickyFilters.current.exchange = opts.exchange || undefined
      }

      const timeRange = opts?.timeRange || state.activeTimeRange
      const { category, sortBy, sortDir } = stickyFilters.current
      const exchange = stickyFilters.current.exchange
        ? resolveExchangeSlug(stickyFilters.current.exchange)
        : undefined

      // Cancel existing request
      const cancelKey = `page-${timeRange}`
      const existing = abortControllers.get(cancelKey)
      if (existing) existing.abort()
      const controller = new AbortController()
      abortControllers.set(cancelKey, controller)

      if (!opts?.silent) dispatch({ type: 'LOAD_START' })

      try {
        let url = `/api/traders?timeRange=${timeRange}&limit=${PAGE_SIZE}&page=${page}`
        if (category && category !== 'all') {
          url += `&category=${category}`
        }
        if (exchange) {
          url += `&exchange=${encodeURIComponent(exchange)}`
        }
        // 非默认排序才带参(2026-07-03 修复:此前条件只看 sortBy,score 列的 asc
        // 方向被静默丢弃,服务端按默认 desc 返回;API 本就支持 sortBy=arena_score&order=asc)
        if (sortBy !== 'arena_score' || sortDir !== 'desc') {
          url += `&sortBy=${sortBy}&order=${sortDir}`
        }

        // 8s timeout prevents indefinite hang if API is slow
        const timeoutId = setTimeout(() => controller.abort(), 8_000)
        const response = await fetch(url, { signal: controller.signal })
        clearTimeout(timeoutId)
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
          avatar_url_mirror: (t.avatar_url_mirror as string | null) ?? null,
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
          // 认领徽章(P3-P3):API 已按 verified_traders 标记;此显式挑字段映射器
          // 曾把它丢掉 → 徽章渲染器有、数据到 API、行上永不显示(2026-07-09 真点揪出)。
          is_verified: t.is_verified === true,
          trader_type: t.trader_type ?? null,
          sharpe_ratio: t.sharpe_ratio != null ? Number(t.sharpe_ratio) : null,
          sortino_ratio: t.sortino_ratio != null ? Number(t.sortino_ratio) : null,
          calmar_ratio: t.calmar_ratio != null ? Number(t.calmar_ratio) : null,
          profit_factor: t.profit_factor != null ? Number(t.profit_factor) : null,
        }))

        const responseLastUpdated = data.lastUpdated || data.as_of || null
        // Current /api/traders uses camelCase. Keep the legacy snake_case read
        // during rollout so older cached payloads cannot silently lose the flag.
        const responseIsStale =
          typeof data.isStale === 'boolean'
            ? data.isStale
            : typeof data.is_stale === 'boolean'
              ? data.is_stale
              : false

        // Fingerprint check: metrics, source watermark, and source-stale state
        // together define the visible ranking state. A freshness-only change
        // must reach the footer even when every score remains identical.
        const traderFingerprint = traders
          .map((t) => `${t.id}:${t.arena_score}:${t.roi}:${t.is_verified ? 'v' : ''}`)
          .join('|')
        const fingerprint = `${traderFingerprint}::freshness:${responseLastUpdated ?? 'unknown'}:${responseIsStale ? 'stale' : 'fresh'}`
        if (fingerprint === dataFingerprintRef.current) {
          // Data unchanged — skip dispatch to avoid unnecessary re-renders
          dispatch({ type: 'SET_LOADING', loading: false })
          return
        }
        dataFingerprintRef.current = fingerprint

        startTransition(() => {
          dispatch({
            type: 'LOAD_SUCCESS',
            traders,
            lastUpdated: responseLastUpdated,
            availableSources: data.availableSources || [],
            totalCount: data.totalCount ?? totalCountRef.current,
            isStale: responseIsStale,
          })
        })

        // Broadcast for multi-tab sync
        broadcast('TRADER_DATA_UPDATED', {
          timeRange,
          traders,
          lastUpdated: responseLastUpdated || '',
          isStale: responseIsStale,
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
    },
    [state.activeTimeRange, broadcast]
  )
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
    // Sticky filters automatically preserve the current exchange
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
      // Sticky filters automatically preserve the current exchange.
      // silent: a 60s background poll must not dim the table or show the
      // refresh spinner — fingerprint dedup means most polls change nothing.
      fetchPage(0, { silent: true })
        .then(() => {
          refreshFailCountRef.current = 0
        })
        .catch(() => {
          refreshFailCountRef.current += 1
          if (refreshFailCountRef.current > 3) {
            dispatch({ type: 'SET_STALE_DATA_WARNING', warning: true })
          }
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

  // Ref for activeTimeRange to keep changeTimeRange identity stable
  const activeTimeRangeRef = useRef(state.activeTimeRange)
  useEffect(() => {
    activeTimeRangeRef.current = state.activeTimeRange
  }, [state.activeTimeRange])

  // Time range switching with debounce (stable identity — no state in deps)
  const changeTimeRange = useCallback((range: TimeRange) => {
    if (range === activeTimeRangeRef.current) return
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
    }, TIME_RANGE_DEBOUNCE_MS)
  }, [])

  const refresh = useCallback(() => {
    return fetchPage(0)
  }, [fetchPage])

  const retryDeferredFetch = useCallback(() => {
    dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: false })
    fetchPage(0).catch(() => {
      dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: true })
    })
  }, [fetchPage])

  const result = useMemo(
    () => ({
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
      lastRefreshFailed: state.lastRefreshFailed,
      staleDataWarning: state.staleDataWarning,
      isStale: state.isStale,
    }),
    [
      state.currentTraders,
      state.loading,
      state.error,
      state.activeTimeRange,
      state.lastUpdated,
      state.availableSources,
      state.deferredFetchFailed,
      state.isChangingTimeRange,
      state.totalCount,
      state.categoryCounts,
      state.lastRefreshFailed,
      state.staleDataWarning,
      state.isStale,
      changeTimeRange,
      refresh,
      retryDeferredFetch,
      fetchPage,
    ]
  )

  return result
}
