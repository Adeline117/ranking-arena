/**
 * Multi-Exchange Leaderboard Schema — DATA PIPELINE TYPES
 *
 * These types serve the data pipeline (connectors, services, cron jobs).
 * For frontend/UI code, use UnifiedTrader from './unified-trader'.
 *
 * Defines types for trader identity, snapshots, timeseries,
 * and data provenance across all supported platforms.
 *
 * Architecture invariants:
 * - All page loads read from DB only; no synchronous scraping on user click.
 * - Missing fields are nullable and UI uses degradation strategy.
 * - Every snapshot is keyed by (platform, trader_key, window, date_bucket).
 */

// ============================================
// Platform & Market Type Definitions
// ============================================

/** All supported platforms (CEX + DEX + Data Sources) */
export const PLATFORMS = [
  // CEX
  'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin',
  'bitmart', 'phemex', 'htx', 'weex', 'bingx', 'gateio', 'xt',
  'lbank', 'blofin',
  // DEX / On-chain / Perp
  'gmx', 'dydx', 'hyperliquid', 'gains',
  // Data/Intelligence (enrichment only)
  'nansen', 'dune',
  // Dune on-chain leaderboards
  'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi',
  // Wallet (mapped/degraded)
  'okx_wallet',
] as const

export type Platform = typeof PLATFORMS[number]

/** Platforms that provide leaderboard data — must match `source` column in DB */
export const LEADERBOARD_PLATFORMS = [
  // CEX futures
  'binance_futures', 'bybit', 'bitget_futures', 'okx_futures',
  'mexc', 'coinex', 'htx_futures', 'bingx', 'gateio', 'xt',
  'bitmart', 'btcc', 'bitunix', 'bitfinex',
  // CEX spot
  'binance_spot', 'bybit_spot', 'okx_spot',
  // Web3 / DEX
  'binance_web3', 'okx_web3',
  'hyperliquid', 'gmx', 'dydx', 'gains', 'jupiter_perps', 'aevo',
  'drift', 'paradex', 'vertex', 'apex_pro', 'rabbitx',
  // Social trading
  'etoro',
  // Bots
  'web3_bot',
  // Crypto.com (Cloudflare protected, VPS scraper)
  'crypto_com',
  // Dead/blocked but may have historical data or connectors
  'kucoin', 'phemex', 'lbank', 'blofin', 'weex', 'toobit',
  'kwenta', 'synthetix', 'mux', 'perpetual_protocol', 'pionex',
  'bitget_spot', 'okx_wallet',
  // Dune on-chain leaderboards
  'dune_gmx', 'dune_hyperliquid', 'dune_uniswap', 'dune_defi',
  // New platforms (Wave 2)
  'woox', 'polymarket', 'copin',
  // Legacy short names (backward compat for v2 API callers)
  'binance', 'bitget', 'okx', 'htx',
] as const

export type LeaderboardPlatform = typeof LEADERBOARD_PLATFORMS[number]

/** Enrichment-only platforms (not leaderboards) */
export const ENRICHMENT_PLATFORMS = ['nansen', 'dune', 'okx_wallet'] as const
export type EnrichmentPlatform = typeof ENRICHMENT_PLATFORMS[number]

/** Data supplement sources */
export const DATA_SOURCES = ['nansen', 'dune'] as const
export type DataSource = (typeof DATA_SOURCES)[number]

/** Market types within a platform */
export const MARKET_TYPES = ['futures', 'spot', 'perp', 'web3', 'copy'] as const
export type MarketType = typeof MARKET_TYPES[number]

/** Trading category */
export type TradingCategory = 'futures' | 'spot' | 'onchain'

/** Time windows for snapshots */
export const WINDOWS = ['7d', '30d', '90d'] as const
export type Window = typeof WINDOWS[number]

/** Ranking window (alias for Window for backward compatibility) */
export type RankingWindow = Window

/** Legacy TimeRange compatibility mapping */
export type TimeRangeToWindow = {
  '7D': '7d'
  '30D': '30d'
  '90D': '90d'
}

/**
 * Granular platform identifiers (combines platform + market type).
 * Used by the legacy connector interface and rate limiter configs.
 */
