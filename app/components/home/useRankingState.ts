'use client'

import { useState, useEffect, useCallback, useRef, useTransition, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '../ui/Toast'
import { useSubscription } from './hooks/useSubscription'
import { useLanguage } from '../Providers/LanguageProvider'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'
import { getScoreGradeLetter } from '@/lib/utils/score-explain'
import { type PresetId, PRESETS, isValidPresetId } from '../ranking/FilterPresets'
import { type CategoryType, filterByCategory } from '../ranking/CategoryRankingTabs'
import type { FilterConfig, SavedFilter } from '../premium/AdvancedFilter'
import type { Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'

// localStorage keys for user preferences
const LS_KEY_SORT_COLUMN = 'ranking-sort-column'
const LS_KEY_SORT_DIR = 'ranking-sort-dir'
const LS_KEY_PRESET = 'ranking-preset'
const LS_KEY_EXCHANGE = 'ranking-exchange'
const LS_KEY_FILTER_CONFIG = 'ranking-filter-config'

/** Free users see at most this many traders */
export const FREE_LEADERBOARD_LIMIT = 100

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
      // Sort column/dir intentionally NOT restored from localStorage — always default to 'score' desc
      preset: localStorage.getItem(LS_KEY_PRESET) as PresetId | null,
      exchange: localStorage.getItem(LS_KEY_EXCHANGE),
      filterConfig,
    }
  } catch {
    return {}
  }
}

// Client-side advanced filter function
function applyAdvancedFilter(list: Trader[], config: FilterConfig): Trader[] {
  return list.filter(trader => {
    // Exchange filter
    if (config.exchange?.length) {
      const src = (trader.source || '').toLowerCase()
      if (!config.exchange.some(ex => src === ex || src.startsWith(ex))) return false
    }
    // ROI range
    if (config.roi_min != null && (trader.roi || 0) < config.roi_min) return false
    if (config.roi_max != null && (trader.roi || 0) > config.roi_max) return false
    // Drawdown range
    if (config.drawdown_min != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) < config.drawdown_min) return false
    if (config.drawdown_max != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) > config.drawdown_max) return false
    // Min PnL
    if (config.min_pnl != null && (trader.pnl == null || trader.pnl < config.min_pnl)) return false
    // Min Arena Score
    if (config.min_score != null && (trader.arena_score == null || trader.arena_score < config.min_score)) return false
    // Min win rate
    if (config.min_win_rate != null && (trader.win_rate == null || trader.win_rate < config.min_win_rate)) return false
    // Grade filter
    if (config.grade && trader.arena_score != null) {
      if (getScoreGradeLetter(trader.arena_score) !== config.grade) return false
    }
    return true
  })
}

interface UseRankingStateOptions {
  traders: Trader[]
  loading: boolean
  activeTimeRange: TimeRange
  availableSources?: string[]
}

