/**
 * Multi-Exchange Leaderboard Canonical Schema
 *
 * Defines unified types for trader identity, snapshots, timeseries,
 * and data provenance across all supported platforms.
 */

// ============================================
// Platform & Market Type Definitions
// ============================================

/** All supported platforms (CEX + DEX + Data Sources) */
export const PLATFORMS = [
  // CEX
  'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin',
  'bitmart', 'phemex', 'htx', 'weex',
  // DEX / On-chain / Perp
  'gmx', 'dydx', 'hyperliquid',
  // Data/Intelligence (enrichment only)
  'nansen', 'dune',
  // Wallet (mapped/degraded)
  'okx_wallet',
] as const

export type Platform = typeof PLATFORMS[number]

/** Platforms that provide leaderboard data */
export const LEADERBOARD_PLATFORMS = [
  'binance', 'bybit', 'bitget', 'mexc', 'coinex', 'okx', 'kucoin',
  'bitmart', 'phemex', 'htx', 'weex',
  'gmx', 'dydx', 'hyperliquid',
] as const

export type LeaderboardPlatform = typeof LEADERBOARD_PLATFORMS[number]

/** Enrichment-only platforms (not leaderboards) */
export const ENRICHMENT_PLATFORMS = ['nansen', 'dune', 'okx_wallet'] as const
export type EnrichmentPlatform = typeof ENRICHMENT_PLATFORMS[number]

/** Market types within a platform */
export const MARKET_TYPES = ['futures', 'spot', 'perp', 'web3', 'copy'] as const
export type MarketType = typeof MARKET_TYPES[number]

/** Time windows for snapshots */
export const WINDOWS = ['7d', '30d', '90d'] as const
export type Window = typeof WINDOWS[number]

/** Legacy TimeRange compatibility mapping */
export type TimeRangeToWindow = {
  '7D': '7d'
  '30D': '30d'
  '90D': '90d'
}

// ============================================
// Trader Identity (trader_sources + trader_profiles)
// ============================================

/** How a trader was discovered on a platform */
export interface TraderSource {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string          // Platform-specific unique ID
  display_name: string | null
  profile_url: string | null
  discovered_at: string       // ISO timestamp
  last_seen_at: string        // ISO timestamp
  is_active: boolean
  raw: Record<string, unknown> | null  // Raw platform response for debugging
}

/** Enriched trader profile */
export interface TraderProfile {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  tags: string[]              // e.g. ['swing', 'btc-focused']
  profile_url: string | null
  followers: number | null
  copiers: number | null
  aum: number | null          // Assets Under Management (USD)
  updated_at: string
  last_enriched_at: string | null
  provenance: DataProvenance
}

// ============================================
// Snapshot Metrics (per-window rankings data)
// ============================================

/** Quality flags for data reliability */
export interface QualityFlags {
  /** Fields that are missing from the platform */
  missing_fields: string[]
  /** Fields where the platform's definition differs from standard */
  non_standard_fields: Record<string, string>  // field -> reason
  /** Whether this window is natively provided or derived */
  window_native: boolean
  /** Human-readable notes about data quality */
  notes: string[]
}

/** Data provenance information */
export interface DataProvenance {
  /** Source platform */
  source_platform: string
  /** Method of data acquisition: 'api' | 'scrape' | 'derived' | 'enrichment' */
  acquisition_method: 'api' | 'scrape' | 'derived' | 'enrichment'
  /** When the data was fetched from the source */
  fetched_at: string
  /** Source URL or endpoint */
  source_url: string | null
  /** Version/hash of the scraper used */
  scraper_version: string | null
}

/** Core metrics for a snapshot */
export interface SnapshotMetrics {
  // Core performance (always present if platform provides leaderboard)
  roi: number | null                  // Percentage (e.g. 25.5 = 25.5%)
  pnl: number | null                 // USD
  // Risk metrics (may be null for some platforms)
  win_rate: number | null             // Percentage (0-100)
  max_drawdown: number | null         // Percentage (negative or absolute)
  sharpe_ratio: number | null
  sortino_ratio: number | null
  // Activity metrics
  trades_count: number | null
  // Social metrics (null for DEX/on-chain)
  followers: number | null
  copiers: number | null
  aum: number | null                  // USD
  // Ranking
  platform_rank: number | null        // Rank on the platform's leaderboard
  // Arena Score (computed by us)
  arena_score: number | null
  return_score: number | null
  drawdown_score: number | null
  stability_score: number | null
}

