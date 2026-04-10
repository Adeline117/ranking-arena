/**
 * compute-leaderboard / trader-row
 *
 * Extracted from route.ts (2026-04-09) as part of the ~1400-line `computeSeason`
 * split flagged by Retro 2026-04-09 (69 modifications in 2 weeks). This module
 * owns the TraderRow shape and the boundary-sanitization rules that run on
 * every row before it enters the in-memory traderMap.
 *
 * Zero DB calls. Zero logger calls. Pure mutation helpers so the route file
 * can stop carrying 110 lines of data-cleaning noise.
 */

import { VALIDATION_BOUNDS as VB } from '@/lib/pipeline/types'

export interface TraderRow {
  source: string
  source_trader_id: string
  roi: number | null
  pnl: number | null
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  copiers: number | null
  arena_score: number | null
  captured_at: string
  full_confidence_at: string | null
  profitability_score: number | null
  risk_control_score: number | null
  execution_score: number | null
  score_completeness: string | null
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  profit_factor: number | null
  calmar_ratio: number | null
  trader_type: string | null
  metrics_estimated: boolean
}

/**
 * Sanitize a TraderRow in place against VALIDATION_BOUNDS + known bad-data
 * patterns. Runs once per row on intake, before dedup/merge. Anything out of
 * bounds becomes null so downstream scoring never sees absurd values.
 *
 * Exported only for testing — the normal call path is through
 * `makeAddToTraderMap` below.
 */
export function sanitizeTraderRow(snap: TraderRow): void {
  if (snap.source_trader_id.startsWith('0x')) {
    snap.source_trader_id = snap.source_trader_id.toLowerCase()
  }
  // Ensure metrics_estimated is initialized (v1 snapshots don't have this field)
  if (snap.metrics_estimated == null) snap.metrics_estimated = false

  // --- Boundary sanitization — uses VALIDATION_BOUNDS (single source of truth) ---
  if (snap.roi != null && (snap.roi < VB.roi_pct.min || snap.roi > VB.roi_pct.max)) {
    snap.roi = null
  }
  if (snap.win_rate != null && (snap.win_rate < VB.win_rate_pct.min || snap.win_rate > VB.win_rate_pct.max)) {
    snap.win_rate = null
  }
  if (snap.max_drawdown != null && (snap.max_drawdown < VB.max_drawdown_pct.min || snap.max_drawdown > VB.max_drawdown_pct.max)) {
    snap.max_drawdown = null
  }
  // Copin aggregator returns default WIN=80%/MDD=80% for traders without real data.
  // Detect: both are exactly 80 AND source is copin (trader_key has "protocol:" prefix).
  if (snap.win_rate === 80 && snap.max_drawdown === 80 && snap.source?.includes(':')) {
    snap.win_rate = null
    snap.max_drawdown = null
    snap.metrics_estimated = true
  }
  // MDD=0% with ROI > 50% is almost certainly missing data, not real zero drawdown.
  if (snap.max_drawdown === 0 && snap.roi != null && Math.abs(snap.roi) > 50) {
    snap.max_drawdown = null
  }
  // MDD < 1% with ROI > 500% is physically implausible — enrichment likely computed
  // from a tiny subset of trades (e.g. 43 out of 523). Null it out.
  if (snap.max_drawdown != null && snap.max_drawdown < 1 && snap.roi != null && snap.roi > 500) {
    snap.max_drawdown = null
  }
  // Sharpe ratio: uses VALIDATION_BOUNDS (was hardcoded ±20, now ±10)
  if (snap.sharpe_ratio != null && (snap.sharpe_ratio < VB.sharpe_ratio.min || snap.sharpe_ratio > VB.sharpe_ratio.max)) {
    snap.sharpe_ratio = null
  }
  // Win rate sanity: null out contradictory values
  // - WR=0% with positive ROI is impossible (at least one winning trade)
  // - WR=100% with negative ROI is impossible
  // - WR=100% with trades < 2 is statistically meaningless
  if (snap.win_rate != null && snap.roi != null) {
    if (snap.win_rate === 0 && snap.roi > 10) { snap.win_rate = null }
    else if (snap.win_rate >= 100 && snap.roi < -10) { snap.win_rate = null }
  }
  if (snap.win_rate != null && snap.win_rate >= 100 && snap.trades_count != null && snap.trades_count < 2) {
    snap.win_rate = null
  }
  // WR=100% with no trade count info is unverifiable — null it out
  if (snap.win_rate != null && snap.win_rate >= 100 && (snap.trades_count == null || snap.trades_count === 0)) {
    snap.win_rate = null
  }
}

/**
 * Factory: returns a function that sanitizes + dedup-merges a TraderRow into
 * the given traderMap. On key collision (same source+id), missing fields on
 * the existing entry are backfilled from the incoming row (null-safe merge).
 *
 * Usage:
 *   const traderMap = new Map<string, TraderRow>()
 *   const addToTraderMap = makeAddToTraderMap(traderMap)
 *   for (const row of fetchedRows) addToTraderMap(row)
 */
export function makeAddToTraderMap(
  traderMap: Map<string, TraderRow>,
): (snap: TraderRow) => void {
  return function addToTraderMap(snap: TraderRow) {
    sanitizeTraderRow(snap)

    const key = `${snap.source}:${snap.source_trader_id}`
    if (!traderMap.has(key)) {
      traderMap.set(key, snap)
      return
    }
    // Merge: fill null fields from the duplicate
    const existing = traderMap.get(key)!
    if (snap.win_rate != null && existing.win_rate == null) existing.win_rate = snap.win_rate
    if (snap.max_drawdown != null && existing.max_drawdown == null) existing.max_drawdown = snap.max_drawdown
    if (snap.trades_count != null && existing.trades_count == null) existing.trades_count = snap.trades_count
    if (snap.followers != null && existing.followers == null) existing.followers = snap.followers
    if (snap.sharpe_ratio != null && existing.sharpe_ratio == null) existing.sharpe_ratio = snap.sharpe_ratio
    if (snap.profitability_score != null && existing.profitability_score == null) existing.profitability_score = snap.profitability_score
    if (snap.risk_control_score != null && existing.risk_control_score == null) existing.risk_control_score = snap.risk_control_score
    if (snap.execution_score != null && existing.execution_score == null) existing.execution_score = snap.execution_score
    if (snap.sortino_ratio != null && existing.sortino_ratio == null) existing.sortino_ratio = snap.sortino_ratio
    if (snap.profit_factor != null && existing.profit_factor == null) existing.profit_factor = snap.profit_factor
    if (snap.calmar_ratio != null && existing.calmar_ratio == null) existing.calmar_ratio = snap.calmar_ratio
    if (snap.trading_style != null && existing.trading_style == null) existing.trading_style = snap.trading_style
    if (snap.avg_holding_hours != null && existing.avg_holding_hours == null) existing.avg_holding_hours = snap.avg_holding_hours
    if (snap.trader_type != null && existing.trader_type == null) existing.trader_type = snap.trader_type
    if (snap.full_confidence_at &&
        (!existing.full_confidence_at || snap.full_confidence_at > existing.full_confidence_at)) {
      existing.full_confidence_at = snap.full_confidence_at
    }
  }
}
