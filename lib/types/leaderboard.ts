/**
 * Canonical types for the multi-platform trader leaderboard system.
 *
 * Architecture invariants:
 * - All page loads read from DB only; no synchronous scraping on user click.
 * - Missing fields are nullable and UI uses degradation strategy.
 * - Every snapshot is keyed by (platform, trader_key, window, date_bucket).
 */

// ============================================
// Platform & Category Enums
// ============================================

export const LEADERBOARD_PLATFORMS = [
  'binance_futures',
  'binance_spot',
  'binance_web3',
  'bybit',
  'bitget_futures',
  'bitget_spot',
  'mexc',
  'coinex',
  'okx',
  'okx_wallet',
  'kucoin',
  'gmx',
  'dydx',
  'hyperliquid',
  'bitmart',
  'phemex',
  'htx',
  'weex',
] as const;

export type Platform = (typeof LEADERBOARD_PLATFORMS)[number];

/** Data supplement sources (not trading platforms) */
export const DATA_SOURCES = ['nansen', 'dune'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/** Trading category */
export type TradingCategory = 'futures' | 'spot' | 'onchain';

/** Ranking window */
export type RankingWindow = '7d' | '30d' | '90d';

/** Platform → category mapping */
export const PLATFORM_CATEGORY: Record<Platform, TradingCategory> = {
  binance_futures: 'futures',
  binance_spot: 'spot',
  binance_web3: 'onchain',
  bybit: 'futures',
  bitget_futures: 'futures',
  bitget_spot: 'spot',
  mexc: 'futures',
  coinex: 'futures',
  okx: 'futures',
  okx_wallet: 'onchain',
  kucoin: 'futures',
  gmx: 'onchain',
  dydx: 'onchain',
  hyperliquid: 'onchain',
  bitmart: 'futures',
  phemex: 'futures',
  htx: 'futures',
  weex: 'futures',
};

// ============================================
// Trader Identity
// ============================================

/** Unique identity for a trader on a specific platform */
export interface TraderIdentity {
  platform: Platform;
  trader_key: string; // platform-specific unique ID
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  discovered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

// ============================================
// Trader Profile (enriched display data)
// ============================================

export interface TraderProfileEnriched {
  platform: Platform;
  trader_key: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  /** Copier/follower count on platform */
  copier_count: number | null;
  /** Assets under management in USD */
  aum_usd: number | null;
  /** Trading since (ISO date) */
  active_since: string | null;
  /** Platform-specific badge or tier */
  platform_tier: string | null;
  last_enriched_at: string; // ISO timestamp
}

// ============================================
// Trader Snapshot (per-window performance)
// ============================================

/** Quality flags for a snapshot */
export interface SnapshotQuality {
  /** Did platform return all expected fields? */
  is_complete: boolean;
  /** Fields that are missing from source */
  missing_fields: string[];
  /** Confidence in data accuracy (0-1) */
  confidence: number;
  /** Whether this is interpolated from adjacent windows */
  is_interpolated: boolean;
}

/** Core metrics from a snapshot */
export interface SnapshotMetrics {
  roi_pct: number | null;
  pnl_usd: number | null;
  win_rate_pct: number | null;
  max_drawdown_pct: number | null;
  trades_count: number | null;
  copier_count: number | null;
  sharpe_ratio: number | null;
  sortino_ratio: number | null;
  volatility_pct: number | null;
  avg_holding_hours: number | null;
  profit_factor: number | null;
  /** Arena Score components */
  arena_score: number | null;
  return_score: number | null;
  drawdown_score: number | null;
  stability_score: number | null;
}

/** Full snapshot record */
export interface TraderSnapshot {
  id: string;
  platform: Platform;
  trader_key: string;
  window: RankingWindow;
  as_of_ts: string; // ISO timestamp (bucket boundary)
  metrics: SnapshotMetrics;
  quality: SnapshotQuality;
  created_at: string;
}

// ============================================
// Trader Timeseries
// ============================================

export type TimeseriesType = 'equity_curve' | 'drawdown' | 'daily_pnl' | 'position_count';

export interface TimeseriesPoint {
  ts: string; // ISO date or timestamp
  value: number;
}

export interface TraderTimeseries {
  id: string;
  platform: Platform;
  trader_key: string;
  series_type: TimeseriesType;
  /** Array of data points */
  data: TimeseriesPoint[];
  as_of_ts: string; // when this series was captured
  created_at: string;
}

// ============================================
// Refresh Job Queue
// ============================================

export type JobType = 'discovery' | 'snapshot' | 'profile' | 'timeseries' | 'full_refresh';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobPriority = 1 | 2 | 3 | 4 | 5; // 1 = highest

export interface RefreshJob {
  id: string;
  job_type: JobType;
  platform: Platform;
  trader_key: string | null; // null for discovery jobs
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  next_run_at: string; // ISO timestamp
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  /** Idempotency key: prevents duplicate jobs for same target+day */
  idempotency_key: string;
}

// ============================================
// API Request/Response Types
// ============================================

/** GET /api/rankings query params */
export interface RankingsQuery {
  window: RankingWindow;
  category?: TradingCategory;
  platform?: Platform;
  limit?: number;
  offset?: number;
  sort_by?: 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers';
  sort_dir?: 'asc' | 'desc';
  min_pnl?: number;
  min_trades?: number;
}

/** Single ranked trader in the response */
export interface RankedTraderRow {
  rank: number;
  platform: Platform;
  trader_key: string;
  display_name: string | null;
  avatar_url: string | null;
  category: TradingCategory;
  metrics: SnapshotMetrics;
  quality: SnapshotQuality;
  as_of_ts: string;
}

/** GET /api/rankings response */
export interface RankingsResponse {
  data: RankedTraderRow[];
  meta: {
    window: RankingWindow;
    category: TradingCategory | 'all';
    platform: Platform | 'all';
    total_count: number;
    limit: number;
    offset: number;
    cached_at: string;
    sort_by: string;
    sort_dir: string;
  };
}

/** GET /api/trader/:id response */
export interface TraderDetailResponse {
  identity: TraderIdentity;
  profile: TraderProfileEnriched | null;
  snapshots: Record<RankingWindow, TraderSnapshot | null>;
  timeseries: TraderTimeseries[];
  data_freshness: {
    last_snapshot_at: string | null;
    last_profile_at: string | null;
    last_timeseries_at: string | null;
    is_stale: boolean;
    stale_reason: string | null;
  };
}

/** POST /api/trader/:id/refresh response */
export interface RefreshResponse {
  job_id: string;
  status: JobStatus;
  estimated_wait_seconds: number | null;
  message: string;
}

// ============================================
// Connector Interface
// ============================================

/** What a platform connector must implement */
export interface PlatformConnector {
  platform: Platform;

  /** Discover traders on the leaderboard for a given window */
  discoverLeaderboard(window: RankingWindow): Promise<TraderIdentity[]>;

  /** Fetch performance snapshot for one trader */
  fetchTraderSnapshot(
    traderKey: string,
    window: RankingWindow,
  ): Promise<Omit<TraderSnapshot, 'id' | 'created_at'>>;

  /** Fetch enriched profile data */
  fetchTraderProfile(traderKey: string): Promise<Omit<TraderProfileEnriched, 'last_enriched_at'>>;

  /** Fetch timeseries data */
  fetchTimeseries(
    traderKey: string,
    seriesType: TimeseriesType,
  ): Promise<Omit<TraderTimeseries, 'id' | 'created_at'>>;
}

// ============================================
// Rate Limiter Config
// ============================================

export interface RateLimiterConfig {
  /** Max requests per window */
  max_requests: number;
  /** Window duration in ms */
  window_ms: number;
  /** Min delay between requests in ms */
  min_delay_ms: number;
  /** Max delay between requests in ms (for jitter) */
  max_delay_ms: number;
  /** Max concurrent requests */
  max_concurrent: number;
}

/** Per-platform rate limit defaults */
export const PLATFORM_RATE_LIMITS: Record<Platform, RateLimiterConfig> = {
  binance_futures: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  binance_spot: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  binance_web3: { max_requests: 20, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  bybit: { max_requests: 30, window_ms: 60_000, min_delay_ms: 2000, max_delay_ms: 5000, max_concurrent: 3 },
  bitget_futures: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  bitget_spot: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  mexc: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  coinex: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  okx: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  okx_wallet: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  kucoin: { max_requests: 20, window_ms: 60_000, min_delay_ms: 2500, max_delay_ms: 5000, max_concurrent: 2 },
  gmx: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  dydx: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  hyperliquid: { max_requests: 30, window_ms: 60_000, min_delay_ms: 1000, max_delay_ms: 3000, max_concurrent: 5 },
  bitmart: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  phemex: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  htx: { max_requests: 15, window_ms: 60_000, min_delay_ms: 3000, max_delay_ms: 6000, max_concurrent: 2 },
  weex: { max_requests: 10, window_ms: 60_000, min_delay_ms: 4000, max_delay_ms: 8000, max_concurrent: 1 },
};

// ============================================
// Prewarming & Scheduling Config
// ============================================

export interface PrewarmConfig {
  /** Top N traders to prewarm per platform */
  top_n: number;
  /** Refresh interval for top traders (ms) */
  top_interval_ms: number;
  /** Refresh interval for active traders (ms) */
  active_interval_ms: number;
  /** Refresh interval for long-tail traders (ms) */
  longtail_interval_ms: number;
}

export const DEFAULT_PREWARM_CONFIG: PrewarmConfig = {
  top_n: 100,
  top_interval_ms: 15 * 60 * 1000, // 15 min
  active_interval_ms: 60 * 60 * 1000, // 1 hour
  longtail_interval_ms: 4 * 60 * 60 * 1000, // 4 hours
};

// ============================================
// UI Degradation Helpers
// ============================================

/** Fields and their degradation behavior when missing */
export const FIELD_DEGRADATION: Record<keyof SnapshotMetrics, { label: string; fallback: string }> = {
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
};
