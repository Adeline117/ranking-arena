/**
 * Field mapping functions for converting database rows to UnifiedTrader.
 *
 * This module is the SINGLE place where DB column names are mapped to
 * canonical application-layer field names (UnifiedTrader).
 *
 * Schema mapping reference: @/lib/types/schema-mapping.ts
 *
 * Table column differences:
 *   leaderboard_ranks: source → platform, source_trader_id → traderKey, season_id → period
 *   enrichment tables: source → platform, source_trader_id → traderKey
 */

import type { UnifiedTrader, TradingPeriod } from './types'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
// Schema mapping reference: see LEADERBOARD_RANKS_FIELDS in
// '@/lib/types/schema-mapping' for the canonical column→field mapping documentation.

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

export type NormalizedScoreConfidence = 'full' | 'partial' | 'minimal' | 'insufficient'

/** Normalize legacy numeric completeness and current labels without inventing confidence. */
export function normalizeScoreConfidence(value: unknown): NormalizedScoreConfidence | null {
  if (value === 'full' || value === 'partial' || value === 'minimal' || value === 'insufficient') {
    return value
  }
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (
    typeof value === 'string' &&
    (value !== value.trim() || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))
  ) {
    return null
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) return null
  if (numeric >= 80) return 'full'
  if (numeric >= 50) return 'partial'
  return 'minimal'
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
// FIELD MAPPING — the single place where database/application differences live
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
  // Support both leaderboard_ranks (source/source_trader_id) and trader_unified_view (platform/trader_key)
  const platform = String(row.platform || row.source || '')
  return {
    // Identity
    platform,
    traderKey: String(row.trader_key || row.source_trader_id || ''),
    handle: (row.display_name as string) || (row.handle as string) || null,
    avatarUrl: (row.avatar_url as string) || null,
    profileUrl: (row.profile_url as string) || null,
    marketType:
      (row.market_type as string) ||
      (row.source_type as string) ||
      SOURCE_TYPE_MAP[platform] ||
      null,
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
    returnScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    pnlScore: row.risk_control_score != null ? Number(row.risk_control_score) : null, // V3: risk_control_score stores PnL sub-score (0-40)
    drawdownScore: null, // V3 scoring does not compute a separate drawdown sub-score
    stabilityScore: null, // V3 scoring does not compute a separate stability sub-score
    profitabilityScore: row.profitability_score != null ? Number(row.profitability_score) : null,
    riskControlScore: row.risk_control_score != null ? Number(row.risk_control_score) : null,
    executionScore: row.execution_score != null ? Number(row.execution_score) : null,
    scoreConfidence: normalizeScoreConfidence(row.score_completeness),

    // Rankings
    rank: row.rank != null ? Number(row.rank) : null,
    rankChange: row.rank_change != null ? Number(row.rank_change) : null,
    isNew: row.is_new === true,
    period: normalizePeriod((row.period || row.season_id) as string),

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
