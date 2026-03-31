/**
 * Central schema mapping module.
 *
 * Different database tables use different column names for the same concepts.
 * This module defines the canonical application-layer names and provides
 * mappings from each table's column names to canonical names.
 *
 * Canonical names (used in application code / UnifiedTrader):
 *   platform   — exchange identifier ('binance_futures', 'hyperliquid', etc.)
 *   traderKey  — trader's unique ID on the platform
 *   period     — time window ('7D', '30D', '90D')
 *   roi        — return on investment as percentage
 *   pnl        — profit and loss in USD
 *
 * DB column names vary by table:
 *   leaderboard_ranks:   source, source_trader_id, season_id, roi, pnl
 *   trader_snapshots_v2:  platform, trader_key, window, roi_pct, pnl_usd
 *   enrichment tables:    source, source_trader_id, season_id/period
 *   traders:              platform, trader_key
 */

// ============================================================
// Table-specific DB column → canonical app field mappings
// ============================================================

/**
 * leaderboard_ranks uses v1 naming conventions.
 * Keys = DB column names, Values = canonical app field names.
 */
export const LEADERBOARD_RANKS_FIELDS = {
  /** DB column `source` → canonical `platform` */
  source: 'platform',
  /** DB column `source_trader_id` → canonical `traderKey` */
  source_trader_id: 'traderKey',
  /** DB column `season_id` → canonical `period` */
  season_id: 'period',
  /** DB column `roi` → canonical `roi` (already percentage in this table) */
  roi: 'roi',
  /** DB column `pnl` → canonical `pnl` (already USD) */
  pnl: 'pnl',
} as const

/**
 * trader_snapshots_v2 uses the newer naming conventions.
 * Keys = DB column names, Values = canonical app field names.
 */
export const SNAPSHOTS_V2_FIELDS = {
  /** DB column `platform` → canonical `platform` */
  platform: 'platform',
  /** DB column `trader_key` → canonical `traderKey` */
  trader_key: 'traderKey',
  /** DB column `window` → canonical `period` */
  window: 'period',
  /** DB column `roi_pct` → canonical `roi` (already percentage) */
  roi_pct: 'roi',
  /** DB column `pnl_usd` → canonical `pnl` (already USD) */
  pnl_usd: 'pnl',
} as const

/**
 * Enrichment tables (trader_equity_curve, trader_stats_detail, etc.)
 * use v1 naming: source + source_trader_id + period/season_id.
 */
export const ENRICHMENT_FIELDS = {
  /** DB column `source` → canonical `platform` */
  source: 'platform',
  /** DB column `source_trader_id` → canonical `traderKey` */
  source_trader_id: 'traderKey',
  /** DB column `season_id` or `period` → canonical `period` */
  season_id: 'period',
  period: 'period',
} as const

/**
 * traders table (unified identity table) already uses canonical names.
 */
export const TRADERS_TABLE_FIELDS = {
  platform: 'platform',
  trader_key: 'traderKey',
} as const

// ============================================================
// Canonical types
// ============================================================

/** Canonical period values used across the system */
export type Period = '7D' | '30D' | '90D'

/** Canonical platform identifier */
export type Platform = string

// ============================================================
// DB column name constants for use in Supabase queries
// ============================================================

/**
 * Column name constants for leaderboard_ranks table.
 * Use these instead of magic strings when building Supabase queries
 * against leaderboard_ranks.
 *
 * Example:
 *   .eq(LR.source, platform)        // instead of .eq('source', platform)
 *   .eq(LR.season_id, '90D')        // instead of .eq('season_id', '90D')
 */
export const LR = {
  source: 'source',
  source_trader_id: 'source_trader_id',
  season_id: 'season_id',
  roi: 'roi',
  pnl: 'pnl',
  arena_score: 'arena_score',
  rank: 'rank',
  handle: 'handle',
  avatar_url: 'avatar_url',
  computed_at: 'computed_at',
} as const

/**
 * Column name constants for trader_snapshots_v2 table.
 */
export const V2 = {
  platform: 'platform',
  trader_key: 'trader_key',
  window: 'window',
  roi_pct: 'roi_pct',
  pnl_usd: 'pnl_usd',
  arena_score: 'arena_score',
} as const

/**
 * Column name constants for enrichment tables
 * (trader_equity_curve, trader_stats_detail, trader_position_history, etc.)
 */
export const ENRICH = {
  source: 'source',
  source_trader_id: 'source_trader_id',
  season_id: 'season_id',
  period: 'period',
} as const
