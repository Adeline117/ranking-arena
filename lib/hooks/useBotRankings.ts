'use client'

import { useQuery } from '@tanstack/react-query'
import { REFETCH_SLOW } from './cache-presets'

export interface BotMetrics {
  total_volume: number | null
  total_trades: number | null
  unique_users: number | null
  revenue: number | null
  tvl: number | null
  apy: number | null
  roi: number | null
  max_drawdown: number | null
  sharpe_ratio: number | null
  token_price: number | null
  market_cap: number | null
  token_holders: number | null
  mindshare_score: number | null
  arena_score: number | null
}

export interface BotEntry {
  id: string
  slug: string
  name: string
  category: 'tg_bot' | 'ai_agent' | 'vault' | 'strategy'
  chain: string | null
  logo_url: string | null
  token_symbol: string | null
  website_url: string | null
  twitter_handle: string | null
  description: string | null
  launch_date: string | null
  rank: number
  metrics: BotMetrics
  captured_at: string
}

export interface BotRankingsResponse {
  bots: BotEntry[]
  window: string
  total_count: number
  as_of: string
  /** Present when the newest snapshot is older than 7 days (see app/api/bots/route.ts). */
  stale?: boolean
  stale_days?: number
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  try {
    return await res.json()
  } catch {
    return null
  }
}

export interface UseBotRankingsOptions {
  window?: '7D' | '30D' | '90D'
  category?: string
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  fallbackData?: BotRankingsResponse
}

export function useBotRankings(opts: UseBotRankingsOptions = {}) {
  const { window = '90D', category, sortBy = 'arena_score', sortDir = 'desc', fallbackData } = opts
  const params = new URLSearchParams({ window, sort_by: sortBy, sort_dir: sortDir })
  if (category) params.set('category', category)

  const url = `/api/bots?${params.toString()}`

  const {
    data,
    error,
    isLoading,
    isFetching: isValidating,
  } = useQuery<BotRankingsResponse>({
    queryKey: ['bot-rankings', window, category, sortBy, sortDir],
    queryFn: () => fetcher(url),
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
    refetchInterval: REFETCH_SLOW,
    initialData: fallbackData,
  })

  return { data, error, isLoading, isValidating }
}

export function useBotDetail(id: string | null) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['bot-detail', id],
    placeholderData: (prev) => prev,
    queryFn: () => fetcher(`/api/bots/${id}`),
    enabled: !!id,
    refetchOnWindowFocus: false,
  })
  return { data, error, isLoading }
}
