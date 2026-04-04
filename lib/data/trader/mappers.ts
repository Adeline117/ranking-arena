/**
 * Field mapping functions for converting database rows to UnifiedTrader.
 *
 * This module is the SINGLE place where DB column names are mapped to
 * canonical application-layer field names (UnifiedTrader).
 *
 * Schema mapping reference: @/lib/types/schema-mapping.ts
 *
 * Table column differences:
 *   leaderboard_ranks:  source → platform, source_trader_id → traderKey, season_id → period
 *   trader_snapshots_v2: platform → platform, trader_key → traderKey, window → period
 *   enrichment tables:  source → platform, source_trader_id → traderKey
 */

import type { UnifiedTrader, TradingPeriod } from './types'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
// Schema mapping reference: see LEADERBOARD_RANKS_FIELDS and SNAPSHOTS_V2_FIELDS
// in '@/lib/types/schema-mapping' for the canonical column→field mapping documentation.

// ============================================================
// Period normalization
// ============================================================

/** Normalize window/season_id values to canonical TradingPeriod */
export function normalizePeriod(raw: string | null | undefined): TradingPeriod {
  if (!raw) return '90D'
  const upper = raw.toUpperCase()
  if (upper === '7D') return '7D'
  if (upper === '30D') return '30D'
  return '90D'
}

// ============================================================
// Win rate normalization (ratio -> percentage)
// ============================================================

/** Normalize win_rate: if <=1, treat as ratio and multiply by 100. Clamp to 0-100. */
export function normalizeWinRate(wr: number | null | undefined): number | null {
  if (wr == null) return null
  const pct = wr <= 1 ? wr * 100 : wr
  return Math.max(0, Math.min(100, pct))
}

// ============================================================
// Source alias mapping for enrichment tables
// ============================================================

/**
 * Legacy source name mapping: some tables (equity_curve, position_history, etc.)
 * use old source names like 'binance' instead of 'binance_futures'.
 */
export const SOURCE_ALIASES: Record<string, string[]> = {
  binance_futures: ['binance', 'binance_futures'],
  bitget_futures: ['bitget', 'bitget_futures'],
  binance_spot: ['binance_spot'],
  bitget_spot: ['bitget_spot'],
  bybit: ['bybit'],
  bybit_spot: ['bybit_spot'],
  okx_futures: ['okx_futures'],
  okx_spot: ['okx_spot'],
  okx_web3: ['okx', 'okx_web3'],
  okx_wallet: ['okx_wallet'],
  mexc: ['mexc'],
  kucoin: ['kucoin'],
  coinex: ['coinex'],
  htx_futures: ['htx_futures', 'htx'],
  weex: ['weex'],
  phemex: ['phemex'],
  bingx: ['bingx'],
  gateio: ['gateio'],
  xt: ['xt'],
  lbank: ['lbank'],
  blofin: ['blofin'],
  bitmart: ['bitmart'],
  hyperliquid: ['hyperliquid'],
  gmx: ['gmx'],
  dydx: ['dydx'],
  gains: ['gains'],
  jupiter_perps: ['jupiter_perps'],
  aevo: ['aevo'],
  binance_web3: ['binance_web3'],
  web3_bot: ['web3_bot'],
  drift: ['drift'],
  btcc: ['btcc'],
  bitunix: ['bitunix'],
  bitfinex: ['bitfinex'],
  toobit: ['toobit'],
  etoro: ['etoro'],
  kwenta: ['kwenta'],
}

export function getSourceAliases(platform: string): string[] {
  return SOURCE_ALIASES[platform] || [platform]
}

// ============================================================
// FIELD MAPPING — the single place where v1/v2/lr differences live
// ============================================================

/**
 * Map leaderboard_ranks row -> UnifiedTrader.
 *
 * DB column → App field (see LEADERBOARD_RANKS_FIELDS in schema-mapping.ts):
 *   source           → platform
 *   source_trader_id → traderKey
 *   season_id        → period
 *   roi              → roi (already percentage in this table)
 *   pnl              → pnl (already USD)
 */
