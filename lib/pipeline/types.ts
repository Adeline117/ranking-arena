/**
 * Arena Data Pipeline - Core Type Definitions
 *
 * 四层架构的统一数据结构定义
 * Layer 1: Scraper (RawFetchResult)
 * Layer 2: Normalizer (StandardTraderData)
 * Layer 3: Calculator (EnrichedTraderData)
 * Layer 4: Storage (PersistResult)
 */

// =============================================================================
// Layer 1: Scraper Types (采集层)
// =============================================================================

/**
 * 原始 API 响应，不做任何处理
 */
export interface RawTraderEntry {
  trader_id: string
  raw_data: Record<string, unknown>
}

/**
 * 采集结果
 */
export interface RawFetchResult {
  platform: string
  market_type: 'futures' | 'perp' | 'spot'
  window: '7d' | '30d' | '90d' | 'all_time'
  raw_traders: RawTraderEntry[]
  total_available: number
  fetched_at: Date
  api_latency_ms: number
  error?: string
}

// =============================================================================
// Layer 2: Normalizer Types (标准化层)
// =============================================================================

export type TimeWindow = '7d' | '30d' | '90d'
export type DataSource = 'api' | 'scraper' | 'computed'
export type Confidence = 'full' | 'partial' | 'minimal'

/**
 * 标准化后的交易员数据
 * 所有字段都是统一格式：
 * - ROI: 百分比 (25.5 = 25.5%)
 * - PnL: USD
 * - Win Rate: 百分比 (65.0 = 65%)
 * - Max Drawdown: 百分比 (15.0 = 15%)
 */
export interface StandardTraderData {
  // Identity
  platform: string
  trader_id: string
  display_name: string | null
  avatar_url: string | null

  // Core Metrics (标准化单位)
  roi_pct: number | null // 百分比, e.g. 25.5 = 25.5%
  pnl_usd: number | null // USD
  win_rate_pct: number | null // 百分比, 0-100
  max_drawdown_pct: number | null // 百分比, 0-100

  // Social (CEX only, DEX = null)
  followers: number | null
  copiers: number | null
  aum_usd: number | null

  // Activity
  trades_count: number | null
  avg_holding_hours: number | null

  // Metadata
  window: TimeWindow
  data_source: DataSource
  confidence: Confidence
  normalized_at: Date
}

// =============================================================================
// Layer 3: Calculator Types (计算层)
// =============================================================================

export type TraderType = 'human' | 'bot' | null

export interface ArenaScoreComponents {
  return_score: number // 0-60
  pnl_score: number // 0-40
}

/**
 * 计算完成后的交易员数据
 * 包含 Arena Score、排名、高级指标
 */
export interface EnrichedTraderData extends StandardTraderData {
  // Computed Scores
  arena_score: number // 0-100
  arena_score_components: ArenaScoreComponents

  // Ranking (within platform + window)
  platform_rank: number | null

  // Advanced Metrics
  sharpe_ratio: number | null
  sortino_ratio: number | null

  // Classification
  trader_type: TraderType

  // Enrichment Metadata
  enriched_at: Date
}

// =============================================================================
// Layer 4: Storage Types (存储层)
// =============================================================================

export interface PersistResult {
  upserted: number
  errors: number
  details?: {
    sources_upserted: number
    snapshots_upserted: number
  }
}

// =============================================================================
// Platform Capabilities (平台能力声明)
// =============================================================================

export type RoiFormat = 'percentage' | 'decimal' | 'needs_detection'
export type PnlUnit = 'usd' | 'wei' | 'native_token'

export interface PlatformFields {
  roi: boolean
  pnl: boolean
  win_rate: boolean
  max_drawdown: boolean
  followers: boolean
  copiers: boolean
  aum: boolean
  trades_count: boolean
  equity_curve: boolean
  position_history: boolean
}

export interface PlatformApiConfig {
  rate_limit_rpm: number
  timeout_ms: number
  requires_auth: boolean
  geo_restricted: boolean
  proxy_required: boolean
}

