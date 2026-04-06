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
import { type PresetId, PRESETS, isValidPresetId } from '../ranking/FilterPresets'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'

// localStorage keys for user preferences
const LS_KEY_SORT_COLUMN = 'ranking-sort-column'
const LS_KEY_SORT_DIR = 'ranking-sort-dir'
const LS_KEY_PRESET = 'ranking-preset'
const LS_KEY_EXCHANGE = 'ranking-exchange'
const LS_KEY_FILTER_CONFIG = 'ranking-filter-config'

// Free users: show up to 1000 traders (beta — showcase platform depth)
export const FREE_LEADERBOARD_LIMIT = 1000

// Helper to get stored preferences
function getStoredPreferences() {
  if (typeof window === 'undefined') return {}
  try {
    let filterConfig: FilterConfig | null = null
    const storedFilterConfig = localStorage.getItem(LS_KEY_FILTER_CONFIG)
    if (storedFilterConfig) {
      try {
        filterConfig = JSON.parse(storedFilterConfig)
      } catch { /* invalid JSON */ }
    }
    return {
      preset: localStorage.getItem(LS_KEY_PRESET) as PresetId | null,
      exchange: localStorage.getItem(LS_KEY_EXCHANGE),
      filterConfig,
    }
  } catch {
    return {}
  }
}

// Client-side advanced filter
function applyAdvancedFilter(list: Trader[], config: FilterConfig): Trader[] {
  return list.filter(trader => {
    if (config.exchange?.length) {
      const src = (trader.source || '').toLowerCase()
      if (!config.exchange.some(ex => src === ex || src.startsWith(ex))) return false
    }
    if (config.roi_min != null && (trader.roi ?? 0) < config.roi_min) return false
    if (config.roi_max != null && (trader.roi ?? 0) > config.roi_max) return false
    if (config.drawdown_min != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) < config.drawdown_min) return false
    if (config.drawdown_max != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) > config.drawdown_max) return false
    if (config.min_pnl != null && (trader.pnl == null || trader.pnl < config.min_pnl)) return false
    if (config.min_score != null && (trader.arena_score == null || trader.arena_score < config.min_score)) return false
    if (config.min_win_rate != null && (trader.win_rate == null || trader.win_rate < config.min_win_rate)) return false
    if (config.grade && trader.arena_score != null) {
      if (getScoreGradeLetter(trader.arena_score) !== config.grade) return false
    }
    return true
  })
}

interface UseRankingFiltersOptions {
  traders: Trader[]
  activeTimeRange: TimeRange
  totalCount?: number
  categoryCounts?: { all: number; futures: number; spot: number; onchain: number }
  fetchPage?: (page: number, opts?: { category?: string; sortBy?: string; sortDir?: string }) => Promise<void>
}