export const GRANULAR_PLATFORMS = [
  'binance_futures',
  'binance_spot',
  'binance_web3',
  'bybit',
  'bitget_futures',
  'bitget_spot',
  'mexc',
  'coinex',
  'okx',
  'okx_futures',
  'okx_web3',
  'okx_wallet',
  'kucoin',
  'gmx',
  'dydx',
  'hyperliquid',
  'bitmart',
  'phemex',
  'htx',
  'htx_futures',
  'weex',
  'bingx',
  'gateio',
  'xt',
  'pionex',
  'kwenta',
  'mux',
  'gains',
  'lbank',
  'blofin',
  'bybit_spot',
  'jupiter_perps',
  'aevo',
  'etoro',
  'drift',
  'bitunix',
  'btcc',
  'bitfinex',
  'toobit',
  'web3_bot',
  'crypto_com',
  // Dune on-chain leaderboards
  'dune_gmx',
  'dune_hyperliquid',
  'dune_uniswap',
  'dune_defi',
  // New platforms (Wave 2)
  'woox',
  'polymarket',
  'copin',
  'okx_spot',
  'paradex',
  'vertex',
  'apex_pro',
  'rabbitx',
  'synthetix',
  'perpetual_protocol',
  'bingx_spot',
] as const

export type GranularPlatform = (typeof GRANULAR_PLATFORMS)[number]

/** Platform -> category mapping (for granular platform IDs) */
export const PLATFORM_CATEGORY: Record<GranularPlatform, TradingCategory> = {
  binance_futures: 'futures',
  binance_spot: 'spot',
  binance_web3: 'onchain',
  bybit: 'futures',
  bitget_futures: 'futures',
  bitget_spot: 'spot',
  mexc: 'futures',
  coinex: 'futures',
  okx: 'futures',
  okx_futures: 'futures',
  okx_web3: 'onchain',
  okx_wallet: 'onchain',
  kucoin: 'futures',
  gmx: 'onchain',
  dydx: 'onchain',
  hyperliquid: 'onchain',
  bitmart: 'futures',
  phemex: 'futures',
  htx: 'futures',
  htx_futures: 'futures',
  weex: 'futures',
  bingx: 'futures',
  gateio: 'futures',
  xt: 'futures',
  pionex: 'futures',
  kwenta: 'onchain',
  gains: 'onchain',
  mux: 'onchain',
  lbank: 'futures',
  blofin: 'futures',
  bybit_spot: 'spot',
  jupiter_perps: 'onchain',
  aevo: 'onchain',
  etoro: 'spot',
  drift: 'onchain',
  bitunix: 'futures',
  btcc: 'futures',
  bitfinex: 'futures',
  toobit: 'futures',
  web3_bot: 'onchain',
  crypto_com: 'futures',
  // Dune on-chain leaderboards
  dune_gmx: 'onchain',
  dune_hyperliquid: 'onchain',
  dune_uniswap: 'spot',
  dune_defi: 'onchain',
  // New platforms (Wave 2)
  woox: 'futures',
  polymarket: 'onchain',
  copin: 'onchain',
  okx_spot: 'spot',
  bingx_spot: 'spot',
  paradex: 'onchain',
  vertex: 'onchain',
  apex_pro: 'onchain',
  rabbitx: 'onchain',
  synthetix: 'onchain',
  perpetual_protocol: 'onchain',
}

// ============================================
// Trader Identity (trader_sources + trader_profiles)
// ============================================

/** Pipeline type: trader identity as discovered from platform */
export interface TraderIdentity {
  platform: Platform | GranularPlatform
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  profile_url: string | null
  discovered_at: string
  last_seen: string
}

/** Pipeline type: trader source record from connector discovery */
export interface TraderSource {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  display_name: string | null
  profile_url: string | null
  discovered_at: string
  last_seen_at: string
  is_active: boolean
  raw: Record<string, unknown> | null
}

/** Pipeline type: trader profile from connector enrichment */
export interface TraderProfile {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  tags: string[]
  profile_url: string | null
  followers: number | null
  copiers: number | null
  aum: number | null
  updated_at: string
  last_enriched_at: string | null
  provenance: DataProvenance
}

