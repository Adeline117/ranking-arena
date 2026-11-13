'use client'

import { useCallback, useRef, useEffect, useReducer, useMemo, startTransition } from 'react'
import type { Trader } from '../../ranking/RankingTable'
import { toUiTrader, type UiTraderInput } from '../../ranking/toUiTrader'
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
// Rankings are recomputed every PRODUCT_FACTS.leaderboardRefreshHours (2h);
// a 60s poll only burned requests/re-renders. Freshness/staleness changes
// still surface within one interval and on tab re-focus.
const AUTO_REFRESH_MS = FIVE_MINUTES_MS
const STALE_THRESHOLD_MS = AUTO_REFRESH_MS
/** Recently viewed cohorts are reused for instant range switch-back. */
const COHORT_CACHE_TTL_MS = 60_000
const COHORT_CACHE_MAX_ENTRIES = 24
const PAGE_SIZE = 50

const UNKNOWN_CATEGORY_COUNTS: CategoryCounts = {
  all: null,
  futures: null,
  spot: null,
  onchain: null,
}

function isSafeNonNegativeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function normalizeCategoryCounts(value: unknown): CategoryCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const normalized = {
    all: record.all,
    futures: record.futures,
    spot: record.spot,
    onchain: record.onchain,
  }
  return Object.values(normalized).every(isSafeNonNegativeCount)
    ? (normalized as CategoryCounts)
    : null
}

function isTimeRange(value: unknown): value is TimeRange {
  return value === '90D' || value === '30D' || value === '7D' || value === 'COMPOSITE'
}

function normalizePageIndex(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

interface LeaderboardCohort {
  timeRange: TimeRange
  pageIndex: number
  category: string | null
  sortBy: string
  sortDir: string
  exchange: string | null
}

interface RankingBroadcastPayload extends TraderDataPayload {
  cohort: LeaderboardCohort
  availableSources: string[]
  totalCount: number | null
  totalCountIsExact: boolean
  hasMore: boolean
  categoryCounts: CategoryCounts
  categoryCountsAreExact: boolean
}

function cohortKey(cohort: LeaderboardCohort): string {
  // JSON keeps `null` distinct from the literal string "all" (and preserves
  // separators inside exchange slugs), so this key is safe as a cache/dedup
  // scope as well as a cross-tab equality boundary.
  return JSON.stringify([
    cohort.timeRange,
    cohort.pageIndex,
    cohort.category,
    cohort.sortBy,
    cohort.sortDir,
    cohort.exchange,
  ])
}

/** A fully parsed /api/traders page, ready to commit to state. */
interface ParsedCohortPage {
  traders: Trader[]
  lastUpdated: string | null
  isStale: boolean
  availableSources: string[]
  totalCount: number | null
  totalCountIsExact: boolean
  hasMore: boolean
  categoryCounts: CategoryCounts | null
  categoryCountsAreExact: boolean
}

/**
 * Small in-memory per-cohort cache (module scope, shared across mounts).
 * Keyed by the complete cohort identity (range, page, category, sort, dir,
 * exchange), so a hit can never show rows for different filters. Entries live
 * COHORT_CACHE_TTL_MS; only range switches read it (switching back to a
 * recently viewed period is instant), every successful fetch writes it, and
 * manual refresh / background polls always go to the network.
 */
const cohortPageCache = new Map<string, { page: ParsedCohortPage; ts: number }>()

function readCohortCache(key: string): ParsedCohortPage | null {
  const hit = cohortPageCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts >= COHORT_CACHE_TTL_MS) {
    cohortPageCache.delete(key)
    return null
  }
  return hit.page
}

function writeCohortCache(key: string, page: ParsedCohortPage): void {
  cohortPageCache.delete(key)
  cohortPageCache.set(key, { page, ts: Date.now() })
  while (cohortPageCache.size > COHORT_CACHE_MAX_ENTRIES) {
    const oldest = cohortPageCache.keys().next().value
    if (oldest === undefined) break
    cohortPageCache.delete(oldest)
  }
}