export function useRankingFilters({ traders, activeTimeRange, totalCount, categoryCounts, fetchPage }: UseRankingFiltersOptions) {
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
  const [sortColumn, setSortColumn] = useState<'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha'>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null)

  // Server-side category change: fetch page 0 of the new category
  const setCategory = useCallback((cat: CategoryType) => {
    setCategoryRaw(cat)
    setCurrentPage(1)
    if (fetchPage) {
      const apiCategory = cat === 'web3' ? 'onchain' : cat === 'all' ? undefined : cat
      fetchPage(0, { category: apiCategory })
    }
  }, [fetchPage])

  // Reset pagination when time range changes
  const prevTimeRange = useRef(activeTimeRange)
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
    const exchange = searchParams.get('exchange')
    const fcat = searchParams.get('fcat')

    if (roiMin) config.roi_min = Number(roiMin)
    if (roiMax) config.roi_max = Number(roiMax)
    if (ddMin) config.drawdown_min = Number(ddMin)
    if (ddMax) config.drawdown_max = Number(ddMax)
    if (minPnl) config.min_pnl = Number(minPnl)
    if (minScore) config.min_score = Number(minScore)
    if (minWr) config.min_win_rate = Number(minWr)
    if (exchange) config.exchange = exchange.split(',')
    if (fcat) config.category = fcat.split(',')

    const storedPrefs = getStoredPreferences()

    if (Object.keys(config).length > 0) {
      setFilterConfig(config)
      setShowAdvancedFilter(true)
    } else if (storedPrefs.filterConfig && Object.keys(storedPrefs.filterConfig).length > 0) {
      setFilterConfig(storedPrefs.filterConfig)
      setShowAdvancedFilter(true)
    }

    try {
      localStorage.removeItem(LS_KEY_SORT_COLUMN)
      localStorage.removeItem(LS_KEY_SORT_DIR)
    } catch { /* ignore */ }

    const urlSort = searchParams.get('sort') as typeof sortColumn | null
    const urlOrder = searchParams.get('order') as 'asc' | 'desc' | null
    const urlPage = searchParams.get('page')
    const urlQ = searchParams.get('q')
    const urlPreset = searchParams.get('preset') as PresetId | null
    const urlEx = searchParams.get('ex')

    if (urlSort && ['score', 'roi', 'pnl', 'winrate', 'mdd'].includes(urlSort)) {
      setSortColumn(urlSort)
    }
    if (urlOrder && ['asc', 'desc'].includes(urlOrder)) {
      setSortDir(urlOrder)
    }
    if (urlPage) setCurrentPage(Math.max(1, parseInt(urlPage, 10) || 1))
    if (urlQ) setSearchQuery(urlQ)

    if (urlPreset && isValidPresetId(urlPreset)) {
      setActivePreset(urlPreset)
    } else if (isValidPresetId(storedPrefs.preset)) {
      setActivePreset(storedPrefs.preset)
    }

    if (urlEx) {
      setSelectedExchange(urlEx)
    } else if (storedPrefs.exchange) {
      setSelectedExchange(storedPrefs.exchange)
    }
  }, [])

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
  const stateRef = useRef({ filterConfig, sortColumn, sortDir, currentPage, searchQuery, activePreset, selectedExchange })
  useEffect(() => {
    stateRef.current = { filterConfig, sortColumn, sortDir, currentPage, searchQuery, activePreset, selectedExchange }
  })

  // Sync state to URL (debounced) — stable reference, reads from stateRef
  const syncStateToUrl = useCallback((overrides: {
    config?: FilterConfig
    sort?: string
    order?: string
    page?: number
    q?: string
    preset?: string | null
    ex?: string | null
  } = {}) => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current)
    }
    syncTimeoutRef.current = setTimeout(() => {
      const s = stateRef.current
      const params = new URLSearchParams(window.location.search)
      const config = overrides.config ?? s.filterConfig

      ;['roi_min', 'roi_max', 'dd_min', 'dd_max', 'min_pnl', 'min_score', 'min_wr', 'exchange', 'fcat', 'sort', 'order', 'page', 'q', 'preset', 'ex'].forEach(k => params.delete(k))

      if (config.roi_min != null) params.set('roi_min', String(config.roi_min))
      if (config.roi_max != null) params.set('roi_max', String(config.roi_max))
      if (config.drawdown_min != null) params.set('dd_min', String(config.drawdown_min))
      if (config.drawdown_max != null) params.set('dd_max', String(config.drawdown_max))
      if (config.min_pnl != null) params.set('min_pnl', String(config.min_pnl))
      if (config.min_score != null) params.set('min_score', String(config.min_score))
      if (config.min_win_rate != null) params.set('min_wr', String(config.min_win_rate))
      if (config.exchange?.length) params.set('exchange', config.exchange.join(','))
      if (config.category?.length) params.set('fcat', config.category.join(','))

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
  }, []) // Stable — never recreates, reads current state from stateRef

  const syncFilterToUrl = useCallback((config: FilterConfig) => {
    syncStateToUrl({ config })
  }, [syncStateToUrl])

  // Filter change handler
  const handleFilterChange = useCallback((config: FilterConfig) => {
    setFilterConfig(config)
    syncFilterToUrl(config)
    try {
      if (Object.keys(config).length > 0) {
        localStorage.setItem(LS_KEY_FILTER_CONFIG, JSON.stringify(config))
      } else {
        localStorage.removeItem(LS_KEY_FILTER_CONFIG)
      }
    } catch { /* ignore */ }
  }, [syncFilterToUrl])

  // Sort/page/search handlers — trigger server-side fetch when fetchPage is available
  const handleSortChange = useCallback((col: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha', dir: 'asc' | 'desc') => {
    setSortColumn(col)
    setSortDir(dir)
    setCurrentPage(1)
    syncStateToUrl({ sort: col, order: dir, page: 1 })
    if (fetchPage) {
      const sortByMap: Record<string, string> = { score: 'arena_score', roi: 'roi', pnl: 'pnl', winrate: 'win_rate', mdd: 'max_drawdown' }
      const apiCategory = category === 'web3' ? 'onchain' : category === 'all' ? undefined : category
      fetchPage(0, { category: apiCategory, sortBy: sortByMap[col] || 'arena_score', sortDir: dir })
    }
  }, [syncStateToUrl, fetchPage, category])

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
    syncStateToUrl({ page })
    if (fetchPage) {
      const sortByMap: Record<string, string> = { score: 'arena_score', roi: 'roi', pnl: 'pnl', winrate: 'win_rate', mdd: 'max_drawdown' }
      const apiCategory = category === 'web3' ? 'onchain' : category === 'all' ? undefined : category
      fetchPage(page - 1, { category: apiCategory, sortBy: sortByMap[sortColumn] || 'arena_score', sortDir: sortDir })
    }
  }, [syncStateToUrl, fetchPage, category, sortColumn, sortDir])

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q)
    setCurrentPage(1)
    syncStateToUrl({ q, page: 1 })
  }, [syncStateToUrl])

  // Preset change handler
  const _handlePresetChange = useCallback((preset: PresetId | null) => {
    setActivePreset(preset)
    setCurrentPage(1)
    syncStateToUrl({ preset, page: 1 })
    try {
      if (preset) {
        localStorage.setItem(LS_KEY_PRESET, preset)
      } else {
        localStorage.removeItem(LS_KEY_PRESET)
      }
    } catch { /* ignore */ }
  }, [syncStateToUrl])

  // Exchange filter change handler
  const _handleExchangeChange = useCallback((exchange: string | null) => {
    setSelectedExchange(exchange)
    setCurrentPage(1)
    syncStateToUrl({ ex: exchange, page: 1 })
    try {
      if (exchange) {
        localStorage.setItem(LS_KEY_EXCHANGE, exchange)
      } else {
        localStorage.removeItem(LS_KEY_EXCHANGE)
      }
    } catch { /* ignore */ }
  }, [syncStateToUrl])

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
        setSavedFilters(prev => [...prev, data.filter])
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
        setSavedFilters(prev => prev.filter(f => f.id !== filterId))
        showToast(t('deleted'), 'success')
      } else {
        showToast(t('deleteFailed'), 'error')
      }
    } catch {
      showToast(t('deleteFailed'), 'error')
    }
  }

  // Check for active filters
  const hasActiveFilters = Object.keys(filterConfig).some(key => {
    const value = filterConfig[key as keyof FilterConfig]
    if (Array.isArray(value)) return value.length > 0
    return value != null
  })

  const source = traders.length > 0 ? traders[0].source : 'all'

  // Format last updated time
  const formatLastUpdated = useCallback((dateStr: string | null | undefined) => {
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
  }, [t])

  // Filtering pipeline
  // With server-side pagination (fetchPage available), category is already filtered by the API.
  // Skip client-side category filter to avoid double-filtering.
  const categoryFiltered = useMemo(
    () => fetchPage
      ? traders
      : (category === 'all'
        ? traders
        : traders.filter(trader => trader.source && filterByCategory(trader.source, category))),
    [traders, category, fetchPage]
  )

  const exchangeFiltered = useMemo(() => {
    const raw = selectedExchange
      ? categoryFiltered.filter(trader => trader.source === selectedExchange)
      : categoryFiltered
    return (selectedExchange && raw.length === 0 && categoryFiltered.length > 0)
      ? categoryFiltered
      : raw
  }, [categoryFiltered, selectedExchange])

  // Auto-clear exchange filter when no traders match (avoids stale filter)
  // NOTE: syncStateToUrl intentionally excluded from deps to prevent infinite loop
  // (calling syncStateToUrl changes its deps → recreates → re-triggers this effect)
  useEffect(() => {
    if (selectedExchange && categoryFiltered.length > 0) {
      const hasMatch = categoryFiltered.some(trader => trader.source === selectedExchange)
      if (!hasMatch) {
        setSelectedExchange(null)
        try { localStorage.removeItem(LS_KEY_EXCHANGE) } catch { /* ignore */ }
      }
    }
  }, [selectedExchange, categoryFiltered])

  const presetFiltered = useMemo(() => {
    if (!activePreset || activePreset === 'all') return exchangeFiltered
    const presetConfig = PRESETS.find(p => p.id === activePreset)
    if (!presetConfig) return exchangeFiltered
    const raw = exchangeFiltered.filter(trader => presetConfig.filter({ source: trader.source }))
    return (raw.length === 0 && exchangeFiltered.length > 0) ? exchangeFiltered : raw
  }, [activePreset, exchangeFiltered])

  // Auto-clear preset filter when no traders match
  // NOTE: syncStateToUrl intentionally excluded from deps to prevent infinite loop
  useEffect(() => {
    if (activePreset && activePreset !== 'all' && exchangeFiltered.length > 0) {
      const presetConfig = PRESETS.find(p => p.id === activePreset)
      if (presetConfig) {
        const hasMatch = exchangeFiltered.some(trader => presetConfig.filter({ source: trader.source }))
        if (!hasMatch) {
          setActivePreset(null)
          try { localStorage.removeItem(LS_KEY_PRESET) } catch { /* ignore */ }
        }
      }
    }
  }, [activePreset, exchangeFiltered])

  const advancedFiltered = useMemo(
    () => hasActiveFilters ? applyAdvancedFilter(presetFiltered, filterConfig) : presetFiltered,
    [hasActiveFilters, presetFiltered, filterConfig]
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
    const clientMatches = advancedFiltered.filter(t => {
      const handle = (t.handle || t.id || '').toLowerCase()
      return handle.includes(q) || t.id.toLowerCase().includes(q)
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
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data?.results?.traders?.length) {
            setServerSearchResults([])
            return
          }
          const mapped: Trader[] = data.results.traders.map((sr: {
            id: string; title: string; avatar?: string | null
            meta?: { roi?: number; arena_score?: number; platform?: string; is_bot?: boolean }
          }) => {
            const [platform, ...keyParts] = sr.id.split(':')
            const traderKey = keyParts.join(':')
            return {
              id: traderKey || sr.id,
              handle: sr.title?.replace(/^@/, '') || traderKey || sr.id,
              source: sr.meta?.platform || platform || '',
              roi: sr.meta?.roi ?? 0,
              followers: 0,
              arena_score: sr.meta?.arena_score ?? undefined,
              avatar_url: sr.avatar || null,
              is_bot: sr.meta?.is_bot ?? false,
            } satisfies Trader
          })
          setServerSearchResults(mapped)
        })
        .catch(() => { /* silent best-effort fallback */ }) // eslint-disable-line no-restricted-syntax -- fire-and-forget
    }, 400)
    return () => { clearTimeout(timer); controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, advancedFiltered])

  const filteredTraders = useMemo(() => {
    // With server-side pagination, the API returns one page at a time — no need to slice
    const base = fetchPage ? advancedFiltered : (isPro ? advancedFiltered : advancedFiltered.slice(0, FREE_LEADERBOARD_LIMIT))
    if (serverSearchResults.length === 0) return base
    const q = searchQuery.trim().toLowerCase()
    if (q.length < 2) return base
    const clientMatches = base.filter(t => {
      const handle = (t.handle || t.id || '').toLowerCase()
      return handle.includes(q) || t.id.toLowerCase().includes(q)
    })
    if (clientMatches.length > 0) return base
    const existingIds = new Set(base.map(t => t.id))
    const newResults = serverSearchResults.filter(t => !existingIds.has(t.id))
    return [...base, ...newResults]
  }, [isPro, advancedFiltered, serverSearchResults, searchQuery])

  // Pro required handler
  const handleProRequired = useCallback(() => {
    showToast(t('proRequired'), 'info')
    router.push('/pricing')
  }, [showToast, t, router])

  const handleCopyLink = useCallback(() => {
    const url = window.location.href
    navigator.clipboard.writeText(url).then(() => {
      showToast(t('linkCopied') || 'Link copied!', 'success')
    }).catch(() => {
      showToast(t('copyFailed') || 'Copy failed', 'error')
    })
  }, [showToast, t])

  const handleResetFilters = useCallback(() => {
    handleFilterChange({})
    setShowAdvancedFilter(false)
    setSortColumn('score')
    setSortDir('desc')
    setSelectedExchange(null)
    setActivePreset(null)
    setCategory('all')
  }, [handleFilterChange])

  const handleFilterToggle = useCallback(() => {
    if (window.matchMedia('(max-width: 768px)').matches) {
      setShowMobileFilter(true)
    } else {
      setShowAdvancedFilter(prev => !prev)
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
    selectedExchange,
    // Sort/page/search
    sortColumn,
    sortDir,
    currentPage,
    searchQuery,
    // Computed data
    source,
    advancedFiltered,
    filteredTraders,
    // Handlers
    handleFilterChange,
    handleSortChange,
    handlePageChange,
    handleSearchChange,
    handleSaveFilter,
    handleLoadFilter,
    handleDeleteFilter,
    handleProRequired,
    handleCopyLink,
    handleResetFilters,
    handleFilterToggle,
    formatLastUpdated,
    // Navigation
    router,
  }
}
