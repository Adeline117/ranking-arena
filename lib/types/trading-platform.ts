/**
 * Trading Platform — DB ROW TYPES
 *
 * These types map directly to database table schemas.
 * For frontend/UI code, use UnifiedTrader from './unified-trader'.
 */

// ============================================
// Platform & Window Constants
// ============================================

export const SUPPORTED_PLATFORMS = [
  // CEX futures
  'binance_futures', 'bybit', 'bitget_futures', 'okx_futures',
  'mexc', 'htx_futures', 'coinex', 'bingx', 'gateio', 'xt',
  'blofin', 'btcc', 'bitfinex', 'bitunix', 'toobit', 'lbank',
  'weex', 'phemex', 'kucoin',
  // CEX spot
  'binance_spot', 'bybit_spot', 'okx_spot', 'bitget_spot',
  // Web3 / DEX
  'binance_web3', 'okx_web3', 'hyperliquid', 'gmx', 'dydx',
  'gains', 'jupiter_perps', 'aevo', 'drift', 'web3_bot',
  // Social trading
  'etoro',
  // New platforms (Wave 2)
  'woox', 'polymarket', 'copin',
] as const

export type Platform = typeof SUPPORTED_PLATFORMS[number]

export const SNAPSHOT_WINDOWS = ['7D', '30D', '90D'] as const
export type SnapshotWindow = typeof SNAPSHOT_WINDOWS[number]

export const JOB_TYPES = [
  'full_refresh',
  'profile_only',
  'snapshot_only',
  'timeseries_only',
] as const
export type JobType = typeof JOB_TYPES[number]

export const JOB_STATUSES = [
  'pending',
  'running',
  'success',
  'failed',
  'cancelled',
] as const
export type JobStatus = typeof JOB_STATUSES[number]

export const SERIES_TYPES = [
  'equity_curve',
  'daily_pnl',
  'asset_breakdown',
] as const
export type SeriesType = typeof SERIES_TYPES[number]

// ============================================
// Database Row Types (snake_case, matches DB)
// ============================================

/** DB row type */
export interface TraderSourceRow {
  id: string
  platform: Platform
  trader_key: string
  handle: string | null
  profile_url: string | null
  type: string
  discovered_at: string
  last_seen_at: string
  is_active: boolean
}

/** DB row type */
export interface TraderProfileRow {
  id: string
  platform: Platform
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  profile_url: string | null
  bio: string | null
  /** Source of the bio: 'auto' = generated, 'manual' = user-written, 'exchange' = from exchange API */
  bio_source: 'auto' | 'manual' | 'exchange' | null
  tags: string[]
  followers: number | null
  copiers: number | null
  aum: number | null
  updated_at: string
  last_enriched_at: string | null
  created_at: string
}

export interface SnapshotMetrics {
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  copiers: number | null
  aum: number | null
  sharpe_ratio: number | null
  arena_score: number | null
  return_score: number | null
  drawdown_score: number | null
  stability_score: number | null
  score_confidence?: 'full' | 'partial' | 'minimal' | null
  rank: number | null
  // V3 Advanced Metrics
  sortino_ratio?: number | null
  calmar_ratio?: number | null
  profit_factor?: number | null
  recovery_factor?: number | null
  max_consecutive_wins?: number | null
  max_consecutive_losses?: number | null
  avg_holding_hours?: number | null
  volatility_pct?: number | null
  downside_volatility_pct?: number | null
  // Market Correlation
  beta_btc?: number | null
  beta_eth?: number | null
  alpha?: number | null
  // Classification
  trading_style?: 'hft' | 'day_trader' | 'swing' | 'trend' | 'scalping' | null
  style_confidence?: number | null
  // Arena Score V3
  arena_score_v3?: number | null
}

export interface QualityFlags {
  is_suspicious: boolean
  suspicion_reasons: string[]
  data_completeness: number  // 0-1
}

/** DB row type */
export interface TraderSnapshotV2Row {
  id: string
  platform: Platform
  trader_key: string
  window: SnapshotWindow
  as_of_ts: string
  metrics: SnapshotMetrics
  quality_flags: QualityFlags
  updated_at: string
  created_at: string
}