export function clearTraderCohortCache(): void {
  cohortPageCache.clear()
}

function sameCohort(left: LeaderboardCohort, right: LeaderboardCohort): boolean {
  return cohortKey(left) === cohortKey(right)
}

function isLeaderboardCohort(value: unknown): value is LeaderboardCohort {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    isTimeRange(record.timeRange) &&
    normalizePageIndex(record.pageIndex) === record.pageIndex &&
    (record.category === null || typeof record.category === 'string') &&
    typeof record.sortBy === 'string' &&
    typeof record.sortDir === 'string' &&
    (record.exchange === null || typeof record.exchange === 'string')
  )
}

function parseRankingBroadcastPayload(payload: TraderDataPayload): RankingBroadcastPayload | null {
  const record = payload as unknown as Record<string, unknown>
  const cohort = record.cohort
  if (!Array.isArray(record.traders) || !isLeaderboardCohort(cohort)) return null
  const parsedTotal = isSafeNonNegativeCount(record.totalCount) ? record.totalCount : null
  const totalCountIsExact = record.totalCountIsExact === true && parsedTotal !== null
  const parsedCategories =
    record.categoryCountsAreExact === true ? normalizeCategoryCounts(record.categoryCounts) : null
  const availableSources = Array.isArray(record.availableSources)
    ? record.availableSources.filter((source): source is string => typeof source === 'string')
    : []

  return {
    timeRange: cohort.timeRange,
    traders: record.traders,
    lastUpdated: typeof record.lastUpdated === 'string' ? record.lastUpdated : '',
    isStale: record.isStale === true,
    cohort,
    availableSources,
    totalCount: totalCountIsExact ? parsedTotal : null,
    totalCountIsExact,
    hasMore: record.hasMore === true,
    categoryCounts: parsedCategories ?? UNKNOWN_CATEGORY_COUNTS,
    categoryCountsAreExact: parsedCategories !== null,
  }
}

interface UseTraderDataOptions {
  autoRefreshInterval?: number
  sortBy?: SortBy
  sortOrder?: SortOrder
  initialTraders?: Trader[]
  initialLastUpdated?: string | null
  initialIsStale?: boolean
  /** Null/false means the SSR page has no same-cohort exact count authority. */
  initialTotalCount?: number | null
  initialTotalCountIsExact?: boolean
  /** SQL limit+1 witness for the initial finite page. */
  initialHasMore?: boolean
  initialCategoryCounts?: CategoryCounts
  initialCategoryCountsAreExact?: boolean
  /** Server-resolved range paired with initialTraders. */
  initialTimeRange?: TimeRange
  /** Zero-based server page paired with initialTraders/hasMore. */
  initialPageIndex?: number
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
  totalCount: number | null
  totalCountIsExact: boolean
  hasMore: boolean
  categoryCounts: CategoryCounts
  categoryCountsAreExact: boolean
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
      /** Only a successful range switch may change the visible range label. */
      timeRange?: TimeRange
      availableSources: string[]
      totalCount: number | null
      totalCountIsExact: boolean
      hasMore: boolean
      categoryCounts: CategoryCounts
      categoryCountsAreExact: boolean
      isStale: boolean
    }
  | { type: 'LOAD_ERROR'; error: string }
  | { type: 'LOAD_ABORT' }
  | {
      type: 'SET_COUNTS'
      totalCount: number | null
      totalCountIsExact: boolean
      hasMore: boolean
      categoryCounts: CategoryCounts
      categoryCountsAreExact: boolean
    }
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
        activeTimeRange: action.timeRange ?? state.activeTimeRange,
        error: null,
        currentTraders: action.traders,
        lastUpdated: action.lastUpdated,
        availableSources: action.availableSources,
        totalCount: action.totalCount,
        totalCountIsExact: action.totalCountIsExact,
        hasMore: action.hasMore,
        categoryCounts: action.categoryCounts,
        categoryCountsAreExact: action.categoryCountsAreExact,
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
      return {
        ...state,
        totalCount: action.totalCount,
        totalCountIsExact: action.totalCountIsExact,
        hasMore: action.hasMore,
        categoryCounts: action.categoryCounts,
        categoryCountsAreExact: action.categoryCountsAreExact,
      }
    case 'SET_STALE_DATA_WARNING':
      return { ...state, staleDataWarning: action.warning }
    default:
      return state
  }
}

