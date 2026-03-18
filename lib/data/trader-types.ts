/**
 * Type definitions for trader data adapter.
 *
 * @deprecated Most types here are superseded by UnifiedTrader in lib/types/unified-trader.ts.
 * New code should import from unified-trader.ts. These types remain for backward compatibility.
 */

// 支持的交易所数据源
export const TRADER_SOURCES = ['binance', 'bybit', 'bitget', 'okx', 'kucoin', 'gate', 'mexc', 'coinex'] as const
export const TRADER_SOURCES_WITH_WEB3 = ['binance_web3', ...TRADER_SOURCES] as const

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export type TraderSource = typeof TRADER_SOURCES[number]
/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export type TraderSourceWithWeb3 = typeof TRADER_SOURCES_WITH_WEB3[number]

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderSourceRecord {
  source_trader_id: string
  handle: string | null
  profile_url: string | null
  source: string
}

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
export interface TraderProfile {
  handle: string
  display_name?: string | null
  trader_key?: string
  id: string
  uid?: number
  bio?: string
  followers?: number
  following?: number
  followingTraders?: number
  copiers?: number
  avatar_url?: string
  cover_url?: string
  profile_url?: string | null
  isRegistered?: boolean
  source?: string
  showFollowers?: boolean
  showFollowing?: boolean
}

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
export interface TraderPerformance {
  roi_7d?: number
  roi_30d?: number
  roi_90d?: number
  roi_1y?: number
  roi_2y?: number
  return_ytd?: number
  return_2y?: number
  pnl?: number
  win_rate?: number
  max_drawdown?: number
  pnl_7d?: number
  pnl_30d?: number
  win_rate_7d?: number
  win_rate_30d?: number
  max_drawdown_7d?: number
  max_drawdown_30d?: number
  risk_score_last_7d?: number
  profitable_weeks?: number
  monthlyPerformance?: Array<{ month: string; value: number }>
  yearlyPerformance?: Array<{ year: number; value: number }>
  arena_score?: number | null
  return_score?: number | null
  drawdown_score?: number | null
  stability_score?: number | null
  profitability_score?: number | null
  risk_control_score?: number | null
  execution_score?: number | null
  arena_score_v3?: number | null
  score_completeness?: string | null
  score_penalty?: number | null
}

/** @deprecated Use UnifiedTrader from lib/types/unified-trader.ts */
export interface TraderStats {
  expectedDividends?: {
    dividendYield: number
    assets: number
    trendingStocks: Array<{ symbol: string; yield: number; icon?: string }>
  }
  trading?: {
    totalTrades12M: number
    avgProfit: number
    avgLoss: number
    profitableTradesPct: number
  }
  frequentlyTraded?: Array<{
    symbol: string
    weightPct: number
    count: number
    avgProfit: number
    avgLoss: number
    profitablePct: number
  }>
  additionalStats?: {
    tradesPerWeek?: number
    avgHoldingTime?: string
    activeSince?: string
    profitableWeeksPct?: number
    riskScore?: number
    volume90d?: number
    maxDrawdown?: number
    sharpeRatio?: number
  }
  monthlyPerformance?: Array<{ month: string; value: number }>
  yearlyPerformance?: Array<{ year: number; value: number }>
}

/** @deprecated Use TraderPosition from lib/types/unified-trader.ts */
export interface PortfolioItem {
  market: string
  direction: 'long' | 'short'
  invested: number
  pnl: number
  value: number
  price: number
  priceChange?: number
  priceChangePct?: number
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface PositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  entryPrice: number
  exitPrice: number
  pnlPct: number
  openTime: string
  closeTime: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderFeedItem {
  id: string
  type: 'post' | 'group_post' | 'repost'
  title: string
  content?: string
  time: string
  groupId?: string
  groupName?: string
  like_count?: number
  is_pinned?: boolean
  repost_comment?: string
  original_author_handle?: string
  original_post_id?: string
}
