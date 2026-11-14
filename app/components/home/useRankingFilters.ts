'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '../ui/Toast'
import type { Trader } from '../ranking/RankingTable'

import type { TimeRange } from './hooks/useTraderData'
import { CategoryType, filterByCategory } from '../ranking/CategoryRankingTabs'
import { useSubscription } from './hooks/useSubscription'
import { useLanguage } from '../Providers/LanguageProvider'
import type { FilterConfig, SavedFilter } from '../premium/AdvancedFilter'
import { getScoreGradeLetter } from '@/lib/utils/score-explain'
import { parsePublicActiveRankingSource, resolveExchangeSlug } from '@/lib/constants/exchanges'
import { isPublicRankingSourceQuarantined } from '@/lib/rankings/publication-policy'
import { type PresetId, PRESETS, isValidPresetId } from '../ranking/FilterPresets'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { trackEvent } from '@/lib/analytics/track'
import type { SortColumn, SortDir } from '../ranking/RankingTableTypes'
import { leaderboardFilterQuery } from '@/lib/rankings/leaderboard-filters'

// localStorage keys for user preferences
const LS_KEY_SORT_COLUMN = 'ranking-sort-column'
const LS_KEY_SORT_DIR = 'ranking-sort-dir'
const LS_KEY_PRESET = 'ranking-preset'
const LS_KEY_EXCHANGE = 'ranking-exchange'
const LS_KEY_FILTER_CONFIG = 'ranking-filter-config'
/** Typing in a filter input waits this long before the server cohort request. */
const FILTER_FETCH_DEBOUNCE_MS = 400

/** Canonical `/api/traders` filter params for this filter state (null = none). */
function serverFilterQuery(config: FilterConfig, preset: PresetId | null): string | null {
  // The API takes exact public source ids only; a stale stored exchange is
  // dropped rather than failing the whole page with a 400.
  return leaderboardFilterQuery(config, preset, (slug) => {
    const source = resolveExchangeSlug(slug)
    return parsePublicActiveRankingSource(source) || isPublicRankingSourceQuarantined(source)
      ? source
      : null
  })
}

const URL_SORT_COLUMNS: readonly SortColumn[] = ['score', 'roi', 'pnl', 'winrate', 'mdd', 'sortino']
const SORT_BY: Record<SortColumn, string> = {
  score: 'arena_score',
  roi: 'roi',
  pnl: 'pnl',
  winrate: 'win_rate',
  mdd: 'max_drawdown',
  sortino: 'sortino_ratio',
}

function isUrlSortColumn(value: string | null): value is SortColumn {
  return value !== null && URL_SORT_COLUMNS.includes(value as SortColumn)
}

function urlSortColumn(value: string | null): SortColumn {
  // Alpha has no trusted public source contract. Keep old shared links useful
  // by resolving them to the canonical score order, never by forwarding alpha
  // to the API or reintroducing an unproven ranking surface.
  return value === 'alpha' ? 'score' : isUrlSortColumn(value) ? value : 'score'
}

function urlSortDir(value: string | null): SortDir {
  return value === 'asc' || value === 'desc' ? value : 'desc'
}