/**
 * Server-side pagination hook for the homepage ranking table.
 *
 * SSR provides one finite page plus explicit count authority flags. Unknown
 * totals stay unknown; the only next-page authority is a limit+1 witness.
 * Client fetches subsequent pages from /api/traders on demand.
 * Category/sort changes trigger new API requests.
 */
export function useTraderData(options: UseTraderDataOptions = {}) {
  const {
    autoRefreshInterval = AUTO_REFRESH_MS,
    initialTraders,
    initialLastUpdated,
    initialIsStale = false,
    initialTotalCount = null,
    initialTotalCountIsExact = false,
    initialHasMore = false,
    initialCategoryCounts = { all: null, futures: null, spot: null, onchain: null },
    initialCategoryCountsAreExact = false,
    initialTimeRange = '90D',
    initialPageIndex = 0,
  } = options

  const safeInitialTimeRange = isTimeRange(initialTimeRange) ? initialTimeRange : '90D'
  const safeInitialPageIndex = normalizePageIndex(initialPageIndex)

  const initialExactTotal =
    initialTotalCountIsExact === true && isSafeNonNegativeCount(initialTotalCount)
      ? initialTotalCount
      : null
  const initialExactCategoryCounts =
    initialCategoryCountsAreExact === true ? normalizeCategoryCounts(initialCategoryCounts) : null

  const { t } = useLanguage()
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  // An empty non-first SSR page is still a real page snapshot. Do not replace
  // it with page 0 during hydration merely because it has no rows.
  const hasInitialData = Boolean(
    initialTraders && (initialTraders.length > 0 || safeInitialPageIndex > 0)
  )

  const [state, dispatch] = useReducer(traderDataReducer, {
    currentTraders: initialTraders || [],
    loading: !hasInitialData,
    error: null,
    lastUpdated: initialLastUpdated || null,
    availableSources: [],
    deferredFetchFailed: false,
    isChangingTimeRange: false,
    activeTimeRange: safeInitialTimeRange,
    totalCount: initialExactTotal,
    totalCountIsExact: initialExactTotal !== null,
    hasMore: initialHasMore === true,
    categoryCounts: initialExactCategoryCounts ?? UNKNOWN_CATEGORY_COUNTS,
    categoryCountsAreExact: initialExactCategoryCounts !== null,
    lastRefreshFailed: false,
    isStale: initialIsStale,
    staleDataWarning: false,
  })

  // Track consecutive auto-refresh failures for stale data warning
  const refreshFailCountRef = useRef(0)
  const isChangingTimeRangeRef = useRef(false)

  const { broadcast, on } = useTraderDataSync()

  useEffect(() => {
    isChangingTimeRangeRef.current = state.isChangingTimeRange
  }, [state.isChangingTimeRange])

  // Fingerprint to skip dispatching LOAD_SUCCESS when auto-refresh data is identical.
  // Without this, every 5-min refresh creates a new array reference → triggers full
  // re-render cascade through 5 useMemo chains → 50 TraderRow memo checks.
  const dataFingerprintRef = useRef('')

  const initialCohort: LeaderboardCohort = {
    timeRange: safeInitialTimeRange,
    pageIndex: safeInitialPageIndex,
    category: null,
    sortBy: 'arena_score',
    sortDir: 'desc',
    exchange: null,
  }
  // This ref describes the page currently on screen; refresh paths must use
  // it rather than silently returning the user to page 0.
  const loadedPageRef = useRef(safeInitialPageIndex)
  const loadedCohortRef = useRef<LeaderboardCohort>(initialCohort)
  // A request can be in flight while the UI still labels the already-loaded
  // cohort. Keep its desired identity separately for request cancellation, but
  // never let it authorize a cross-tab row replacement before the local
  // interaction has committed.
  const requestedCohortRef = useRef<LeaderboardCohort>(initialCohort)
  const requestSequenceRef = useRef(0)
  // A foreground request owns the visible transition. Background/manual
  // refreshes must not start a second request that can inherit or race with
  // this not-yet-committed target cohort.
  const foregroundRequestSequenceRef = useRef<number | null>(null)
  const pendingTimeRangeRef = useRef<TimeRange | null>(null)

  // Multi-tab synchronization is opt-in by an explicit, complete cohort
  // identity. Older payloads without it fail closed instead of swapping a
  // page/filter while retaining this tab's pagination authority.
  useEffect(() => {
    const unsubscribe = on('TRADER_DATA_UPDATED', (payload: TraderDataPayload) => {
      const incoming = parseRankingBroadcastPayload(payload)
      if (
        !incoming ||
        incoming.timeRange !== state.activeTimeRange ||
        !sameCohort(incoming.cohort, loadedCohortRef.current)
      ) {
        return
      }

      loadedPageRef.current = incoming.cohort.pageIndex
      loadedCohortRef.current = incoming.cohort
      startTransition(() => {
        dispatch({
          type: 'LOAD_SUCCESS',
          traders: incoming.traders as Trader[],
          lastUpdated: incoming.lastUpdated || null,
          availableSources: incoming.availableSources,
          totalCount: incoming.totalCount,
          totalCountIsExact: incoming.totalCountIsExact,
          hasMore: incoming.hasMore,
          categoryCounts: incoming.categoryCounts,
          categoryCountsAreExact: incoming.categoryCountsAreExact,
          isStale: incoming.isStale === true,
        })
      })
    })
    return unsubscribe
  }, [state.activeTimeRange, on])

  /**
   * Fetch a specific page from the API.
   * This is the core server-side pagination function.
   *
   * Callers pass only the dimension they are changing, but every target is
   * completed from the cohort currently on screen. It never inherits fields
   * from another in-flight target, so a failed ROI/exchange request cannot
   * leak into a later category/page request.
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
        /** Atomically reveal this range only with its successful response. */
        commitTimeRange?: boolean
        /** Background auto-refresh: skip LOAD_START so the table never dims/spins.
            Data lands via LOAD_SUCCESS (fingerprint-deduped) without UI churn. */
        silent?: boolean
      }
    ): Promise<boolean> => {
      // `silent` is an internal background capability, not permission to
      // compete with a user-visible transition. Keep the guard here as well
      // as in the interval callback so future callers cannot bypass it.
      if (
        opts?.silent === true &&
        (foregroundRequestSequenceRef.current !== null ||
          !sameCohort(requestedCohortRef.current, loadedCohortRef.current))
      ) {
        return false
      }
      // Build every target from the cohort that is actually on screen. Never
      // inherit from another request's desired/staged values: A=ROI may still
      // be pending when B=category begins, and B must remain score/category
      // rather than silently becoming ROI/category if A never commits.
      const loadedCohort = loadedCohortRef.current
      const timeRange = isTimeRange(opts?.timeRange) ? opts.timeRange : loadedCohort.timeRange
      const commitTimeRange = opts?.commitTimeRange === true
      // A normal foreground interaction supersedes a still-pending range
      // target. Letting that timer survive would later commit rows for an
      // abandoned target after the user has already requested another cohort.
      if (!commitTimeRange && pendingTimeRangeRef.current !== null) {
        pendingTimeRangeRef.current = null
        if (timeRangeDebounceTimer !== null) {
          clearTimeout(timeRangeDebounceTimer)
          timeRangeDebounceTimer = null
        }
      }
      const pageIndex = normalizePageIndex(page)
      const category =
        opts && 'category' in opts
          ? opts.category && opts.category !== 'all'
            ? opts.category
            : null
          : loadedCohort.category
      const sortBy = opts && 'sortBy' in opts ? opts.sortBy || 'arena_score' : loadedCohort.sortBy
      const sortDir = opts && 'sortDir' in opts ? opts.sortDir || 'desc' : loadedCohort.sortDir
      const rawExchange = opts && 'exchange' in opts ? opts.exchange || null : loadedCohort.exchange
      const exchange = rawExchange ? resolveExchangeSlug(rawExchange) : null
      const requestCohort: LeaderboardCohort = {
        timeRange,
        pageIndex,
        category,
        sortBy,
        sortDir,
        exchange,
      }
      const requestSequence = requestSequenceRef.current + 1
      requestSequenceRef.current = requestSequence
      requestedCohortRef.current = requestCohort
      if (!opts?.silent) foregroundRequestSequenceRef.current = requestSequence
      const requestKey = cohortKey(requestCohort)

      // Commits a parsed page for this request. Shared by the network path
      // and the range-switch cache path so both obey the same invariants.
      const commitPage = (parsed: ParsedCohortPage, broadcastResult: boolean): void => {
        // Fingerprint check: metrics, source watermark, and source-stale state
        // together define the visible ranking state. A freshness-only change
        // must reach the footer even when every score remains identical.
        const traderFingerprint = parsed.traders
          .map((t) => `${t.id}:${t.arena_score}:${t.roi}:${t.is_verified ? 'v' : ''}`)
          .join('|')
        const fingerprint = `${requestKey}::${traderFingerprint}::freshness:${parsed.lastUpdated ?? 'unknown'}:${parsed.isStale ? 'stale' : 'fresh'}::paging:${parsed.totalCount ?? 'unknown'}:${parsed.totalCountIsExact ? 'exact' : 'unknown'}:${parsed.hasMore ? 'more' : 'terminal'}::categories:${parsed.categoryCountsAreExact ? JSON.stringify(parsed.categoryCounts) : 'unknown'}`
        loadedPageRef.current = pageIndex
        loadedCohortRef.current = requestCohort
        if (commitTimeRange && pendingTimeRangeRef.current === timeRange) {
          pendingTimeRangeRef.current = null
        }
        if (foregroundRequestSequenceRef.current === requestSequence) {
          foregroundRequestSequenceRef.current = null
        }
        if (fingerprint === dataFingerprintRef.current) {
          // Data unchanged — skip dispatch to avoid unnecessary re-renders
          dispatch({ type: 'SET_LOADING', loading: false })
          return
        }
        dataFingerprintRef.current = fingerprint

        dispatch({
          type: 'LOAD_SUCCESS',
          traders: parsed.traders,
          lastUpdated: parsed.lastUpdated,
          timeRange: commitTimeRange ? timeRange : undefined,
          availableSources: parsed.availableSources,
          totalCount: parsed.totalCount,
          totalCountIsExact: parsed.totalCountIsExact,
          hasMore: parsed.hasMore,
          categoryCounts: parsed.categoryCounts ?? UNKNOWN_CATEGORY_COUNTS,
          categoryCountsAreExact: parsed.categoryCountsAreExact,
          isStale: parsed.isStale,
        })

        if (!broadcastResult) return
        // Broadcast for multi-tab sync
        const payload: RankingBroadcastPayload = {
          timeRange,
          traders: parsed.traders,
          lastUpdated: parsed.lastUpdated || '',
          isStale: parsed.isStale,
          cohort: requestCohort,
          availableSources: parsed.availableSources,
          totalCount: parsed.totalCount,
          totalCountIsExact: parsed.totalCountIsExact,
          hasMore: parsed.hasMore,
          categoryCounts: parsed.categoryCounts ?? UNKNOWN_CATEGORY_COUNTS,
          categoryCountsAreExact: parsed.categoryCountsAreExact,
        }
        broadcast('TRADER_DATA_UPDATED', payload)
      }

      // Cancel existing request
      const cancelKey = `page-${timeRange}`
      const existing = abortControllers.get(cancelKey)
      if (existing) existing.abort()

      // Range switch-back: a recently fetched page for the exact cohort is
      // committed immediately (no dim, no network). The bumped sequence above
      // already invalidates any slower in-flight response.
      if (commitTimeRange && !opts?.silent) {
        const cached = readCohortCache(requestKey)
        if (cached) {
          if (existing) abortControllers.delete(cancelKey)
          commitPage(cached, false)
          return true
        }
      }

      const controller = new AbortController()
      abortControllers.set(cancelKey, controller)
      // Distinguishes our own 8s deadline from a superseding/user cancel: a
      // timeout is a failure (error + retry), never a silent "no data".
      let timedOut = false

      if (!opts?.silent) dispatch({ type: 'LOAD_START' })

      try {
        let url = `/api/traders?timeRange=${timeRange}&limit=${PAGE_SIZE}&page=${pageIndex}`
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
        const timeoutId = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, 8_000)
        let response: Response
        try {
          response = await fetch(url, { signal: controller.signal })
        } finally {
          clearTimeout(timeoutId)
        }
        if (!response.ok) {
          throw new Error(`${tRef.current('loadFailed')} (${response.status})`)
        }

        const data = await response.json()
        // A slower, aborted request can still resolve in some environments.
        // Never let it overwrite or broadcast a newer page/filter cohort.
        if (requestSequence !== requestSequenceRef.current) return false
        // Same mapper as the SSR first paint (HomePageClient) — see toUiTrader.
        const rawRows: unknown[] = Array.isArray(data.traders) ? data.traders : []
        const traders: Trader[] = rawRows
          .filter(
            (row): row is UiTraderInput =>
              typeof row === 'object' &&
              row !== null &&
              typeof (row as { id?: unknown }).id === 'string'
          )
          .map(toUiTrader)

        const responseLastUpdated = data.lastUpdated || data.as_of || null
        // Current /api/traders uses camelCase. Keep the legacy snake_case read
        // during rollout so older cached payloads cannot silently lose the flag.
        const responseIsStale =
          typeof data.isStale === 'boolean'
            ? data.isStale
            : typeof data.is_stale === 'boolean'
              ? data.is_stale
              : false
        const parsedTotalCount = isSafeNonNegativeCount(data.totalCount) ? data.totalCount : null
        const responseTotalCountIsExact =
          data.totalCountIsExact === true && parsedTotalCount !== null
        const responseTotalCount = responseTotalCountIsExact ? parsedTotalCount : null
        const responseCategoryCounts =
          data.categoryCountsAreExact === true ? normalizeCategoryCounts(data.categoryCounts) : null
        const responseCategoryCountsAreExact = responseCategoryCounts !== null
        const responseHasMore = data.hasMore === true

        const parsed: ParsedCohortPage = {
          traders,
          lastUpdated: responseLastUpdated,
          isStale: responseIsStale,
          availableSources: Array.isArray(data.availableSources) ? data.availableSources : [],
          totalCount: responseTotalCount,
          totalCountIsExact: responseTotalCountIsExact,
          hasMore: responseHasMore,
          categoryCounts: responseCategoryCounts,
          categoryCountsAreExact: responseCategoryCountsAreExact,
        }
        writeCohortCache(requestKey, parsed)
        commitPage(parsed, true)
        return true
      } catch (err) {
        // A superseded request has no UI authority. In particular it must not
        // clear the loading state owned by the newer request.
        if (requestSequence !== requestSequenceRef.current) return false
        if (err instanceof Error && err.name === 'AbortError' && !timedOut) {
          dispatch({ type: 'LOAD_ABORT' })
          if (commitTimeRange && pendingTimeRangeRef.current === timeRange) {
            pendingTimeRangeRef.current = null
          }
          // The loaded cohort is the only valid recovery target. Requested
          // fields never become a future request baseline unless they land.
          requestedCohortRef.current = loadedCohortRef.current
          if (foregroundRequestSequenceRef.current === requestSequence) {
            foregroundRequestSequenceRef.current = null
          }
          return false
        }
        const errorMsg = timedOut
          ? tRef.current('errorTimeout')
          : err instanceof Error
            ? err.message
            : tRef.current('errorNetworkFailed')
        dispatch({ type: 'LOAD_ERROR', error: errorMsg })
        if (commitTimeRange && pendingTimeRangeRef.current === timeRange) {
          pendingTimeRangeRef.current = null
        }
        requestedCohortRef.current = loadedCohortRef.current
        if (foregroundRequestSequenceRef.current === requestSequence) {
          foregroundRequestSequenceRef.current = null
        }
        return false
      } finally {
        // Do not delete a newer controller after this request settles.
        if (abortControllers.get(cancelKey) === controller) {
          abortControllers.delete(cancelKey)
        }
      }
    },
    [state.activeTimeRange, broadcast]
  )
  // Count authority is parsed only from the response currently being applied;
  // it intentionally has no state fallback. A missing total must clear a
  // previously exact one rather than carrying stale pagination forward.

  // Seed cache with initial data
  const initialDataSeeded = useRef(false)
  useEffect(() => {
    if (hasInitialData && !initialDataSeeded.current) {
      initialDataSeeded.current = true
      // The SSR page is the cohort on screen: make switching back to it
      // instant (only if nothing fresher is already cached for it).
      const initialKey = cohortKey(loadedCohortRef.current)
      if (!readCohortCache(initialKey)) {
        writeCohortCache(initialKey, {
          traders: initialTraders || [],
          lastUpdated: initialLastUpdated || null,
          isStale: initialIsStale,
          availableSources: [],
          totalCount: initialExactTotal,
          totalCountIsExact: initialExactTotal !== null,
          hasMore: initialHasMore === true,
          categoryCounts: initialExactCategoryCounts,
          categoryCountsAreExact: initialExactCategoryCounts !== null,
        })
      }
      dispatch({ type: 'SET_LOADING', loading: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once from the SSR snapshot
  }, [hasInitialData])

  // The initial SSR snapshot needs no client fetch. Subsequent range changes
  // are requested directly by changeTimeRange and only commit the range label
  // alongside LOAD_SUCCESS, never while old rows are still visible.
  const isInitialMount = useRef(true)
  useEffect(() => {
    if (!isInitialMount.current) return
    isInitialMount.current = false
    if (hasInitialData) {
      dispatch({ type: 'SET_LOADING', loading: false })
      return
    }
    void fetchPage(0, { timeRange: state.activeTimeRange })
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
      // A background poll of the old range must never supersede a pending
      // range cohort. Its rows would be valid for 90D but invalidate the
      // in-flight 30D/7D request's sequence ownership.
      if (
        isChangingTimeRangeRef.current ||
        foregroundRequestSequenceRef.current !== null ||
        !sameCohort(requestedCohortRef.current, loadedCohortRef.current)
      ) {
        return
      }
      lastFetchTime = Date.now()
      // silent: a background poll must not dim the table or show the
      // refresh spinner — fingerprint dedup means most polls change nothing.
      fetchPage(loadedPageRef.current, { silent: true }).then((succeeded) => {
        if (succeeded) {
          refreshFailCountRef.current = 0
        } else {
          refreshFailCountRef.current += 1
          if (refreshFailCountRef.current > 3) {
            dispatch({ type: 'SET_STALE_DATA_WARNING', warning: true })
          }
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

  // Time range switching holds the visible range/rows together until the new
  // cohort succeeds. The spinner announces the pending choice without putting
  // old 90D rows under a 30D (or 7D) label.
  const changeTimeRange = useCallback(
    (range: TimeRange) => {
      // Clicking back to the already-visible range is a real cancellation
      // action when another range is pending. Increment the sequence as well
      // as aborting: some fetch implementations can resolve after abort.
      if (range === activeTimeRangeRef.current) {
        const hadPendingRange = pendingTimeRangeRef.current !== null
        pendingTimeRangeRef.current = null
        if (timeRangeDebounceTimer !== null) {
          clearTimeout(timeRangeDebounceTimer)
          timeRangeDebounceTimer = null
        }
        if (hadPendingRange) {
          requestSequenceRef.current += 1
          for (const [key, controller] of abortControllers.entries()) {
            controller.abort()
            abortControllers.delete(key)
          }
          requestedCohortRef.current = loadedCohortRef.current
          foregroundRequestSequenceRef.current = null
          dispatch({ type: 'LOAD_ABORT' })
        }
        return
      }

      if (pendingTimeRangeRef.current === range) return
      // Invalidate any request we are about to abort before its rejection
      // handler runs. Otherwise a 90D request cancelled by a 30D click can
      // clear the new range's pending indicator during its debounce window.
      requestSequenceRef.current += 1
      pendingTimeRangeRef.current = range
      // The debounce itself is a foreground transition: do not let a manual
      // or silent refresh race it before the target fetch has been created.
      foregroundRequestSequenceRef.current = requestSequenceRef.current
      dispatch({ type: 'SET_CHANGING_TIME_RANGE', isChanging: true })

      if (timeRangeDebounceTimer !== null) {
        clearTimeout(timeRangeDebounceTimer)
        timeRangeDebounceTimer = null
      }

      for (const [tr, controller] of abortControllers.entries()) {
        if (tr !== `page-${range}`) {
          controller.abort()
          abortControllers.delete(tr)
        }
      }

      // A cached target cohort needs no debounce: commit it now.
      const loaded = loadedCohortRef.current
      const targetKey = cohortKey({ ...loaded, timeRange: range, pageIndex: 0 })
      if (readCohortCache(targetKey)) {
        void fetchPage(0, { timeRange: range, commitTimeRange: true })
        return
      }

      timeRangeDebounceTimer = setTimeout(() => {
        timeRangeDebounceTimer = null
        if (pendingTimeRangeRef.current !== range) return
        void fetchPage(0, { timeRange: range, commitTimeRange: true })
      }, TIME_RANGE_DEBOUNCE_MS)
    },
    [fetchPage]
  )

  const refresh = useCallback(() => {
    if (
      isChangingTimeRangeRef.current ||
      foregroundRequestSequenceRef.current !== null ||
      !sameCohort(requestedCohortRef.current, loadedCohortRef.current)
    ) {
      return Promise.resolve(false)
    }
    return fetchPage(loadedPageRef.current)
  }, [fetchPage])

  const retryDeferredFetch = useCallback(() => {
    if (
      isChangingTimeRangeRef.current ||
      foregroundRequestSequenceRef.current !== null ||
      !sameCohort(requestedCohortRef.current, loadedCohortRef.current)
    ) {
      return
    }
    dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: false })
    void fetchPage(loadedPageRef.current).then((succeeded) => {
      if (!succeeded) dispatch({ type: 'SET_DEFERRED_FETCH_FAILED', failed: true })
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
      clearCache: clearTraderCohortCache,
      deferredFetchFailed: state.deferredFetchFailed,
      retryDeferredFetch,
      isChangingTimeRange: state.isChangingTimeRange,
      totalCount: state.totalCount,
      totalCountIsExact: state.totalCountIsExact,
      hasMore: state.hasMore,
      categoryCounts: state.categoryCounts,
      categoryCountsAreExact: state.categoryCountsAreExact,
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
      state.totalCountIsExact,
      state.hasMore,
      state.categoryCounts,
      state.categoryCountsAreExact,
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