/** Pipeline type: enriched trader profile */
export interface TraderProfileEnriched {
  platform: Platform | GranularPlatform
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  copier_count: number | null
  aum_usd: number | null
  active_since: string | null
  platform_tier: string | null
  last_enriched_at: string
}

// ============================================
// Snapshot Metrics (per-window rankings data)
// ============================================

/** Quality flags for data reliability (comprehensive format) */
export interface QualityFlags {
  missing_fields: string[]
  non_standard_fields: Record<string, string>
  window_native: boolean
  notes: string[]
}

/** Quality flags for a snapshot (legacy format) */
export interface SnapshotQuality {
  is_complete: boolean
  missing_fields: string[]
  confidence: number
  is_interpolated: boolean
}

/** Data provenance information */
export interface DataProvenance {
  source_platform: string
  acquisition_method: 'api' | 'scrape' | 'derived' | 'enrichment'
  fetched_at: string
  source_url: string | null
  scraper_version: string | null
}

/** Core metrics for a snapshot */
export interface SnapshotMetrics {
  // Core performance
  roi: number | null
  pnl: number | null
  // Risk metrics
  win_rate: number | null
  max_drawdown: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  // Activity metrics
  trades_count: number | null
  // Social metrics (null for DEX/on-chain)
  followers: number | null
  copiers: number | null
  aum: number | null
  // Ranking
  platform_rank: number | null
  // Arena Score (computed by us)
  arena_score: number | null
  return_score: number | null
  drawdown_score: number | null
  stability_score: number | null
  // Score confidence: 'full' = all data present, 'partial' = some defaults used, 'minimal' = most defaults used
  score_confidence?: 'full' | 'partial' | 'minimal' | null
  // Extended metrics (may be null for some platforms)
  volatility_pct?: number | null
  avg_holding_hours?: number | null
  profit_factor?: number | null
}

/** Legacy snapshot metrics format using different field names */
export interface SnapshotMetricsLegacy {
  roi_pct: number | null
  pnl_usd: number | null
  win_rate_pct: number | null
  max_drawdown_pct: number | null
  trades_count: number | null
  copier_count: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  volatility_pct: number | null
  avg_holding_hours: number | null
  profit_factor: number | null
  arena_score: number | null
  return_score: number | null
  drawdown_score: number | null
  stability_score: number | null
  score_confidence?: 'full' | 'partial' | 'minimal' | null
}

/** Pipeline type: snapshot data from connectors */
export interface TraderSnapshot {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  window: Window
  as_of_ts: string
  metrics: SnapshotMetrics
  quality_flags: QualityFlags
  updated_at: string
}

/** Pipeline type: legacy snapshot format (v1 tables) */
export interface TraderSnapshotLegacy {
  id: string
  platform: Platform | GranularPlatform
  trader_key: string
  window: RankingWindow
  as_of_ts: string
  metrics: SnapshotMetricsLegacy
  quality: SnapshotQuality
  created_at: string
}

// ============================================
// Timeseries Data (equity curves, daily PnL, etc.)
// ============================================

/** Types of timeseries data */
export const SERIES_TYPES = [
  'equity_curve',
  'daily_pnl',
  'daily_roi',
  'drawdown_curve',
  'aum_history',
] as const
export type SeriesType = typeof SERIES_TYPES[number]

/** Legacy timeseries type */
export type TimeseriesType = 'equity_curve' | 'drawdown' | 'daily_pnl' | 'position_count'

/** A single data point in a timeseries */
export interface TimeseriesPoint {
  ts: string
  value: number
}

/** Pipeline type: timeseries data from connectors */
export interface TraderTimeseries {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  series_type: SeriesType
  as_of_ts: string
  data: TimeseriesPoint[]
  updated_at: string
}

/** Pipeline type: legacy timeseries format (v1 tables) */
export interface TraderTimeseriesLegacy {
  id: string
  platform: Platform | GranularPlatform
  trader_key: string
  series_type: TimeseriesType
  data: TimeseriesPoint[]
  as_of_ts: string
  created_at: string
}

// ============================================
// Refresh Jobs
// ============================================

