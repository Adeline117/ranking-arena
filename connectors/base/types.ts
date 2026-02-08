/**
 * Canonical types for the connector framework
 * All platform connectors normalize data to these types
 */

// ============================================
// Platform & Market Types
// ============================================

export type Platform =
  | 'binance' | 'bybit' | 'bitget' | 'mexc' | 'coinex'
  | 'okx' | 'okx_wallet' | 'kucoin' | 'bitmart' | 'phemex'
  | 'htx' | 'weex'
  | 'gmx' | 'dydx' | 'hyperliquid'
  | 'nansen' | 'dune'
  // Dune on-chain leaderboards
  | 'dune_gmx' | 'dune_hyperliquid' | 'dune_uniswap' | 'dune_defi';

export type MarketType = 'futures' | 'spot' | 'web3' | 'perp' | 'enrichment';

export type Window = '7d' | '30d' | '90d';

export type JobType = 'DISCOVER' | 'SNAPSHOT' | 'PROFILE' | 'TIMESERIES';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead';

export type PlatformHealthStatus = 'healthy' | 'degraded' | 'circuit_open';

// ============================================
// Source Discovery
// ============================================

export interface SourceConfig {
  platform: Platform;
  market_type: MarketType;
  leaderboard_endpoints: EndpointConfig[];
  profile_endpoints: EndpointConfig[];
  window_support: Window[];
  rate_limit_hint: RateLimitHint;
  field_map: Record<string, string>;
  roi_sort_supported: boolean;
  roi_sort_method: 'query_param' | 'route' | 'ui_state' | 'not_supported';
  proof: ProofEntry[];
}

export interface EndpointConfig {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body_template?: Record<string, unknown>;
  query_params?: Record<string, string>;
  pagination?: PaginationConfig;
  response_path?: string; // JSONPath to data array
  window_param?: string; // How to set window in request
  sort_param?: string; // How to set sort in request
}

export interface PaginationConfig {
  type: 'offset' | 'cursor' | 'page';
  page_size: number;
  max_pages: number;
  param_name: string;
}

export interface RateLimitHint {
  rpm: number;
  concurrent: number;
  delay_ms: number;
}

export interface ProofEntry {
  url: string;
  request_path: string;
  method: string;
  response_fields_sample: Record<string, unknown>;
  discovered_at: string;
}

// ============================================
// Canonical Data Models
// ============================================

export interface CanonicalTrader {
  platform: Platform;
  market_type: MarketType;
  trader_key: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
}

export interface CanonicalSnapshot {
  platform: Platform;
  market_type: MarketType;
  trader_key: string;
  window: Window;
  as_of_ts: string; // ISO timestamp
  metrics: SnapshotMetrics;
  quality_flags: QualityFlags;
  provenance: Provenance;
}

export interface SnapshotMetrics {
  roi_pct: number | null;
  pnl_usd: number | null;
  win_rate: number | null;
  max_drawdown: number | null;
  trades_count: number | null;
  followers: number | null;
  copiers: number | null;
  sharpe_ratio: number | null;
  aum: number | null;
  /** How ROI is calculated: realized (closed P&L only), unrealized (includes open), or mixed */
  roi_type?: 'realized' | 'unrealized' | 'mixed';
  // Platform-specific extras stored here
  [key: string]: unknown;
}

export interface CanonicalProfile {
  platform: Platform;
  market_type: MarketType;
  trader_key: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  tags: string[];
  profile_url: string | null;
  followers: number | null;
  copiers: number | null;
  aum: number | null;
  provenance: Provenance;
}

export interface CanonicalTimeseries {
  platform: Platform;
  market_type: MarketType;
  trader_key: string;
  series_type: 'equity_curve' | 'daily_pnl' | 'positions';
  as_of_ts: string;
  data: TimeseriesPoint[];
  provenance: Provenance;
}

export interface TimeseriesPoint {
  ts: string;
  value: number;
  [key: string]: unknown;
}

// ============================================
// Quality & Provenance
// ============================================

export interface QualityFlags {
  missing_roi?: boolean;
  missing_pnl?: boolean;
  missing_drawdown?: boolean;
  missing_win_rate?: boolean;
  missing_sharpe?: boolean;
  missing_trades_count?: boolean;
  stale_data?: boolean;
  platform_default_sort?: boolean;
  window_not_supported?: boolean;
  estimated_value?: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface Provenance {
  source_url?: string;
  fetched_at: string;
  connector_version: string;
  platform_sorting?: 'roi_desc' | 'default';
  platform_window?: string;
  reason?: string;
  raw_fields?: string[];
  [key: string]: unknown;
}

// ============================================
// Connector Interface
// ============================================

export interface LeaderboardEntry {
  trader_key: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  rank: number | null;
  metrics: Partial<SnapshotMetrics>;
  raw: Record<string, unknown>;
}

export interface ConnectorResult<T> {
  success: boolean;
  data: T | null;
  error?: string;
  quality_flags: QualityFlags;
  provenance: Provenance;
}

export interface IConnector {
  platform: Platform;
  market_type: MarketType;

  /** Discover leaderboard traders */
  discoverLeaderboard(window: Window, limit?: number): Promise<ConnectorResult<LeaderboardEntry[]>>;

  /** Fetch individual trader profile */
  fetchTraderProfile(trader_key: string): Promise<ConnectorResult<CanonicalProfile>>;

  /** Fetch trader performance snapshot for a window */
  fetchTraderSnapshot(trader_key: string, window: Window): Promise<ConnectorResult<CanonicalSnapshot>>;

  /** Fetch trader timeseries data (equity curve, etc.) */
  fetchTimeseries(trader_key: string): Promise<ConnectorResult<CanonicalTimeseries[]>>;

  /** Normalize raw platform data to canonical format */
  normalize(raw: Record<string, unknown>, field_map?: Record<string, string>): Partial<SnapshotMetrics>;
}

// ============================================
// Worker Types
// ============================================

export interface RefreshJob {
  id: string;
  job_type: JobType;
  platform: Platform;
  market_type: MarketType;
  trader_key: string | null;
  priority: number;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerConfig {
  worker_id: string;
  poll_interval_ms: number;
  platforms: Platform[];
  max_concurrent: number;
  rate_limits: Record<Platform, RateLimitHint>;
}

// ============================================
// API Response Types
// ============================================

export interface RankingResponse {
  data: RankingEntry[];
  meta: {
    total: number;
    window: Window;
    platform: Platform | 'all';
    market_type: MarketType | 'all';
    sort: string;
    updated_at: string;
    staleness: boolean;
  };
}

export interface RankingEntry {
  rank: number;
  platform: Platform;
  market_type: MarketType;
  trader_key: string;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  roi_pct: number | null;
  pnl_usd: number | null;
  win_rate: number | null;
  max_drawdown: number | null;
  trades_count: number | null;
  followers: number | null;
  arena_score: number | null;
  updated_at: string;
  staleness: boolean;
  quality_flags: QualityFlags;
  provenance: Provenance;
}

export interface TraderDetailResponse {
  profile: CanonicalProfile;
  snapshots: Record<Window, CanonicalSnapshot | null>;
  updated_at: string;
  staleness: boolean;
  provenance: Provenance;
  quality_flags: QualityFlags;
}
