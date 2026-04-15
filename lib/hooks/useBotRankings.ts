'use client'

import useSWR from 'swr'

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
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
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

  const { data, error, isLoading, isValidating } = useSWR<BotRankingsResponse>(
    `/api/bots?${params.toString()}`,
    fetcher,
    { revalidateOnFocus: false, keepPreviousData: true, refreshInterval: 15 * 60 * 1000, fallbackData }
  )

  return { data, error, isLoading, isValidating }
}

export function useBotDetail(id: string | null) {
  const { data, error, isLoading } = useSWR(
    id ? `/api/bots/${id}` : null,
    fetcher,
    { revalidateOnFocus: false }
  )
  return { data, error, isLoading }
}
