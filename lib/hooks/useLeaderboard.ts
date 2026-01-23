/**
 * SWR hooks for the multi-platform leaderboard system.
 *
 * Provides:
 * - useRankings: Fetches ranked traders with filters
 * - useTraderDetail: Fetches trader detail (profile + snapshots + timeseries)
 * - useTraderRefresh: Triggers a background refresh for a trader
 */

'use client'

import useSWR from 'swr'
import useSWRMutation from 'swr/mutation'
import type {
  RankingsQuery,
  RankingsResponse,
  TraderDetailResponse,
  RefreshResponse,
  RankingWindow,
  TradingCategory,
  Platform,
} from '@/lib/types/leaderboard'

// ============================================
// Fetcher
// ============================================

async function fetcher<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }
  return response.json()
}

async function postFetcher<T>(url: string, { arg }: { arg?: Record<string, unknown> }): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: arg ? JSON.stringify(arg) : undefined,
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(error.error || `HTTP ${response.status}`)
  }
  return response.json()
}

// ============================================
// URL Builder
// ============================================

function buildRankingsUrl(params: Partial<RankingsQuery>): string | null {
  if (!params.window) return null

  const searchParams = new URLSearchParams()
  searchParams.set('window', params.window)

  if (params.category) searchParams.set('category', params.category)
  if (params.platform) searchParams.set('platform', params.platform)
  if (params.limit) searchParams.set('limit', String(params.limit))
  if (params.offset) searchParams.set('offset', String(params.offset))
  if (params.sort_by) searchParams.set('sort_by', params.sort_by)
  if (params.sort_dir) searchParams.set('sort_dir', params.sort_dir)
  if (params.min_pnl) searchParams.set('min_pnl', String(params.min_pnl))
  if (params.min_trades) searchParams.set('min_trades', String(params.min_trades))

  return `/api/rankings?${searchParams.toString()}`
}

// ============================================
// Hooks
// ============================================

export interface UseRankingsOptions {
  window: RankingWindow
  category?: TradingCategory
  platform?: Platform
  limit?: number
  offset?: number
  sortBy?: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers'
  sortDir?: 'asc' | 'desc'
  minPnl?: number
  minTrades?: number
  /** SWR refresh interval in ms (default: 60000) */
  refreshInterval?: number
}

/**
 * Fetch ranked traders with filters.
 * Auto-refreshes every 60 seconds by default.
 */
export function useRankings(options: UseRankingsOptions) {
  const {
    window,
    category,
    platform,
    limit = 100,
    offset = 0,
    sortBy = 'arena_score',
    sortDir = 'desc',
    minPnl,
    minTrades,
    refreshInterval = 60_000,
  } = options

  const url = buildRankingsUrl({
    window,
    category,
    platform,
    limit,
    offset,
    sort_by: sortBy,
    sort_dir: sortDir,
    min_pnl: minPnl,
    min_trades: minTrades,
  })

  const { data, error, isLoading, isValidating, mutate } = useSWR<RankingsResponse>(
    url,
    fetcher,
    {
      refreshInterval,
      revalidateOnFocus: false,
      dedupingInterval: 10_000,
    },
  )

  return {
    rankings: data?.traders ?? [],
    meta: data?.meta ?? null,
    totalCount: data?.meta?.total_count ?? 0,
    isLoading,
    isValidating,
    error: error?.message ?? null,
    refresh: mutate,
  }
}

/**
 * Fetch full trader detail by composite ID (platform:trader_key).
 * Cached for 5 minutes, auto-refreshes every 5 minutes.
 */
export function useTraderDetail(traderId: string | null) {
  const url = traderId ? `/api/trader/${encodeURIComponent(traderId)}` : null

  const { data, error, isLoading, mutate } = useSWR<TraderDetailResponse>(
    url,
    fetcher,
    {
      refreshInterval: 5 * 60_000,
      revalidateOnFocus: false,
      dedupingInterval: 30_000,
    },
  )

  return {
    identity: data?.profile ?? null,
    profile: data?.profile ?? null,
    snapshots: data?.snapshots ?? { '7d': null, '30d': null, '90d': null },
    timeseries: data?.timeseries ?? [],
    freshness: data?.data_freshness ?? null,
    isLoading,
    error: error?.message ?? null,
    refresh: mutate,
  }
}

/**
 * Trigger a background refresh for a trader.
 * Returns job status and estimated wait time.
 */
export function useTraderRefresh(traderId: string | null) {
  const url = traderId ? `/api/trader/${encodeURIComponent(traderId)}/refresh` : null

  const { trigger, data, error, isMutating } = useSWRMutation<RefreshResponse, Error, string | null, Record<string, unknown> | undefined>(
    url,
    postFetcher,
  )

  return {
    triggerRefresh: (priority?: number) => trigger(priority ? { priority } : undefined),
    jobStatus: data ?? null,
    isRefreshing: isMutating,
    error: error?.message ?? null,
  }
}

/**
 * Helper to build the composite trader ID.
 */
export function buildTraderId(platform: Platform, traderKey: string): string {
  return `${platform}:${traderKey}`
}