function normalizeInitialPageIndex(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function pageIndexFromUrl(value: string | null): number | null {
  if (!value || !/^[1-9]\d{0,4}$/.test(value)) return null
  const oneBased = Number(value)
  return Number.isSafeInteger(oneBased) ? oneBased - 1 : null
}

function apiCategoryFor(category: CategoryType): string | undefined {
  return category === 'web3' ? 'onchain' : category === 'all' ? undefined : category
}

function categoryFromUrl(value: string | null): CategoryType | null {
  if (value === 'futures' || value === 'spot' || value === 'all') return value
  return value === 'web3' || value === 'onchain' ? 'web3' : null
}

function commitExchangeCohortUrl(exchange: string | null, eventTimeRange?: unknown): void {
  const params = new URLSearchParams(window.location.search)
  params.delete('exchange')
  params.delete('ex')
  params.delete('page')
  // The API ignores category whenever an exchange is set, so an exchange
  // cohort is always the all-category board of that exchange. Keep the URL
  // honest about that instead of carrying a stale category label.
  params.delete('category')
  if (exchange) params.set('ex', exchange)
  if (eventTimeRange === '7D' || eventTimeRange === '30D' || eventTimeRange === '90D') {
    params.delete('range')
    if (eventTimeRange !== '90D') params.set('range', eventTimeRange)
  }
  const query = params.toString()
  window.history.replaceState(
    null,
    '',
    query ? `${window.location.pathname}?${query}` : window.location.pathname
  )
}

function commitCategoryCohortUrl(category: CategoryType): void {
  const params = new URLSearchParams(window.location.search)
  params.delete('category')
  params.delete('page')
  // Switching category leaves any exchange scope (see setCategory).
  params.delete('ex')
  params.delete('exchange')
  if (category !== 'all') params.set('category', category === 'web3' ? 'onchain' : category)
  const query = params.toString()
  window.history.replaceState(
    null,
    '',
    query ? `${window.location.pathname}?${query}` : window.location.pathname
  )
}

// Helper to get stored preferences
function getStoredPreferences() {
  if (typeof window === 'undefined') return {}
  try {
    let filterConfig: FilterConfig | null = null
    const storedFilterConfig = localStorage.getItem(LS_KEY_FILTER_CONFIG)
    if (storedFilterConfig) {
      try {
        filterConfig = JSON.parse(storedFilterConfig)
      } catch {
        /* invalid JSON */
      }
    }
    return {
      filterConfig,
    }
  } catch {
    return {}
  }
}

// Client-side advanced filter
function applyAdvancedFilter(list: Trader[], config: FilterConfig): Trader[] {
  return list.filter((trader) => {
    if (config.exchange?.length) {
      const src = (trader.source || '').toLowerCase()
      if (
        !config.exchange.some((ex) => {
          const resolved = resolveExchangeSlug(ex)
          return src === ex || src === resolved || src.startsWith(ex) || src.startsWith(resolved)
        })
      )
        return false
    }
    if (
      config.roi_min != null &&
      (trader.roi == null || !Number.isFinite(trader.roi) || trader.roi < config.roi_min)
    )
      return false
    if (
      config.roi_max != null &&
      (trader.roi == null || !Number.isFinite(trader.roi) || trader.roi > config.roi_max)
    )
      return false
    if (
      config.drawdown_min != null &&
      trader.max_drawdown != null &&
      Math.abs(trader.max_drawdown) < config.drawdown_min
    )
      return false
    if (
      config.drawdown_max != null &&
      trader.max_drawdown != null &&
      Math.abs(trader.max_drawdown) > config.drawdown_max
    )
      return false
    if (config.min_pnl != null && (trader.pnl == null || trader.pnl < config.min_pnl)) return false
    if (
      config.min_score != null &&
      (trader.arena_score == null ||
        !Number.isFinite(trader.arena_score) ||
        trader.arena_score < config.min_score)
    )
      return false
    if (
      config.min_win_rate != null &&
      (trader.win_rate == null || trader.win_rate < config.min_win_rate)
    )
      return false
    if (
      config.grade &&
      (trader.arena_score == null ||
        !Number.isFinite(trader.arena_score) ||
        getScoreGradeLetter(trader.arena_score) !== config.grade)
    )
      return false
    return true
  })
}

interface UseRankingFiltersOptions {
  traders: Trader[]
  activeTimeRange: TimeRange
  totalCount?: number | null
  categoryCounts?: {
    all: number | null
    futures: number | null
    spot: number | null
    onchain: number | null
  }
  /** Zero-based SSR page whose rows arrived with this hook's first render. */
  initialPageIndex?: number
  /** URL has a sort/category/exchange/filter that Page cannot SSR faithfully. */
  requiresInitialCohortFetch?: boolean
  /** Incremented to retry a direct-link cohort after a failed first request. */
  initialCohortAttempt?: number
  /** The parent keeps SSR neutral until the target cohort request succeeds. */
  onInitialCohortSettled?: (succeeded: boolean) => void
  fetchPage?: (
    page: number,
    opts?: {
      category?: string
      sortBy?: string
      sortDir?: string
      exchange?: string
      filters?: string | null
    }
  ) => Promise<boolean>
}

export function useRankingFilters({
  traders,
  activeTimeRange,
  totalCount: _totalCount,
  categoryCounts: _categoryCounts,
  initialPageIndex,
  requiresInitialCohortFetch = false,
  initialCohortAttempt = 0,
  onInitialCohortSettled,
  fetchPage,
}: UseRankingFiltersOptions) {
  const router = useRouter()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { isFeaturesUnlocked, isLoading: premiumLoading } = useSubscription()
  const isPro = isFeaturesUnlocked
  const { getAuthHeaders } = useAuthSession()

  // State
  const [category, setCategoryRaw] = useState<CategoryType>('all')
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [showMobileFilter, setShowMobileFilter] = useState(false)
  const [filterConfig, setFilterConfig] = useState<FilterConfig>({})
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])
  const [activePreset, setActivePreset] = useState<PresetId | null>(null)
  const [sortColumn, setSortColumn] = useState<SortColumn>('score')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [currentPage, setCurrentPage] = useState(
    () => normalizeInitialPageIndex(initialPageIndex) + 1
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null)

  // Listen for exchange filter events from ExchangePartners bar
  useEffect(() => {
    const handler = (e: Event) => {
      const { exchange, timeRange } = (e as CustomEvent).detail ?? {}
      if (exchange) {
        if (fetchPage) {
          // Keep the currently labelled cohort on screen until the server
          // confirms this exchange page. Otherwise old rows momentarily wear
          // a new filter label.
          // An exchange cohort is all-category (the API ignores category when
          // exchange is set), so request and label it that way.
          void fetchPage(0, { exchange, category: undefined }).then((succeeded) => {
            if (!succeeded) return
            const committedExchange = resolveExchangeSlug(exchange)
            setSelectedExchange(committedExchange)
            setCategoryRaw('all')
            setCurrentPage(1)
            commitExchangeCohortUrl(committedExchange, timeRange)
          })
        } else {
          setSelectedExchange(exchange)
          setCategoryRaw('all')
          setCurrentPage(1)
        }
      }
    }
    window.addEventListener('arena:filter-exchange', handler)
    return () => window.removeEventListener('arena:filter-exchange', handler)
  }, [fetchPage])

  // Server-side category change: fetch page 0 of the new category
  const setCategory = useCallback(
    (cat: CategoryType) => {
      if (fetchPage) {
        // Do not relabel the current rows as a new category before the API
        // has returned that category's first page.
        // A category tab is a cross-exchange board. The API ignores category
        // while an exchange is set, so carrying the exchange over would label
        // one exchange's rows as e.g. "Spot". Leave the exchange scope.
        void fetchPage(0, { category: apiCategoryFor(cat), exchange: undefined }).then(
          (succeeded) => {
            if (!succeeded) return
            setCategoryRaw(cat)
            setSelectedExchange(null)
            setCurrentPage(1)
            commitCategoryCohortUrl(cat)
          }
        )
      } else {
        setCategoryRaw(cat)
        setSelectedExchange(null)
        setCurrentPage(1)
        commitCategoryCohortUrl(cat)
      }
    },
    [fetchPage]
  )

  // "Filtered by X · Clear" affordance: drop only the exchange scope and keep
  // sort order. Labels change only after the unscoped page has landed.
  const clearExchange = useCallback(() => {
    const commit = () => {
      setSelectedExchange(null)
      setCurrentPage(1)
      try {
        localStorage.removeItem(LS_KEY_EXCHANGE)
      } catch {
        /* ignore */
      }
      commitExchangeCohortUrl(null)
    }
    if (fetchPage) {
      void fetchPage(0, { exchange: undefined, category: undefined }).then((succeeded) => {
        if (succeeded) commit()
      })
      return
    }
    commit()
  }, [fetchPage])

  // Reset pagination when time range changes
  const prevTimeRange = useRef(activeTimeRange)
  // `useEffect` runs after React has committed a render. Derive page one for
  // that transition render so a newly committed range page 0 can never paint
  // beneath an old page-3 control label.
  const displayedCurrentPage = prevTimeRange.current === activeTimeRange ? currentPage : 1
  useEffect(() => {
    if (prevTimeRange.current !== activeTimeRange) {
      setCurrentPage(1)
      prevTimeRange.current = activeTimeRange
    }
  }, [activeTimeRange])

  // Restore filter state from URL + localStorage
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const config: FilterConfig = {}
    const roiMin = searchParams.get('roi_min')
    const roiMax = searchParams.get('roi_max')
    const ddMin = searchParams.get('dd_min')
    const ddMax = searchParams.get('dd_max')
    const minPnl = searchParams.get('min_pnl')
    const minScore = searchParams.get('min_score')
    const minWr = searchParams.get('min_wr')
    const fcat = searchParams.get('fcat')
    const fex = searchParams.get('fex')
    const urlSortRaw = searchParams.get('sort')
    const urlOrderRaw = searchParams.get('order')
    const urlPage = searchParams.get('page')
    const urlQ = searchParams.get('q')
    const urlPreset = searchParams.get('preset') as PresetId | null
    const urlEx = searchParams.get('ex')
    const urlCategory = categoryFromUrl(searchParams.get('category'))
    const legacyExchange = searchParams.get('exchange')
    const requestedSort = urlSortColumn(urlSortRaw)
    const requestedSortDir = urlSortDir(urlOrderRaw)
    const urlPageIndex = pageIndexFromUrl(urlPage)
    const hasServerPage = initialPageIndex !== undefined
    const targetPageIndex = hasServerPage
      ? normalizeInitialPageIndex(initialPageIndex)
      : (urlPageIndex ?? 0)
    const requestedExchange = urlEx || legacyExchange

    if (roiMin) config.roi_min = Number(roiMin)
    if (roiMax) config.roi_max = Number(roiMax)
    if (ddMin) config.drawdown_min = Number(ddMin)
    if (ddMax) config.drawdown_max = Number(ddMax)
    if (minPnl) config.min_pnl = Number(minPnl)
    if (minScore) config.min_score = Number(minScore)
    if (minWr) config.min_win_rate = Number(minWr)
    if (fcat) config.category = fcat.split(',')
    if (fex) config.exchange = fex.split(',').filter(Boolean)

    const storedPrefs = getStoredPreferences()
    // The exchange scope comes from the URL only. The legacy `ranking-exchange`
    // preference (written by a picker that no longer exists) silently scoped a
    // clean homepage to one exchange with no visible way out; drop it.
    try {
      localStorage.removeItem(LS_KEY_EXCHANGE)
    } catch {
      /* ignore */
    }
    const targetExchange = requestedExchange || undefined
    const resolvedExchange = targetExchange
      ? resolveExchangeSlug(targetExchange.split(',')[0])
      : undefined

    let restoredConfig: FilterConfig = {}
    if (Object.keys(config).length > 0) {
      restoredConfig = config
      setFilterConfig(config)
      setShowAdvancedFilter(true)
    } else if (storedPrefs.filterConfig && Object.keys(storedPrefs.filterConfig).length > 0) {
      restoredConfig = storedPrefs.filterConfig
      setFilterConfig(storedPrefs.filterConfig)
      setShowAdvancedFilter(true)
    }

    try {
      localStorage.removeItem(LS_KEY_SORT_COLUMN)
      localStorage.removeItem(LS_KEY_SORT_DIR)
    } catch {
      /* ignore */
    }

    if (isUrlSortColumn(urlSortRaw) || urlSortRaw === 'alpha') setSortColumn(requestedSort)
    if (urlOrderRaw === 'asc' || urlOrderRaw === 'desc') setSortDir(requestedSortDir)
    // Page is server-authoritative whenever it was provided through the SSR
    // snapshot. A client-only use of this hook may still restore a URL page.
    if (!hasServerPage && urlPageIndex !== null) setCurrentPage(urlPageIndex + 1)
    if (urlQ) setSearchQuery(urlQ)

    // `?ex=` wins over `?category=`: the API ignores category for an exchange
    // cohort, so labelling the tab with it would contradict the rows.
    const effectiveUrlCategory = resolvedExchange ? null : urlCategory
    if (effectiveUrlCategory) setCategoryRaw(effectiveUrlCategory)

    if (urlSortRaw === 'alpha') {
      const canonicalParams = new URLSearchParams(window.location.search)
      canonicalParams.set('sort', 'score')
      const canonicalQuery = canonicalParams.toString()
      window.history.replaceState(
        null,
        '',
        canonicalQuery ? `${window.location.pathname}?${canonicalQuery}` : window.location.pathname
      )
    }

    // Presets have no on-page picker any more, so a value persisted by an
    // older UI would filter the board invisibly. Honour only an explicit
    // `?preset=` link and drop the legacy stored preference.
    const restoredPreset = urlPreset && isValidPresetId(urlPreset) ? urlPreset : null
    if (restoredPreset) setActivePreset(restoredPreset)
    const initialFilters = serverFilterQuery(restoredConfig, restoredPreset)
    try {
      localStorage.removeItem(LS_KEY_PRESET)
    } catch {
      /* ignore */
    }

    if (resolvedExchange) setSelectedExchange(resolvedExchange)

    // Page/range are read by Page and arrive as a coherent SSR snapshot. Any
    // other query state needs one matching client fetch before the target sort,
    // category, exchange, or filter is allowed to replace that neutral shell.
    const shouldFetchInitialCohort =
      requiresInitialCohortFetch ||
      resolvedExchange !== undefined ||
      initialFilters !== null ||
      (!hasServerPage &&
        (urlPageIndex !== null ||
          urlSortRaw !== null ||
          urlOrderRaw !== null ||
          urlCategory !== null ||
          resolvedExchange !== undefined))
    if (shouldFetchInitialCohort && fetchPage) {
      void fetchPage(targetPageIndex, {
        category: apiCategoryFor(effectiveUrlCategory ?? 'all'),
        sortBy: SORT_BY[requestedSort],
        sortDir: requestedSortDir,
        exchange: resolvedExchange,
        filters: initialFilters,
      }).then((succeeded) => onInitialCohortSettled?.(succeeded))
    } else if (requiresInitialCohortFetch) {
      onInitialCohortSettled?.(false)
    }
    // `initialCohortAttempt` is deliberately the only changing dependency:
    // repeating this same URL cohort is the retry path after a failed first
    // request. All query-derived target values are read afresh above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCohortAttempt])

  // Debounce ref for URL sync
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
    }
  }, [])

  // Use refs for URL sync to avoid recreating syncStateToUrl on every state change
  // This prevents cascading dependency changes that cause infinite re-render loops
  const stateRef = useRef({
    category,
    filterConfig,
    sortColumn,
    sortDir,
    currentPage: displayedCurrentPage,
    searchQuery,
    activePreset,
    selectedExchange,
  })
  useEffect(() => {
    stateRef.current = {
      category,
      filterConfig,
      sortColumn,
      sortDir,
      currentPage: displayedCurrentPage,
      searchQuery,
      activePreset,
      selectedExchange,
    }
  })

  // Sync state to URL (debounced) — stable reference, reads from stateRef
  const syncStateToUrl = useCallback(
    (
      overrides: {
        config?: FilterConfig
        category?: CategoryType | null
        sort?: string
        order?: string
        page?: number
        q?: string
        preset?: string | null
        ex?: string | null
      } = {}
    ) => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
      syncTimeoutRef.current = setTimeout(() => {
        const s = stateRef.current
        const params = new URLSearchParams(window.location.search)
        const config = overrides.config ?? s.filterConfig

        ;[
          'roi_min',
          'roi_max',
          'dd_min',
          'dd_max',
          'min_pnl',
          'min_score',
          'min_wr',
          'exchange',
          'category',
          'fcat',
          'fex',
          'sort',
          'order',
          'page',
          'q',
          'preset',
          'ex',
        ].forEach((k) => params.delete(k))

        if (config.roi_min != null) params.set('roi_min', String(config.roi_min))
        if (config.roi_max != null) params.set('roi_max', String(config.roi_max))
        if (config.drawdown_min != null) params.set('dd_min', String(config.drawdown_min))
        if (config.drawdown_max != null) params.set('dd_max', String(config.drawdown_max))
        if (config.min_pnl != null) params.set('min_pnl', String(config.min_pnl))
        if (config.min_score != null) params.set('min_score', String(config.min_score))
        if (config.min_win_rate != null) params.set('min_wr', String(config.min_win_rate))
        // Advanced-filter exchanges are a client-side multi-select over the
        // loaded page. They get their own key: `exchange`/`ex` mean a single
        // server exchange cohort and would be re-read with that meaning.
        if (config.exchange?.length) params.set('fex', config.exchange.join(','))
        if (config.category?.length) params.set('fcat', config.category.join(','))

        const urlCategory = overrides.category !== undefined ? overrides.category : s.category
        if (urlCategory && urlCategory !== 'all') {
          params.set('category', urlCategory === 'web3' ? 'onchain' : urlCategory)
        }

        const sort = overrides.sort ?? s.sortColumn
        const order = overrides.order ?? s.sortDir
        const page = overrides.page ?? s.currentPage
        const q = overrides.q ?? s.searchQuery
        const preset = overrides.preset !== undefined ? overrides.preset : s.activePreset

        if (sort && sort !== 'score') params.set('sort', sort)
        if (order && order !== 'desc') params.set('order', order)
        if (page && page > 1) params.set('page', String(page))
        if (q) params.set('q', q)
        if (preset) params.set('preset', preset)

        const ex = overrides.ex !== undefined ? overrides.ex : s.selectedExchange
        if (ex) params.set('ex', ex)

        const qs = params.toString()
        const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
        window.history.replaceState(null, '', newUrl)
      }, 300)
    },
    []
  ) // Stable — never recreates, reads current state from stateRef

  // Current filter params for a server request, read from the latest state so
  // a sort/page/category request never drops a just-changed filter.
  const currentFilterQuery = useCallback(
    () => serverFilterQuery(stateRef.current.filterConfig, stateRef.current.activePreset),
    []
  )

  const commitFilterConfig = useCallback(
    (config: FilterConfig) => {
      setFilterConfig(config)
      stateRef.current = { ...stateRef.current, filterConfig: config }
      syncStateToUrl({ config })
      try {
        if (Object.keys(config).length > 0) {
          localStorage.setItem(LS_KEY_FILTER_CONFIG, JSON.stringify(config))
        } else {
          localStorage.removeItem(LS_KEY_FILTER_CONFIG)
        }
      } catch {
        /* ignore */
      }
    },
    [syncStateToUrl]
  )

  const filterFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (filterFetchTimerRef.current) clearTimeout(filterFetchTimerRef.current)
    }
  }, [])

  // Filter change handler. With server paging the filters are API params:
  // page 0 of the filtered cohort is fetched (debounced while typing), so
  // every page and `hasMore` describe the filtered board.
  const handleFilterChange = useCallback(
    (config: FilterConfig) => {
      trackEvent('ranking_filter', {
        kind: 'advanced',
        active_count: Object.keys(config).length,
      })
      commitFilterConfig(config)
      if (!fetchPage) return
      if (filterFetchTimerRef.current) clearTimeout(filterFetchTimerRef.current)
      filterFetchTimerRef.current = setTimeout(() => {
        filterFetchTimerRef.current = null
        void fetchPage(0, { filters: currentFilterQuery() }).then((succeeded) => {
          if (!succeeded) return
          setCurrentPage(1)
          syncStateToUrl({ page: 1 })
        })
      }, FILTER_FETCH_DEBOUNCE_MS)
    },
    [commitFilterConfig, currentFilterQuery, fetchPage, syncStateToUrl]
  )

  // Sort/page/search handlers — trigger server-side fetch when fetchPage is available
  const handleSortChange = useCallback(
    (col: SortColumn, dir: SortDir) => {
      trackEvent('ranking_sort', { column: col, direction: dir })
      if (fetchPage) {
        // The table keeps its prior header/page labels while this request is
        // in flight. `fetchPage` resolves true only for the newest successful
        // cohort, so an older response cannot commit stale UI state.
        void fetchPage(0, {
          category: apiCategoryFor(category),
          sortBy: SORT_BY[col],
          sortDir: dir,
          filters: currentFilterQuery(),
        }).then((succeeded) => {
          if (!succeeded) return
          setSortColumn(col)
          setSortDir(dir)
          setCurrentPage(1)
          syncStateToUrl({ sort: col, order: dir, page: 1 })
        })
      } else {
        setSortColumn(col)
        setSortDir(dir)
        setCurrentPage(1)
        syncStateToUrl({ sort: col, order: dir, page: 1 })
      }
    },
    [syncStateToUrl, fetchPage, category, currentFilterQuery]
  )

  const handlePageChange = useCallback(
    (page: number) => {
      const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1
      if (fetchPage) {
        // Avoid displaying old page rows under the requested page number.
        void fetchPage(safePage - 1, {
          category: apiCategoryFor(category),
          sortBy: SORT_BY[sortColumn],
          sortDir: sortDir,
          filters: currentFilterQuery(),
        }).then((succeeded) => {
          if (!succeeded) return
          setCurrentPage(safePage)
          syncStateToUrl({ page: safePage })
        })
      } else {
        setCurrentPage(safePage)
        syncStateToUrl({ page: safePage })
      }
    },
    [syncStateToUrl, fetchPage, category, sortColumn, sortDir, currentFilterQuery]
  )

  const handleSearchChange = useCallback(
    (q: string) => {
      setSearchQuery(q)
      setCurrentPage(1)
      syncStateToUrl({ q, page: 1 })
    },
    [syncStateToUrl]
  )

  // Saved filter handlers
  const handleSaveFilter = async (name: string, description?: string) => {
    const authHeaders = getAuthHeaders()
    if (!authHeaders) {
      showToast(t('pleaseLogin'), 'error')
      return
    }
    try {
      const res = await fetch('/api/saved-filters', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ name, description, filter_config: filterConfig }),
      })
      if (res.ok) {
        const data = await res.json()
        setSavedFilters((prev) => [...prev, data.filter])
        showToast(t('filterSaved'), 'success')
      } else {
        const errorData = await res.json().catch(() => ({}))
        showToast(errorData.error || t('saveFailed'), 'error')
      }
    } catch {
      showToast(t('saveFailed'), 'error')
    }
  }

  const handleLoadFilter = (filter: SavedFilter) => {
    handleFilterChange(filter.filter_config)
  }

  const handleDeleteFilter = async (filterId: string) => {
    const authHeaders = getAuthHeaders()
    if (!authHeaders) {
      showToast(t('pleaseLogin'), 'error')
      return
    }
    try {
      const res = await fetch(`/api/saved-filters?id=${filterId}`, {
        method: 'DELETE',
        headers: {
          ...authHeaders,
          ...getCsrfHeaders(),
        },
      })
      if (res.ok) {
        setSavedFilters((prev) => prev.filter((f) => f.id !== filterId))
        showToast(t('deleted'), 'success')
      } else {
        showToast(t('deleteFailed'), 'error')
      }
    } catch {
      showToast(t('deleteFailed'), 'error')
    }
  }

  // Check for active filters (memoized to avoid recomputation on every render)
  const hasActiveFilters = useMemo(
    () =>
      Object.keys(filterConfig).some((key) => {
        const value = filterConfig[key as keyof FilterConfig]
        if (Array.isArray(value)) return value.length > 0
        return value != null
      }),
    [filterConfig]
  )

  // Advanced filters or a URL preset narrow the cohort. With server paging the
  // API applies them to the whole board; drives the filtered empty state.
  const hasCohortFilters = hasActiveFilters || (!!activePreset && activePreset !== 'all')

  const source = useMemo(() => (traders.length > 0 ? traders[0].source : 'all'), [traders])

  // Format last updated time
  const formatLastUpdated = useCallback(
    (dateStr: string | null | undefined) => {
      if (!dateStr) return null
      try {
        const date = new Date(dateStr)
        const now = new Date()
        const diffMs = now.getTime() - date.getTime()
        const diffMins = Math.floor(diffMs / 60000)

        if (diffMins < 1) return t('justUpdated')
        if (diffMins < 60) return t('minutesAgoShort').replace('{n}', String(diffMins))
        const diffHours = Math.floor(diffMins / 60)
        if (diffHours < 24) return t('hoursAgoShort').replace('{n}', String(diffHours))
        return t('daysAgoShort').replace('{n}', String(Math.floor(diffHours / 24)))
      } catch {
        return null
      }
    },
    [t]
  )

  // Filtering pipeline
  // With server-side pagination (fetchPage available), category is already filtered by the API.
  // Skip client-side category filter to avoid double-filtering.
  const categoryFiltered = useMemo(
    () =>
      fetchPage
        ? traders
        : category === 'all'
          ? traders
          : traders.filter((trader) => trader.source && filterByCategory(trader.source, category)),
    [traders, category, fetchPage]
  )

  // With server-side pagination (fetchPage available), exchange is already filtered by the API.
  // Skip client-side exchange filter to avoid double-filtering.
  // No silent "show everything" fallback: a scoped exchange with no rows on
  // this page renders the honest empty state, like presets do.
  const exchangeFiltered = useMemo(() => {
    if (fetchPage || !selectedExchange) return categoryFiltered
    return categoryFiltered.filter((trader) => trader.source === selectedExchange)
  }, [categoryFiltered, selectedExchange, fetchPage])

  // With server paging, presets and advanced filters are API params (the rows
  // already are the filtered cohort); only a client-only list filters here.
  const presetFiltered = useMemo(() => {
    if (fetchPage || !activePreset || activePreset === 'all') return exchangeFiltered
    const presetConfig = PRESETS.find((p) => p.id === activePreset)
    if (!presetConfig) return exchangeFiltered
    // 传完整 trader(2026-07-03 修复):此前只传 { source },low_risk/high_pnl/
    // consistent/top_scorers 四个 metric 预设拿到 undefined 全部 false →
    // 空结果回退放行全部 + 下方 effect 自动清除预设 = 4/8 预设彻底失效。
    // Trader 与 FilterableTrader 字段同名(pnl/win_rate/max_drawdown/arena_score/source)。
    // No silent "show everything" fallback: a preset with zero matches on
    // this page renders the honest empty state (with a reset action) instead
    // of pretending the preset applied. It only ever filters the loaded page.
    return exchangeFiltered.filter((trader) => presetConfig.filter(trader))
  }, [activePreset, exchangeFiltered, fetchPage])

  const advancedFiltered = useMemo(
    () =>
      hasActiveFilters && !fetchPage
        ? applyAdvancedFilter(presetFiltered, filterConfig)
        : presetFiltered,
    [hasActiveFilters, presetFiltered, filterConfig, fetchPage]
  )

  // P1-13: Server-side search fallback when client-side search returns 0 results
  const [serverSearchResults, setServerSearchResults] = useState<Trader[]>([])
  const serverSearchAbortRef = useRef<AbortController | null>(null)
  const lastServerQueryRef = useRef('')

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) {
      setServerSearchResults([])
      lastServerQueryRef.current = ''
      return
    }
    // Same fields RankingTable searches, so "no match on this page" never
    // appears above rows the table is showing.
    const clientMatches = advancedFiltered.filter((t) => {
      const handle = (t.handle || t.id || '').toLowerCase()
      const displayName = (t.display_name || '').toLowerCase()
      return handle.includes(q) || t.id.toLowerCase().includes(q) || displayName.includes(q)
    })
    if (clientMatches.length > 0) {
      if (serverSearchResults.length > 0) setServerSearchResults([])
      return
    }
    if (lastServerQueryRef.current === q) return
    if (serverSearchAbortRef.current) serverSearchAbortRef.current.abort()
    const controller = new AbortController()
    serverSearchAbortRef.current = controller
    const timer = setTimeout(() => {
      lastServerQueryRef.current = q
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          // /api/search answers with the `success()` envelope: { success, data }.
          // Reading `results` off the envelope itself found nothing, so the
          // fallback never showed (audit P2-4).
          const data = json?.data
          if (!data?.results?.traders?.length) {
            setServerSearchResults([])
            return
          }
          const mapped: Trader[] = data.results.traders.map(
            (sr: {
              id: string
              title: string
              avatar?: string | null
              meta?: {
                roi?: number | null
                arena_score?: number | null
                platform?: string
                is_bot?: boolean
              }
            }) => {
              const [platform, ...keyParts] = sr.id.split(':')
              const traderKey = keyParts.join(':')
              return {
                id: traderKey || sr.id,
                handle: sr.title?.replace(/^@/, '') || traderKey || sr.id,
                source: sr.meta?.platform || platform || '',
                roi: sr.meta?.roi ?? null,
                followers: 0,
                arena_score: sr.meta?.arena_score ?? null,
                avatar_url: sr.avatar || null,
                is_bot: sr.meta?.is_bot ?? false,
              } satisfies Trader
            }
          )
          setServerSearchResults(mapped)
        })
        // eslint-disable-next-line no-restricted-syntax
        .catch(() => {
          /* silent best-effort fallback */
        })
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, advancedFiltered])

  // The API returns one server page at a time, so there is nothing to cap.
  const filteredTraders = advancedFiltered

  // Site-wide `/api/search` matches for a query with no match on this page.
  // They carry no published rank for this cohort, so they must never be
  // merged into the ranking table (which only renders persisted ranks — the
  // old merge was silently filtered out). RankingSection lists them as
  // profile links instead.
  const searchMatchesElsewhere = useMemo(() => {
    if (serverSearchResults.length === 0) return []
    if (searchQuery.trim().length < 2) return []
    const existingIds = new Set(filteredTraders.map((t) => t.id))
    return serverSearchResults.filter((t) => !existingIds.has(t.id))
  }, [serverSearchResults, searchQuery, filteredTraders])

  // Pro required handler — show toast instead of redirecting away (jarring UX)
  const handleProRequired = useCallback(() => {
    // paywall_blocked: a free user just hit a Pro-gated affordance.
    // Pairs with view_pricing → click_upgrade_cta → start_checkout → pro_subscribe
    // for a complete funnel from "blocked" to "paid".
    // UI moved to ProUpsellModal in RankingSection (a toast was a dead end —
    // no CTA, no funnel continuation); this handler only tracks.
    trackEvent('paywall_blocked', { source: 'home_ranking_filters' })
  }, [])

  const handleResetFilters = useCallback(() => {
    const commitReset = () => {
      // Commit all labels together only after the matching all-board/score
      // response has landed. This prevents old ROI/exchange rows from being
      // displayed as Score/all rows during a failed reset request.
      if (filterFetchTimerRef.current) clearTimeout(filterFetchTimerRef.current)
      filterFetchTimerRef.current = null
      commitFilterConfig({})
      setShowAdvancedFilter(false)
      setSortColumn('score')
      setSortDir('desc')
      setSelectedExchange(null)
      setActivePreset(null)
      setCategoryRaw('all')
      setCurrentPage(1)
      try {
        localStorage.removeItem(LS_KEY_PRESET)
        localStorage.removeItem(LS_KEY_EXCHANGE)
      } catch {
        /* ignore */
      }
      syncStateToUrl({
        config: {},
        category: null,
        sort: 'score',
        order: 'desc',
        page: 1,
        preset: null,
        ex: null,
      })
    }

    if (fetchPage) {
      void fetchPage(0, {
        category: undefined,
        exchange: undefined,
        sortBy: 'arena_score',
        sortDir: 'desc',
        filters: null,
      }).then((succeeded) => {
        if (succeeded) commitReset()
      })
      return
    }
    commitReset()
  }, [fetchPage, commitFilterConfig, syncStateToUrl])

  const handleFilterToggle = useCallback(() => {
    if (window.matchMedia('(max-width: 768px)').matches) {
      setShowMobileFilter(true)
    } else {
      setShowAdvancedFilter((prev) => !prev)
    }
  }, [])

  return {
    // Language
    language,
    t,
    // Premium
    isPro,
    premiumLoading,
    // Filter state
    category,
    setCategory,
    showAdvancedFilter,
    showMobileFilter,
    setShowMobileFilter,
    filterConfig,
    savedFilters,
    hasActiveFilters,
    hasCohortFilters,
    selectedExchange,
    clearExchange,
    // Sort/page/search
    sortColumn,
    sortDir,
    currentPage: displayedCurrentPage,
    searchQuery,
    // Computed data
    source,
    advancedFiltered,
    filteredTraders,
    searchMatchesElsewhere,
    // Handlers
    handleFilterChange,
    handleSortChange,
    handlePageChange,
    handleSearchChange,
    handleSaveFilter,
    handleLoadFilter,
    handleDeleteFilter,
    handleProRequired,
    handleResetFilters,
    handleFilterToggle,
    formatLastUpdated,
    // Navigation
    router,
  }
}