export interface PlatformFormatConfig {
  roi_format: RoiFormat
  pnl_unit: PnlUnit
  pnl_decimals?: number // for wei conversion
}

export interface PlatformCapabilities {
  // 支持的时间窗口
  supported_windows: ('7d' | '30d' | '90d' | 'all_time')[]

  // 可获取的字段
  fields: PlatformFields

  // API 特性
  api: PlatformApiConfig

  // 数据格式说明
  format: PlatformFormatConfig
}

// =============================================================================
// Pipeline Result Types
// =============================================================================

export interface PipelineStepResult {
  platform: string
  status: 'success' | 'error' | 'skipped'
  traders_count?: number
  upserted?: number
  duration_ms?: number
  error?: string
}

export interface PipelineRunResult {
  run_id: string
  started_at: Date
  finished_at: Date
  steps: PipelineStepResult[]
  summary: {
    total_platforms: number
    successful: number
    failed: number
    total_traders: number
    total_upserted: number
  }
}

// =============================================================================
// Arena Score Config
// =============================================================================

export interface ArenaScoreWindowConfig {
  tanhCoeff: number
  roiExponent: number
  pnlCoeff: number
  pnlBase: number
}

export const ARENA_SCORE_CONFIG: Record<TimeWindow, ArenaScoreWindowConfig> = {
  '7d': { tanhCoeff: 0.08, roiExponent: 1.8, pnlCoeff: 0.42, pnlBase: 300 },
  '30d': { tanhCoeff: 0.15, roiExponent: 1.6, pnlCoeff: 0.30, pnlBase: 600 },
  '90d': { tanhCoeff: 0.18, roiExponent: 1.6, pnlCoeff: 0.27, pnlBase: 650 },
}

export const CONFIDENCE_MULTIPLIER: Record<Confidence, number> = {
  full: 1.0,
  partial: 0.85,
  minimal: 0.7,
}

// =============================================================================
// Overall Score Weights
// =============================================================================

export const OVERALL_WEIGHTS: Record<TimeWindow, number> = {
  '90d': 0.7,
  '30d': 0.25,
  '7d': 0.05,
}

// =============================================================================
// Validation Bounds
// =============================================================================

/**
 * Canonical validation bounds — THE SINGLE SOURCE OF TRUTH.
 *
 * Every validator (validate-before-write, connector-db-adapter, compute-leaderboard)
 * MUST import from here. These match the DB CHECK constraints exactly.
 * If you change a bound here, also update the DB constraint migration.
 */
export const VALIDATION_BOUNDS = {
  roi_pct: { min: -10000, max: 10000 },
  pnl_usd: { min: -10_000_000, max: 100_000_000 },
  pnl_usd_dex_whale: { min: -10_000_000, max: 1_000_000_000 },
  win_rate_pct: { min: 0, max: 100 },
  max_drawdown_pct: { min: 0, max: 100 },
  sharpe_ratio: { min: -20, max: 20 },
  arena_score: { min: 0, max: 100 },
  trades_count: { min: 0 },
  followers: { min: 0 },
  copiers: { min: 0 },
} as const

/**
 * Data quality boundary — the date before which snapshot data was unvalidated.
 *
 * validate-snapshot.ts was added 2026-04-01. ALL data written before this date
 * may contain invalid values (extreme ROI, ROI=PnL, wrong decimal scale, etc.).
 *
 * Consumers computing derived metrics (Sharpe, WR, MDD, Beta) MUST use this
 * as a lower bound for their date range queries. Import from here — do NOT
 * hardcode '2026-04-01' in individual files.
 *
 * This boundary becomes irrelevant once it's >90 days old (falls off the
 * rolling window). Can be removed after 2026-07-01.
 *
 * TODO(2026-07-01): Remove this constant and all references to it.
 * Grep for DATA_QUALITY_BOUNDARY to find all consumers.
 */
export const DATA_QUALITY_BOUNDARY = '2026-04-01'
