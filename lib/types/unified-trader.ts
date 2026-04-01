/**
 * Unified Trader types — THE canonical type definitions.
 * All frontend components and API routes should use these types.
 * No other Trader type definitions should exist.
 *
 * Field naming conventions:
 * - roi: always percentage (120.5 = 120.5%), never ratio
 * - pnl: always USD
 * - winRate: 0-100 range
 * - platform: canonical source name ('binance_futures', 'hyperliquid', etc.)
 * - traderKey: the trader's unique ID on the platform (= source_trader_id in v1)
 */

// Canonical period values used across the system
// Maps to: season_id (leaderboard_ranks), season_id (trader_snapshots v1), window (trader_snapshots_v2)
export type TradingPeriod = '7D' | '30D' | '90D'

// The ONE trader type for all frontend use
export interface UnifiedTrader {
  // Identity
  platform: string          // canonical: 'binance_futures', 'hyperliquid', etc.
  traderKey: string         // canonical: the trader's unique ID on the platform
  handle: string | null     // human-readable name
  avatarUrl: string | null
  profileUrl: string | null
  marketType: string | null // 'futures' | 'spot' | 'web3'
  sourceType: string | null // 'futures' | 'spot' | 'web3' (from EXCHANGE_CONFIG)

  // Performance (always percentage/USD, never ratios)
  roi: number | null        // ROI in percentage (e.g. 120.5 = 120.5%)
  pnl: number | null        // PnL in USD
  winRate: number | null    // Win rate 0-100
  maxDrawdown: number | null
  tradesCount: number | null
  followers: number | null
  copiers: number | null

  // Scores
  arenaScore: number | null
  returnScore: number | null
  pnlScore: number | null
  drawdownScore: number | null
  stabilityScore: number | null
  profitabilityScore: number | null
  riskControlScore: number | null
  executionScore: number | null
  scoreConfidence: string | null

  // Rankings
  rank: number | null
  period: TradingPeriod     // which period this data represents

  // Advanced metrics
  sharpeRatio: number | null
  sortinoRatio: number | null
  profitFactor: number | null
  calmarRatio: number | null
  tradingStyle: string | null
  avgHoldingHours: number | null

  // Metadata
  traderType: string | null // 'human' | 'bot'
  isOutlier: boolean
  lastUpdated: string | null
}

// For equity curve data
export interface EquityPoint {
  date: string
  roi: number | null
  pnl: number | null
}

// For asset breakdown
export interface AssetWeight {
  symbol: string
  weightPct: number
}

// For position history
export interface TraderPosition {
  symbol: string
  direction: string | null
  openTime: string | null
  closeTime: string | null
  entryPrice: number | null
  exitPrice: number | null
  pnlUsd: number | null
  pnlPct: number | null
  status: string | null
}

// Advanced metrics (detail view)
export interface TraderAdvancedMetrics {
  sortino_ratio: number | null
  calmar_ratio: number | null
  profit_factor: number | null
  recovery_factor: number | null
  max_consecutive_wins: number | null
  max_consecutive_losses: number | null
  avg_holding_hours: number | null
  volatility_pct: number | null
  downside_volatility_pct: number | null
}

// Market condition type
export type MarketCondition = 'bull' | 'bear' | 'sideways'

// Market correlation data
export interface TraderMarketCorrelation {
  beta_btc: number | null
  beta_eth: number | null
  alpha: number | null
  market_condition_performance: Record<MarketCondition, number | null>
}

// Live position data
export interface TraderPositionLive {
  id: string
  platform: string
  market_type: string
  trader_key: string
  symbol: string
  side: 'long' | 'short'
  entry_price: number
  current_price: number | null
  mark_price: number | null
  quantity: number
  leverage: number
  margin: number | null
  unrealized_pnl: number | null
  unrealized_pnl_pct: number | null
  liquidation_price: number | null
  opened_at: string | null
  updated_at: string
}

// Full trader detail (for detail page)
export interface TraderDetail {
  trader: UnifiedTrader
  periods: Record<TradingPeriod, Partial<UnifiedTrader> | null>
  equityCurve: Record<TradingPeriod, EquityPoint[]>
  assetBreakdown: Record<TradingPeriod, AssetWeight[]>
  stats: {
    sharpeRatio: number | null
    copiersPnl: number | null
    copiersCount: number | null
    winningPositions: number | null
    totalPositions: number | null
    avgHoldingHours: number | null
    avgProfit: number | null
    avgLoss: number | null
    largestWin: number | null
    largestLoss: number | null
    aum: number | null
  } | null
  portfolio: TraderPosition[]
  positionHistory: TraderPosition[]
  similarTraders: UnifiedTrader[]
  trackedSince: string | null
  /** Exchange-level bio from trader_profiles_v2 */
  bio: string | null
}
