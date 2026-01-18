/**
 * Worker 服务类型定义
 */

export type TimeRange = '7D' | '30D' | '90D'

export type DataSource =
  | 'binance'
  | 'binance_spot'
  | 'binance_web3'
  | 'bybit'
  | 'bitget'
  | 'bitget_spot'
  | 'mexc'
  | 'coinex'
  | 'okx_web3'
  | 'kucoin'
  | 'gmx'

export interface TraderData {
  traderId: string
  nickname: string | null
  avatar: string | null
  roi: number
  pnl: number
  winRate: number | null
  maxDrawdown: number | null
  followers: number
  aum: number | null
  tradesCount: number | null
  rank: number
}

export interface ScrapeResult {
  source: DataSource
  timeRange: TimeRange
  traders: TraderData[]
  scrapedAt: string
  duration: number
  success: boolean
  error?: string
}

export interface ScrapeConfig {
  source: DataSource
  timeRange: TimeRange
  targetCount: number
  maxPages: number
  baseUrl: string
}

export interface ScraperOptions {
  headless?: boolean
  timeout?: number
  retries?: number
}

// Supabase 表结构
export interface TraderSourceRow {
  source: string
  source_type: string
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  is_active: boolean
}

export interface TraderSnapshotRow {
  source: string
  source_trader_id: string
  season_id: string
  rank: number
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  followers: number
  trades_count: number | null
  captured_at: string
}