export const JOB_TYPES = [
  'DISCOVER',
  'SNAPSHOT_REFRESH',
  'PROFILE_ENRICH',
  'TIMESERIES_REFRESH',
] as const
export type JobType = typeof JOB_TYPES[number]

/** Legacy job types */
export type LegacyJobType = 'discovery' | 'snapshot' | 'profile' | 'timeseries' | 'full_refresh'

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const
export type JobStatus = typeof JOB_STATUSES[number]

export const JOB_PRIORITIES = {
  USER_TRIGGERED: 10,
  TOP_N_PREHEAT: 20,
  SCHEDULED_ACTIVE: 30,
  SCHEDULED_LONG_TAIL: 40,
  BACKGROUND: 50,
} as const
export type JobPriority = typeof JOB_PRIORITIES[keyof typeof JOB_PRIORITIES]

export interface RefreshJob {
  id: string
  job_type: JobType
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string | null
  window: Window | null
  priority: number
  status: JobStatus
  attempts: number
  max_attempts: number
  next_run_at: string
  locked_at: string | null
  locked_by: string | null
  last_error: string | null
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string
  /** Idempotency key: prevents duplicate jobs for same target+day */
  idempotency_key?: string
}

// ============================================
// Platform Rate Limits
// ============================================

export interface PlatformRateLimit {
  platform: Platform
  requests_per_minute: number
  max_concurrency: number
  cooldown_until: string | null
  consecutive_failures: number
  last_success_at: string | null
  last_failure_at: string | null
  updated_at: string
}

/** Rate limiter configuration (for legacy BaseConnector) */
export interface RateLimiterConfig {
  max_requests: number
  window_ms: number
  min_delay_ms: number
  max_delay_ms: number
  max_concurrent: number
}

