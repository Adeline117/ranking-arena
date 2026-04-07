/**
 * Connector Normalize Contract
 *
 * THE DEFINITIVE INTERFACE for what normalize() must return.
 * All 40 connectors must conform to this contract.
 *
 * Also provides utility functions for common normalization tasks
 * (ROI format detection, percent parsing) to eliminate per-connector heuristics.
 */

import { VALIDATION_BOUNDS } from '@/lib/pipeline/types'

// ═══════════════════════════════════════════════════════
// The Contract
// ═══════════════════════════════════════════════════════

/**
 * Every connector.normalize() MUST return this shape.
 * Fields are nullable — missing data is null, not undefined.
 */
export interface NormalizedTrader {
  // ── Identity (required) ──
  trader_key: string | null
  display_name: string | null
  avatar_url: string | null
  profile_url?: string | null

  // ── Core metrics (all as percentages / USD) ──
  /** ROI in percentage points (25 = 25%, NOT 0.25) */
  roi: number | null
  /** PnL in USD */
  pnl: number | null
  /** Win rate as percentage (60 = 60%) */
  win_rate: number | null
  /** Max drawdown as percentage (20 = 20%) */
  max_drawdown: number | null
  /** Sharpe ratio (dimensionless) */
  sharpe_ratio: number | null

  // ── Social ──
  followers: number | null
  copiers: number | null
  trades_count: number | null
  /** Assets under management in USD */
  aum: number | null
  platform_rank: number | null

  // ── Enrichment inline data (optional, underscore-prefixed) ──
  _daily_pnl?: unknown[]
  _curve_time?: number[]
  _curve_values?: number[]
  _pnl_curve_values?: number[]
  _profit_rate_series?: unknown[]
  _profit_list?: unknown[]
  _contract_rate_list?: unknown[]
  _top_earning_tokens?: unknown[]
  _trader_insts?: string[]
}

// ═══════════════════════════════════════════════════════
// ROI Format Detection — SINGLE SOURCE OF TRUTH
// ═══════════════════════════════════════════════════════

/**
 * Detect whether a raw ROI value is decimal (0.35 = 35%) or percentage (35 = 35%).
 *
 * RULE: If |value| <= 5, treat as decimal and multiply by 100.
 *       If |value| > 5, treat as already percentage.
 *
 * Why 5 (not 1 or 10):
 * - Threshold ≤1 misses legitimate 2-5% ROI in decimal format (common for DEX)
 * - Threshold ≤10 misclassifies legitimate 6-10% ROI as decimal (doubles it to 12-20%)
 * - Threshold 5 is the Goldilocks zone: catches 0.35 (35%) but not 7 (7%)
 *
 * IMPORTANT: Use this instead of per-connector magic numbers.
 * Previously: bingx used ≤1, hyperliquid used ≤10, gains used <10, mexc used ≤1
 * Now: ALL connectors use this single function.
 */
export function normalizeRoiFormat(rawRoi: number | null | undefined): number | null {
  if (rawRoi == null || !Number.isFinite(rawRoi)) return null
  const val = Number(rawRoi)
  // Heuristic: small values are likely decimals (0.35 = 35%)
  return Math.abs(val) <= 5 ? val * 100 : val
}

/**
 * Safe numeric extraction — returns null for NaN, Infinity, undefined.
 */
export function safeNum(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Parse a percentage string like "+1044.26%" or "34.66%" to a number.
 */
export function parsePercent(value: unknown): number | null {
  if (value == null) return null
  const str = String(value).replace(/[%,+\s]/g, '')
  const n = Number(str)
  return Number.isFinite(n) ? n : null
}

/**
 * Clamp a value to VALIDATION_BOUNDS range, returning null if outside.
 * Use this in normalize() for fields that have known bounds.
 */
export function clampOrNull(
  value: number | null,
  field: keyof typeof VALIDATION_BOUNDS,
): number | null {
  if (value == null) return null
  const bounds = VALIDATION_BOUNDS[field]
  if ('min' in bounds && 'max' in bounds) {
    if (value < bounds.min || value > bounds.max) return null
  } else if ('min' in bounds) {
    if (value < bounds.min) return null
  }
  return value
}