export interface TraderTimeseriesRow {
  id: string
  platform: Platform
  trader_key: string
  series_type: SeriesType
  as_of_ts: string
  data: EquityCurvePoint[] | DailyPnlPoint[] | AssetBreakdownPoint[]
  updated_at: string
  created_at: string
}

export interface RefreshJobRow {
  id: string
  job_type: JobType
  platform: Platform
  trader_key: string
  priority: number
  status: JobStatus
  attempts: number
  max_attempts: number
  next_run_at: string
  locked_at: string | null
  locked_by: string | null
  started_at: string | null
  completed_at: string | null
  last_error: string | null
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ============================================
// Timeseries Data Point Types
// ============================================

export interface EquityCurvePoint {
  date: string  // ISO date
  roi: number
  pnl: number
  equity?: number
}

export interface DailyPnlPoint {
  date: string
  pnl: number
  trades: number
}

export interface AssetBreakdownPoint {
  symbol: string
  weight_pct: number
  count: number
}

// ============================================
// API Request Types
// ============================================

export interface RankingsQueryParams {
  window: SnapshotWindow
  platform?: Platform
  type?: 'futures' | 'spot' | 'web3'
  sort_by?: 'arena_score' | 'roi' | 'pnl' | 'win_rate' | 'max_drawdown'
  sort_dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface RefreshRequest {
  job_type?: JobType
  priority?: number
}

// ============================================
// API Response Types
// ============================================

export interface RankingsResponse {
  traders: RankedTraderV2[]
  window: SnapshotWindow
  total_count: number
  as_of: string
  is_stale: boolean
  stale_sources?: string[]
}

/** DB row type */
export interface RankedTraderV2 {
  platform: Platform
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  rank: number
  metrics: SnapshotMetrics
  quality_flags: QualityFlags
  updated_at: string
}

/** DB row type */
export interface TraderDetailResponse {
  profile: TraderProfileRow
  snapshots: Record<SnapshotWindow, SnapshotMetrics | null>
  timeseries: {
    equity_curve: EquityCurvePoint[] | null
    daily_pnl: DailyPnlPoint[] | null
    asset_breakdown: AssetBreakdownPoint[] | null
  }
  updated_at: string
  is_stale: boolean
  staleness_seconds: number
  refresh_job: RefreshJobSummary | null
}

export interface RefreshJobSummary {
  id: string
  status: JobStatus
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface RefreshResponse {
  job: RefreshJobSummary
  created: boolean  // true if new job was created, false if existing job returned
}

// ============================================
// Connector Interface Types
// ============================================

/** DB row type */
export interface ConnectorTraderProfile {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  followers: number | null
  copiers: number | null
  aum: number | null
  tags: string[]
}

export interface ConnectorSnapshot {
  trader_key: string
  window: SnapshotWindow
  metrics: SnapshotMetrics
  quality_flags: Partial<QualityFlags>
}

export interface ConnectorTimeseries {
  trader_key: string
  series_type: SeriesType
  data: EquityCurvePoint[] | DailyPnlPoint[] | AssetBreakdownPoint[]
}

export interface LeaderboardEntry {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  aum: number | null
  rank: number
}

// ============================================
// Staleness Configuration
// ============================================

/** Data staleness thresholds in seconds */
export const STALENESS_THRESHOLDS = {
  FRESH: 3600,        // < 1 hour = fresh
  ACCEPTABLE: 14400,  // < 4 hours = acceptable
  STALE: 86400,       // < 24 hours = stale
  EXPIRED: 259200,    // < 3 days = expired (still show, but warn)
} as const

/** Check if data is stale based on updated_at timestamp */
export function isDataStale(updatedAt: string, thresholdKey: keyof typeof STALENESS_THRESHOLDS = 'STALE'): boolean {
  const ageSeconds = (Date.now() - new Date(updatedAt).getTime()) / 1000
  return ageSeconds > STALENESS_THRESHOLDS[thresholdKey]
}

/** Get staleness in seconds */
export function getStalenessSeconds(updatedAt: string): number {
  return Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000)
}