export function mapLeaderboardRow(row: Record<string, unknown>): UnifiedTrader {
  const platform = String(row.source || '')
  return {
    // Identity
    platform,
    traderKey: String(row.source_trader_id || ''),
    handle: (row.handle as string) || null,
    avatarUrl: (row.avatar_url as string) || null,
    profileUrl: null, // leaderboard_ranks does not store profile_url
    marketType: (row.source_type as string) || SOURCE_TYPE_MAP[platform] || null,
    sourceType: SOURCE_TYPE_MAP[platform] || null,

    // Performance — leaderboard_ranks stores roi as percentage already
    roi: row.roi != null ? Number(row.roi) : null,
    pnl: row.pnl != null ? Number(row.pnl) : null,
    winRate: normalizeWinRate(row.win_rate as number | null),
    maxDrawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    copiers: row.copiers != null ? Number(row.copiers) : null,

    // Scores
    arenaScore: row.arena_score != null ? Number(row.arena_score) : null,
    returnScore: row.return_score != null ? Number(row.return_score) : row.profitability_score != null ? Number(row.profitability_score) : null,
    pnlScore: row.pnl_score != null ? Number(row.pnl_score) : row.score_completeness != null ? Number(row.score_completeness) : null,
    drawdownScore: row.drawdown_score != null ? Number(row.drawdown_score) : row.risk_control_score != null ? Number(row.risk_control_score) : null,
    stabilityScore: row.stability_score != null ? Number(row.stability_score) : row.execution_score != null ? Number(row.execution_score) : null,
    profitabilityScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    riskControlScore: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    executionScore: row.execution_score != null ? Number(row.execution_score) : null,
    scoreConfidence: row.score_completeness != null
      ? (Number(row.score_completeness) >= 80 ? 'full' : Number(row.score_completeness) >= 50 ? 'partial' : 'minimal')
      : null,

    // Rankings
    rank: row.rank != null ? Number(row.rank) : null,
    period: normalizePeriod(row.season_id as string),

    // Advanced metrics
    sharpeRatio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    sortinoRatio: row.sortino_ratio != null ? Number(row.sortino_ratio) : null,
    profitFactor: row.profit_factor != null ? Number(row.profit_factor) : null,
    calmarRatio: row.calmar_ratio != null ? Number(row.calmar_ratio) : null,
    tradingStyle: (row.trading_style as string) || null,
    avgHoldingHours: row.avg_holding_hours != null ? Number(row.avg_holding_hours) : null,

    // Metadata
    traderType: (row.trader_type as string) || (platform === 'web3_bot' ? 'bot' : null),
    isOutlier: row.is_outlier === true,
    lastUpdated: (row.computed_at as string) || null,
  }
}

/**
 * Map trader_snapshots v1 row -> Partial<UnifiedTrader>.
 * v1 uses: source, source_trader_id, season_id
 * IMPORTANT: v1 roi is stored as a RATIO (0.5 = 50%), must multiply by 100 for percentage.
 */
export function mapV1Snapshot(row: Record<string, unknown>, period: TradingPeriod): Partial<UnifiedTrader> {
  return {
    platform: String(row.source || ''),
    traderKey: String(row.source_trader_id || ''),
    // v1 ROI is ratio — multiply by 100 to get percentage
    roi: row.roi != null ? Number(row.roi) * 100 : null,
    pnl: row.pnl != null ? Number(row.pnl) : null,
    winRate: normalizeWinRate(row.win_rate as number | null),
    maxDrawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    arenaScore: row.arena_score != null ? Number(row.arena_score) : null,
    returnScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    pnlScore: row.score_completeness != null ? Number(row.score_completeness) : null,
    drawdownScore: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    stabilityScore: row.execution_score != null ? Number(row.execution_score) : null,
    profitabilityScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    riskControlScore: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    executionScore: row.execution_score != null ? Number(row.execution_score) : null,
    period,
    lastUpdated: (row.captured_at as string) || null,
  }
}

/**
 * Map trader_snapshots_v2 row -> Partial<UnifiedTrader>.
 *
 * DB column → App field (see SNAPSHOTS_V2_FIELDS in schema-mapping.ts):
 *   platform    → platform  (same name)
 *   trader_key  → traderKey
 *   window      → period
 *   roi_pct     → roi (already percentage)
 *   pnl_usd     → pnl (already USD)
 */
export function mapV2Snapshot(row: Record<string, unknown>, period?: TradingPeriod): Partial<UnifiedTrader> {
  return {
    platform: String(row.platform || ''),
    traderKey: String(row.trader_key || ''),
    // v2 roi_pct is already percentage
    roi: row.roi_pct != null ? Number(row.roi_pct) : null,
    pnl: row.pnl_usd != null ? Number(row.pnl_usd) : null,
    winRate: normalizeWinRate(row.win_rate as number | null),
    maxDrawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
    tradesCount: row.trades_count != null ? Number(row.trades_count) : null,
    followers: row.followers != null ? Number(row.followers) : null,
    copiers: row.copiers != null ? Number(row.copiers) : null,
    sharpeRatio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
    arenaScore: row.arena_score != null ? Number(row.arena_score) : null,
    period: period || normalizePeriod(row.window as string),
    lastUpdated: (row.created_at as string) || null,
  }
}