/** Per-platform rate limit defaults (granular platform IDs) */
export const PLATFORM_RATE_LIMITS: Record<GranularPlatform, RateLimiterConfig> = {
  binance_futures: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  binance_spot: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  binance_web3: { max_requests: 20, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  bybit: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  bitget_futures: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  bitget_spot: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  mexc: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  coinex: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  okx: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  okx_futures: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  okx_web3: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  okx_wallet: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  kucoin: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  gmx: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  dydx: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  hyperliquid: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  bitmart: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  phemex: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  htx: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  htx_futures: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  weex: { max_requests: 10, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 1 },
  bingx: { max_requests: 20, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  gateio: { max_requests: 20, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  xt: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  pionex: { max_requests: 10, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 1 },
  kwenta: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  gains: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  mux: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  lbank: { max_requests: 20, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  blofin: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  bybit_spot: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  jupiter_perps: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  aevo: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  // Dune API rate limits (Free tier: 10 queries/day, Plus tier: 1000 queries/month)
  etoro: { max_requests: 10, window_ms: 60_000, min_delay_ms: 6000, max_delay_ms: 10000, max_concurrent: 2 },
  drift: { max_requests: 15, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 2 },
  bitunix: { max_requests: 15, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 2 },
  btcc: { max_requests: 15, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 2 },
  bitfinex: { max_requests: 15, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 2 },
  toobit: { max_requests: 15, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 2 },
  web3_bot: { max_requests: 10, window_ms: 60_000, min_delay_ms: 6000, max_delay_ms: 10000, max_concurrent: 1 },
  crypto_com: { max_requests: 10, window_ms: 60_000, min_delay_ms: 6000, max_delay_ms: 10000, max_concurrent: 2 },
  dune_gmx: { max_requests: 5, window_ms: 60_000, min_delay_ms: 12000, max_delay_ms: 20000, max_concurrent: 1 },
  dune_hyperliquid: { max_requests: 5, window_ms: 60_000, min_delay_ms: 12000, max_delay_ms: 20000, max_concurrent: 1 },
  dune_uniswap: { max_requests: 5, window_ms: 60_000, min_delay_ms: 12000, max_delay_ms: 20000, max_concurrent: 1 },
  dune_defi: { max_requests: 5, window_ms: 60_000, min_delay_ms: 12000, max_delay_ms: 20000, max_concurrent: 1 },
  // New platforms (Wave 2)
  woox: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  polymarket: { max_requests: 60, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  copin: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 2 },
  // Dead/pending platforms (minimal config for type completeness)
  okx_spot: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  bingx_spot: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  paradex: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  vertex: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  apex_pro: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  rabbitx: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  synthetix: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
  perpetual_protocol: { max_requests: 10, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 2 },
}

// ============================================
// Prewarming & Scheduling Config
// ============================================

export interface PrewarmConfig {
  top_n: number
  top_interval_ms: number
  active_interval_ms: number
  longtail_interval_ms: number
}

export const DEFAULT_PREWARM_CONFIG: PrewarmConfig = {
  top_n: 100,
  top_interval_ms: 15 * 60 * 1000,
  active_interval_ms: 60 * 60 * 1000,
  longtail_interval_ms: 4 * 60 * 60 * 1000,
}

// ============================================
// API Response Types
// ============================================

/** GET /api/rankings query params */
export interface RankingsQuery {
  window: RankingWindow
  category?: TradingCategory
  platform?: Platform
  limit?: number
  offset?: number
  sort_by?: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers' | 'win_rate' | 'sharpe_ratio' | 'trades_count'
  sort_dir?: 'asc' | 'desc'
  min_pnl?: number
  min_trades?: number
  trader_type?: 'human' | 'bot'
}

/** Pipeline type: ranked trader row for leaderboard queries */
export interface RankedTraderRow {
  rank: number
  platform: Platform
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  category: TradingCategory
  metrics: SnapshotMetrics
  quality: SnapshotQuality
  as_of_ts: string
}

/** Rankings API response (new format) */
export interface RankingsResponse {
  traders: RankingEntry[]
  meta: {
    platform: LeaderboardPlatform | 'all'
    market_type: MarketType | 'all'
    window: Window
    total_count: number
    updated_at: string
    staleness_seconds: number
    sort_by?: string
    sort_dir?: string
    limit?: number
    offset?: number
    cached_at?: string
    category?: TradingCategory | 'all'
  }
}

/** Single entry in rankings response */
export interface RankingEntry {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  window: Window
  metrics: SnapshotMetrics
  quality_flags: QualityFlags
  updated_at: string
}

/** Pipeline type: raw trader detail response (pre-unification) */
export interface TraderDetailResponse {
  profile: TraderProfile
  snapshots: Record<Window, TraderSnapshot | null>
  timeseries: TraderTimeseries[]
  refresh_status: {
    last_refreshed_at: string | null
    is_refreshing: boolean
    next_refresh_at: string | null
  }
  provenance: DataProvenance
  data_freshness?: {
    last_snapshot_at: string | null
    last_profile_at: string | null
    last_timeseries_at: string | null
    is_stale: boolean
    stale_reason: string | null
  }
}

/** Refresh request response */
export interface RefreshResponse {
  job_id: string
  status: JobStatus
  estimated_wait_seconds: number | null
  message: string
}

// ============================================
// Connector Interface Types
// ============================================

/** Result from discovering traders on a leaderboard */
export interface DiscoverResult {
  traders: TraderSource[]
  total_available: number | null
  window: Window
  fetched_at: string
}

/** Result from fetching a trader's profile */
export interface ProfileResult {
  profile: TraderProfile
  fetched_at: string
}

/** Result from fetching snapshot metrics */
export interface SnapshotResult {
  metrics: SnapshotMetrics
  quality_flags: QualityFlags
  fetched_at: string
}

/** Result from fetching timeseries */
export interface TimeseriesResult {
  series: TraderTimeseries[]
  fetched_at: string
}

// ============================================
// Platform Capability Matrix
// ============================================

/** What a platform supports */
export interface PlatformCapabilities {
  platform: LeaderboardPlatform
  market_types: MarketType[]
  native_windows: Window[]
  available_fields: (keyof SnapshotMetrics)[]
  has_timeseries: boolean
  has_profiles: boolean
  scraping_difficulty: 1 | 2 | 3 | 4 | 5
  rate_limit: {
    rpm: number
    concurrency: number
  }
  notes: string[]
}

// ============================================
// Field Degradation Strategy
// ============================================

/** How to handle missing/incomparable fields */
export type FieldDegradation = {
  field: keyof SnapshotMetrics
  reason: 'platform_not_provided' | 'different_calculation' | 'not_applicable' | 'fetch_failed'
  explanation_zh: string
  explanation_en: string
  fallback: 'show_na' | 'hide' | 'show_warning'
}

/** Standard field degradation messages */
export const FIELD_DEGRADATIONS: Record<string, FieldDegradation> = {
  gmx_win_rate: {
    field: 'win_rate',
    reason: 'not_applicable',
    explanation_zh: 'GMX 为链上永续合约，无传统胜率概念',
    explanation_en: 'GMX is on-chain perpetual, win rate not applicable',
    fallback: 'show_na',
  },
  gmx_followers: {
    field: 'followers',
    reason: 'not_applicable',
    explanation_zh: 'GMX 无跟单功能',
    explanation_en: 'GMX does not have copy trading',
    fallback: 'show_na',
  },
  dydx_followers: {
    field: 'followers',
    reason: 'not_applicable',
    explanation_zh: 'dYdX 无跟单功能',
    explanation_en: 'dYdX does not have copy trading',
    fallback: 'show_na',
  },
  hyperliquid_followers: {
    field: 'followers',
    reason: 'not_applicable',
    explanation_zh: 'Hyperliquid 无跟单功能',
    explanation_en: 'Hyperliquid does not have copy trading',
    fallback: 'show_na',
  },
  platform_90d_missing: {
    field: 'roi',
    reason: 'platform_not_provided',
    explanation_zh: '该平台未提供90天数据窗口',
    explanation_en: 'This platform does not provide 90-day window',
    fallback: 'show_na',
  },
  // Dune on-chain data limitations
  dune_gmx_followers: {
    field: 'followers',
    reason: 'not_applicable',
    explanation_zh: 'Dune GMX 数据来自链上，无跟单功能',
    explanation_en: 'Dune GMX data is on-chain, no copy trading',
    fallback: 'show_na',
  },
  dune_hyperliquid_followers: {
    field: 'followers',
    reason: 'not_applicable',
    explanation_zh: 'Dune Hyperliquid 数据来自链上，无跟单功能',
    explanation_en: 'Dune Hyperliquid data is on-chain, no copy trading',
    fallback: 'show_na',
  },
  dune_uniswap_roi: {
    field: 'roi',
    reason: 'different_calculation',
    explanation_zh: 'Uniswap 交易量而非收益率',
    explanation_en: 'Uniswap tracks volume, not ROI',
    fallback: 'show_warning',
  },
  dune_defi_followers: {
    field: 'followers',
    reason: 'not_applicable',
    explanation_zh: 'DeFi 钱包活动无跟单功能',
    explanation_en: 'DeFi wallet activity has no copy trading',
    fallback: 'show_na',
  },
}

/** Fields and their simple degradation behavior (legacy format) */
export const FIELD_DEGRADATION: Record<keyof SnapshotMetricsLegacy, { label: string; fallback: string }> = {
  roi_pct: { label: 'ROI', fallback: '—' },
  pnl_usd: { label: 'PnL', fallback: '—' },
  win_rate_pct: { label: 'Win Rate', fallback: 'N/A' },
  max_drawdown_pct: { label: 'Max Drawdown', fallback: 'N/A' },
  trades_count: { label: 'Trades', fallback: '—' },
  copier_count: { label: 'Copiers', fallback: 'N/A' },
  sharpe_ratio: { label: 'Sharpe', fallback: '—' },
  sortino_ratio: { label: 'Sortino', fallback: '—' },
  volatility_pct: { label: 'Volatility', fallback: '—' },
  avg_holding_hours: { label: 'Avg Hold', fallback: '—' },
  profit_factor: { label: 'Profit Factor', fallback: '—' },
  arena_score: { label: 'Arena Score', fallback: '—' },
  return_score: { label: 'Return Score', fallback: '—' },
  drawdown_score: { label: 'Drawdown Score', fallback: '—' },
  stability_score: { label: 'Stability Score', fallback: '—' },
  score_confidence: { label: 'Score Confidence', fallback: '—' },
}