export function useRankingState({ traders, loading: _loading, activeTimeRange, availableSources: _availableSources }: UseRankingStateOptions) {
  const router = useRouter()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { isFeaturesUnlocked, isLoading: premiumLoading } = useSubscription()
  const isPro = isFeaturesUnlocked
  const { getAuthHeaders } = useAuthSession()

  // Category state
  const [category, setCategory] = useState<CategoryType>('all')

  // Advanced filter state
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [filterConfig, setFilterConfig] = useState<FilterConfig>({})
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])

  // Filter presets
  const [activePreset, setActivePreset] = useState<PresetId | null>(null)

  // Lifted sort/page/search state for URL sync
  const [sortColumn, setSortColumn] = useState<'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha'>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null)

  // Reset pagination when time range changes
  const prevTimeRange = useRef(activeTimeRange)
  useEffect(() => {
    if (prevTimeRange.current !== activeTimeRange) {
      setCurrentPage(1)
      prevTimeRange.current = activeTimeRange
    }
  }, [activeTimeRange])

  // Restore filter state from URL + localStorage fallback
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

    // Clear stale sort prefs
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
  const [, startTransition] = useTransition()

  // Sync all state to URL via replaceState (debounced)
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
      startTransition(() => {
      const params = new URLSearchParams(window.location.search)
      const config = overrides.config ?? filterConfig

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

      const sort = overrides.sort ?? sortColumn
      const order = overrides.order ?? sortDir
      const page = overrides.page ?? currentPage
      const q = overrides.q ?? searchQuery
      const preset = overrides.preset !== undefined ? overrides.preset : activePreset

      if (sort && sort !== 'score') params.set('sort', sort)
      if (order && order !== 'desc') params.set('order', order)
      if (page && page > 1) params.set('page', String(page))
      if (q) params.set('q', q)
      if (preset) params.set('preset', preset)

      const ex = overrides.ex !== undefined ? overrides.ex : selectedExchange
      if (ex) params.set('ex', ex)

        const qs = params.toString()
        const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
        window.history.replaceState(null, '', newUrl)
      })
    }, 300)
  }, [filterConfig, sortColumn, sortDir, currentPage, searchQuery, activePreset, selectedExchange])

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

  // Sort change (NOT persisted to localStorage)
  const handleSortChange = useCallback((col: 'score' | 'roi' | 'pnl' | 'winrate' | 'mdd' | 'sortino' | 'alpha', dir: 'asc' | 'desc') => {
    setSortColumn(col)
    setSortDir(dir)
    setCurrentPage(1)
    syncStateToUrl({ sort: col, order: dir, page: 1 })
  }, [syncStateToUrl])

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
    syncStateToUrl({ page })
  }, [syncStateToUrl])

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q)
    setCurrentPage(1)
    syncStateToUrl({ q, page: 1 })
  }, [syncStateToUrl])

  // Preset change with localStorage persistence
  const handlePresetChange = useCallback((preset: PresetId | null) => {
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

  // Exchange filter change with localStorage persistence
  const handleExchangeChange = useCallback((exchange: string | null) => {
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

  // Check if any filters are active
  const hasActiveFilters = Object.keys(filterConfig).some(key => {
    const value = filterConfig[key as keyof FilterConfig]
    if (Array.isArray(value)) return value.length > 0
    return value != null
  })

  const source = traders.length > 0 ? traders[0].source : 'all'

  // Category filtering
  const categoryFiltered = useMemo(
    () => category === 'all'
      ? traders
      : traders.filter(trader => trader.source && filterByCategory(trader.source, category)),
    [traders, category]
  )

  // Exchange filtering (with stale fallback)
  const exchangeFiltered = useMemo(() => {
    const raw = selectedExchange
      ? categoryFiltered.filter(trader => trader.source === selectedExchange)
      : categoryFiltered
    return (selectedExchange && raw.length === 0 && categoryFiltered.length > 0)
      ? categoryFiltered
      : raw
  }, [categoryFiltered, selectedExchange])

  // Auto-reset stale exchange in localStorage
  useEffect(() => {
    if (selectedExchange && categoryFiltered.length > 0) {
      const hasMatch = categoryFiltered.some(trader => trader.source === selectedExchange)
      if (!hasMatch) {
        setSelectedExchange(null)
        try { localStorage.removeItem(LS_KEY_EXCHANGE) } catch { /* ignore */ }
        syncStateToUrl({ ex: null })
      }
    }
  }, [selectedExchange, categoryFiltered, syncStateToUrl])

  // Preset filtering (with stale fallback)
  const presetFiltered = useMemo(() => {
    if (!activePreset || activePreset === 'all') return exchangeFiltered
    const presetConfig = PRESETS.find(p => p.id === activePreset)
    if (!presetConfig) return exchangeFiltered
    const raw = exchangeFiltered.filter(trader => presetConfig.filter({ source: trader.source }))
    return (raw.length === 0 && exchangeFiltered.length > 0) ? exchangeFiltered : raw
  }, [activePreset, exchangeFiltered])

  // Auto-reset stale preset in localStorage
  useEffect(() => {
    if (activePreset && activePreset !== 'all' && exchangeFiltered.length > 0) {
      const presetConfig = PRESETS.find(p => p.id === activePreset)
      if (presetConfig) {
        const hasMatch = exchangeFiltered.some(trader => presetConfig.filter({ source: trader.source }))
        if (!hasMatch) {
          setActivePreset(null)
          try { localStorage.removeItem(LS_KEY_PRESET) } catch { /* ignore */ }
          syncStateToUrl({ preset: null })
        }
      }
    }
  }, [activePreset, exchangeFiltered, syncStateToUrl])

  const advancedFiltered = useMemo(
    () => hasActiveFilters ? applyAdvancedFilter(presetFiltered, filterConfig) : presetFiltered,
    [hasActiveFilters, presetFiltered, filterConfig]
  )

  // Free users: limit to top 100; Pro users: full leaderboard
  const filteredTraders = useMemo(
    () => isPro ? advancedFiltered : advancedFiltered.slice(0, FREE_LEADERBOARD_LIMIT),
    [isPro, advancedFiltered]
  )

  // Pro feature prompt
  const handleProRequired = () => {
    showToast(t('proRequired'), 'info')
    router.push('/pricing')
  }

  // Format last updated time
  const formatLastUpdated = (dateStr: string | null | undefined) => {
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
  }

  return {
    // State
    category,
    setCategory,
    showAdvancedFilter,
    setShowAdvancedFilter,
    filterConfig,
    savedFilters,
    activePreset,
    sortColumn,
    sortDir,
    currentPage,
    searchQuery,
    selectedExchange,
    setSelectedExchange,
    isPro,
    premiumLoading,
    language,
    t,

    // Derived
    source,
    hasActiveFilters,
    categoryFiltered,
    advancedFiltered,
    filteredTraders,

    // Handlers
    handleFilterChange,
    handleSortChange,
    handlePageChange,
    handleSearchChange,
    handlePresetChange,
    handleExchangeChange,
    handleSaveFilter,
    handleLoadFilter,
    handleDeleteFilter,
    handleProRequired,
    syncStateToUrl,
    formatLastUpdated,
  }
}
