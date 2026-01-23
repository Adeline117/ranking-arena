'use client'

/**
 * Hook for fetching from the new /api/rankings endpoint
 * Maps v2 response format to the existing Trader interface for RankingTable compatibility
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { Trader } from '../../ranking/RankingTable'

export type WindowV2 = '90d' | '30d' | '7d'
export type TimeRangeV2 = '90D' | '30D' | '7D'

// Convert display format to API format
function toApiWindow(timeRange: TimeRangeV2): WindowV2 {
  return timeRange.toLowerCase() as WindowV2
}

interface RankingsMeta {
  total: number
  window: string
  platform: string
  market_type: string
  sort: string
  updated_at: string
  staleness: boolean
  query_ms: number
}

interface RankingsV2Response {
  data: RankingEntryV2[]
  meta: RankingsMeta
}

interface RankingEntryV2 {
  rank: number
  platform: string
  market_type: string
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  profile_url: string | null
  roi_pct: number | null
  pnl_usd: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  arena_score: number | null
  updated_at: string
  staleness: boolean
  quality_flags: Record<string, unknown>
  provenance: Record<string, unknown>
}

interface CachedData {
  traders: Trader[]
  meta: RankingsMeta | null
  lastUpdated: string | null
}

export interface UseRankingsV2Options {
  autoRefreshInterval?: number
  platform?: string
  market_type?: string
  sort?: string
  limit?: number
  enabled?: boolean // Set to false to disable (for feature flag)
}

/**
 * Maps a v2 ranking entry to the existing Trader interface
 */
function mapToTrader(entry: RankingEntryV2): Trader {
  return {
    id: `${entry.platform}:${entry.market_type}:${entry.trader_key}`,
    handle: entry.display_name || entry.trader_key,
    roi: entry.roi_pct ?? 0,
    pnl: entry.pnl_usd,
    win_rate: entry.win_rate,
    max_drawdown: entry.max_drawdown,
    trades_count: entry.trades_count,
    followers: entry.followers ?? 0,
    source: entry.platform === 'binance'
      ? (entry.market_type === 'spot' ? 'binance_spot' : entry.market_type === 'web3' ? 'binance_web3' : 'binance_futures')
      : entry.market_type === 'spot'
        ? `${entry.platform}_spot`
        : entry.platform,
    avatar_url: entry.avatar_url,
    arena_score: entry.arena_score ?? undefined,
  }
}

export function useRankingsV2(options: UseRankingsV2Options = {}) {
  const {
    autoRefreshInterval = 10 * 60 * 1000,
    platform = 'all',
    market_type = 'all',
    sort = 'roi_desc',
    limit = 100,
    enabled = true,
  } = options

  const cache = useRef<Map<string, CachedData>>(new Map())
  const [currentTraders, setCurrentTraders] = useState<Trader[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [meta, setMeta] = useState<RankingsMeta | null>(null)
  const [activeTimeRange, setActiveTimeRange] = useState<TimeRangeV2>('90D')

  const fetchRankings = useCallback(async (timeRange: TimeRangeV2, forceRefresh = false): Promise<CachedData> => {
    const cacheKey = `${toApiWindow(timeRange)}_${platform}_${market_type}_${sort}`

    if (!forceRefresh && cache.current.has(cacheKey)) {
      return cache.current.get(cacheKey)!
    }

    const params = new URLSearchParams({
      window: toApiWindow(timeRange),
      platform,
      market_type,
      sort,
      limit: String(limit),
    })

    const response = await fetch(`/api/rankings?${params.toString()}`)
    if (!response.ok) {
      throw new Error(`Rankings fetch failed (${response.status})`)
    }

    const data: RankingsV2Response = await response.json()
    const traders = data.data.map(mapToTrader)

    const cached: CachedData = {
      traders,
      meta: data.meta,
      lastUpdated: data.meta.updated_at,
    }

    cache.current.set(cacheKey, cached)
    return cached
  }, [platform, market_type, sort, limit])

  const loadTimeRange = useCallback(async (timeRange: TimeRangeV2, forceRefresh = false) => {
    if (!enabled) return

    setLoading(true)
    setError(null)

    try {
      const result = await fetchRankings(timeRange, forceRefresh)
      setCurrentTraders(result.traders)
      setLastUpdated(result.lastUpdated)
      setMeta(result.meta)
    } catch (err) {
      const msg = (err as Error).message || 'Failed to load rankings'
      setError(msg)
      // Try to use cached data
      const cacheKey = `${toApiWindow(timeRange)}_${platform}_${market_type}_${sort}`
      const cached = cache.current.get(cacheKey)
      if (cached) {
        setCurrentTraders(cached.traders)
        setLastUpdated(cached.lastUpdated)
      }
    } finally {
      setLoading(false)
    }
  }, [enabled, fetchRankings, platform, market_type, sort])

  // Initial load
  useEffect(() => {
    if (enabled) {
      loadTimeRange(activeTimeRange)
    }
  }, [enabled, activeTimeRange, loadTimeRange])

  // Auto refresh
  useEffect(() => {
    if (!enabled || autoRefreshInterval <= 0) return
    const timer = setInterval(() => {
      loadTimeRange(activeTimeRange, true)
    }, autoRefreshInterval)
    return () => clearInterval(timer)
  }, [enabled, autoRefreshInterval, activeTimeRange, loadTimeRange])

  const changeTimeRange = useCallback((timeRange: TimeRangeV2) => {
    setActiveTimeRange(timeRange)
    if (typeof window !== 'undefined') {
      localStorage.setItem('ranking_time_range_v2', timeRange)
    }
  }, [])

  const refresh = useCallback(() => {
    loadTimeRange(activeTimeRange, true)
  }, [activeTimeRange, loadTimeRange])

  return {
    traders: currentTraders,
    loading,
    error,
    activeTimeRange,
    lastUpdated,
    meta,
    changeTimeRange,
    refresh,
    clearCache: () => cache.current.clear(),
  }
}
