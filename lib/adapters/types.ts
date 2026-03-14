/**
 * Exchange Adapter Types
 * Unified interface for fetching trader data from different exchanges
 *
 * @deprecated Most types here are superseded by UnifiedTrader in lib/types/unified-trader.ts.
 * New code should import from unified-trader.ts. These types remain for backward compatibility.
 */

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderData {
  // Identity
  platform: string
  traderId: string
  nickname: string
  avatar?: string

  // Performance Metrics
  roi: number // Return on Investment (%)
  pnl: number // Profit and Loss (USDT)
  aum?: number // Assets Under Management (USDT)
  followers: number
  tradesCount: number

  // Risk Metrics
  winRate: number // Win rate (%)
  maxDrawdown: number // Max drawdown (%)
  sharpeRatio?: number

  // Time-based metrics
  periodDays: number // Metrics calculation period
  dailyPnl?: number
  weeklyPnl?: number
  monthlyPnl?: number

  // Additional info
  description?: string
  tags?: string[]
  verified?: boolean
  lastTradeAt?: Date
  createdAt?: Date

  // Data quality
  dataSource: 'api' | 'scraper' | 'cache'
  fetchedAt: Date
}

export interface LeaderboardQuery {
  platform: string
  limit?: number // Max traders to fetch (default: 100)
  sortBy?: 'roi' | 'pnl' | 'followers' | 'aum'
  minFollowers?: number
  periodDays?: 7 | 30 | 90 | 365 | 'all'
}

export interface LeaderboardResponse {
  traders: TraderData[]
  total: number
  hasMore: boolean
  nextCursor?: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderDetailQuery {
  platform: string
  traderId: string
}

export interface RateLimitInfo {
  limit: number // Max requests per period
  period: number // Period in seconds
  remaining?: number
  resetAt?: Date
}

export interface ExchangeAdapter {
  // Metadata
  name: string
  type: 'cex' | 'dex'

  // Core methods
  fetchLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResponse>
  fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null>

  // Health check
  healthCheck(): Promise<boolean>

  // Rate limit info
  getRateLimitInfo(): RateLimitInfo
}

export interface AdapterConfig {
  apiKey?: string
  apiSecret?: string
  baseUrl?: string
  timeout?: number // Request timeout in ms (default: 30000)
  retries?: number // Max retry attempts (default: 3)
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public code: string,
    public platform: string,
    public originalError?: Error
  ) {
    super(message)
    this.name = 'AdapterError'
  }
}