/** A complete trader snapshot for a given window */
export interface TraderSnapshot {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  window: Window
  as_of_ts: string                    // ISO timestamp of when this snapshot represents
  metrics: SnapshotMetrics
  quality_flags: QualityFlags
  updated_at: string
}

// ============================================
// Timeseries Data (equity curves, daily PnL, etc.)
// ============================================

/** Types of timeseries data */
export const SERIES_TYPES = [
  'equity_curve',       // Cumulative ROI over time
  'daily_pnl',          // Daily realized PnL
  'daily_roi',          // Daily ROI percentage
  'drawdown_curve',     // Running drawdown
  'aum_history',        // AUM over time
] as const
export type SeriesType = typeof SERIES_TYPES[number]

/** A single data point in a timeseries */
export interface TimeseriesPoint {
  ts: string            // ISO timestamp
  value: number
}

/** Timeseries record */
export interface TraderTimeseries {
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string
  series_type: SeriesType
  as_of_ts: string      // When this timeseries was captured
  data: TimeseriesPoint[]
  updated_at: string
}

// ============================================
// Refresh Jobs
// ============================================

export const JOB_TYPES = [
  'DISCOVER',            // Discover new traders from leaderboard
  'SNAPSHOT_REFRESH',    // Refresh snapshot metrics
  'PROFILE_ENRICH',     // Enrich trader profile
  'TIMESERIES_REFRESH', // Refresh timeseries data
] as const
export type JobType = typeof JOB_TYPES[number]

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const
export type JobStatus = typeof JOB_STATUSES[number]

export const JOB_PRIORITIES = {
  USER_TRIGGERED: 10,      // Highest: user clicked refresh
  TOP_N_PREHEAT: 20,       // High: top traders auto-refresh
  SCHEDULED_ACTIVE: 30,    // Medium: active traders periodic
  SCHEDULED_LONG_TAIL: 40, // Low: long-tail traders
  BACKGROUND: 50,          // Lowest: background enrichment
} as const
export type JobPriority = typeof JOB_PRIORITIES[keyof typeof JOB_PRIORITIES]

export interface RefreshJob {
  id: string
  job_type: JobType
  platform: LeaderboardPlatform
  market_type: MarketType
  trader_key: string | null      // null for DISCOVER jobs
  window: Window | null          // null for non-snapshot jobs
  priority: number
  status: JobStatus
  attempts: number
  max_attempts: number
  next_run_at: string
  locked_at: string | null
  locked_by: string | null       // Worker instance ID
  last_error: string | null
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ============================================
// Platform Rate Limits
// ============================================

export interface PlatformRateLimit {
  platform: Platform
  requests_per_minute: number
  max_concurrency: number
  cooldown_until: string | null   // Circuit breaker cooldown
  consecutive_failures: number
  last_success_at: string | null
  last_failure_at: string | null
  updated_at: string
}

// ============================================
// API Response Types
// ============================================

/** Rankings API response */
export interface RankingsResponse {
  traders: RankingEntry[]
  meta: {
    platform: LeaderboardPlatform
    market_type: MarketType
    window: Window
    total_count: number
    updated_at: string
    staleness_seconds: number
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

/** Trader detail API response */
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
  /** Which windows are natively available */
  native_windows: Window[]
  /** Which fields are available */
  available_fields: (keyof SnapshotMetrics)[]
  /** Whether timeseries data is available */
  has_timeseries: boolean
  /** Whether profile enrichment is available */
  has_profiles: boolean
  /** Anti-scraping difficulty: 1=easy, 5=very hard */
  scraping_difficulty: 1 | 2 | 3 | 4 | 5
  /** Rate limit guidance */
  rate_limit: {
    rpm: number
    concurrency: number
  }
  /** Notes about this platform */
  notes: string[]
}

// ============================================
// Field Degradation Strategy
// ============================================

/** How to handle missing/incomparable fields */
export type FieldDegradation = {
  field: keyof SnapshotMetrics
  /** Reason the field is missing */
  reason: 'platform_not_provided' | 'different_calculation' | 'not_applicable' | 'fetch_failed'
  /** Human-readable explanation for UI tooltip */
  explanation_zh: string
  explanation_en: string
  /** Fallback behavior */
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
}
