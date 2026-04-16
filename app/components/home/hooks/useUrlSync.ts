'use client'

/**
 * useUrlSync — bidirectional URL ↔ state synchronization for ranking filters.
 *
 * Extracted from useRankingFilters to isolate URL management concerns.
 * Handles reading initial state from URL params and writing state changes back.
 */

import { useCallback, useRef, useEffect } from 'react'
import type { FilterConfig } from '../../premium/AdvancedFilter'
import { isValidPresetId, type PresetId } from '../../ranking/FilterPresets'

// localStorage keys for user preferences
const LS_KEY_PRESET = 'ranking-preset'
const LS_KEY_EXCHANGE = 'ranking-exchange'
const LS_KEY_FILTER_CONFIG = 'ranking-filter-config'

export interface UrlState {
  filterConfig: FilterConfig
  sortColumn: string
  sortDir: string
  currentPage: number
  searchQuery: string
  activePreset: PresetId | null
  selectedExchange: string | null
}

/** Parse initial state from URL params + localStorage */
export function getInitialStateFromUrl(): Partial<UrlState> {
  if (typeof window === 'undefined') return {}

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

  // Get stored preferences from localStorage
  let storedPreset: PresetId | null = null
  let storedExchange: string | null = null
  let storedFilterConfig: FilterConfig | null = null
  try {
    const sp = localStorage.getItem(LS_KEY_PRESET) as PresetId | null
    storedExchange = localStorage.getItem(LS_KEY_EXCHANGE)
    const sfc = localStorage.getItem(LS_KEY_FILTER_CONFIG)
    if (sfc) { try { storedFilterConfig = JSON.parse(sfc) } catch { /* invalid JSON */ } }
    if (isValidPresetId(sp)) storedPreset = sp
  } catch { /* ignore */ }

  const result: Partial<UrlState> = {}

  if (Object.keys(config).length > 0) {
    result.filterConfig = config
  } else if (storedFilterConfig && Object.keys(storedFilterConfig).length > 0) {
    result.filterConfig = storedFilterConfig
  }

  const urlSort = searchParams.get('sort')
  const urlOrder = searchParams.get('order')
  const urlPage = searchParams.get('page')
  const urlQ = searchParams.get('q')
  const urlPreset = searchParams.get('preset') as PresetId | null
  const urlEx = searchParams.get('ex')

  if (urlSort && ['score', 'roi', 'pnl', 'winrate', 'mdd'].includes(urlSort)) {
    result.sortColumn = urlSort
  }
  if (urlOrder && ['asc', 'desc'].includes(urlOrder)) {
    result.sortDir = urlOrder
  }
  if (urlPage) result.currentPage = Math.max(1, parseInt(urlPage, 10) || 1)
  if (urlQ) result.searchQuery = urlQ
  if (urlPreset && isValidPresetId(urlPreset)) {
    result.activePreset = urlPreset
  } else if (storedPreset) {
    result.activePreset = storedPreset
  }
  if (urlEx) {
    result.selectedExchange = urlEx
  } else if (storedExchange) {
    result.selectedExchange = storedExchange
  }

  return result
}

/**
 * Hook to sync ranking filter state to URL (debounced).
 * Returns a stable syncStateToUrl function that reads current state from a ref.
 */
export function useUrlSync(stateRef: React.MutableRefObject<UrlState>) {
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    }
  }, [])

  const syncStateToUrl = useCallback((overrides: Partial<UrlState & { config?: FilterConfig }> = {}) => {
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      const s = stateRef.current
      const params = new URLSearchParams(window.location.search)
      const config = overrides.config ?? overrides.filterConfig ?? s.filterConfig

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

      const sort = overrides.sortColumn ?? s.sortColumn
      const order = overrides.sortDir ?? s.sortDir
      const page = overrides.currentPage ?? s.currentPage
      const q = overrides.searchQuery ?? s.searchQuery
      const preset = overrides.activePreset !== undefined ? overrides.activePreset : s.activePreset
      const ex = overrides.selectedExchange !== undefined ? overrides.selectedExchange : s.selectedExchange

      if (sort && sort !== 'score') params.set('sort', sort)
      if (order && order !== 'desc') params.set('order', order)
      if (page && page > 1) params.set('page', String(page))
      if (q) params.set('q', q)
      if (preset) params.set('preset', preset)
      if (ex) params.set('ex', ex)

      const qs = params.toString()
      const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
      window.history.replaceState(null, '', newUrl)
    }, 300)
  }, [stateRef])

  return syncStateToUrl
}
