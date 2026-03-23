/**
 * Shared defensive utilities for all Connector normalize() methods.
 *
 * Every numeric field in normalize() should use safeNumber() or safePercent()
 * to prevent NaN, Infinity, or type errors from reaching the DB.
 */

/**
 * Safely convert any value to a finite number, or null.
 * Handles: null, undefined, NaN, Infinity, strings, booleans.
 */
export function safeNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = typeof val === 'string' ? parseFloat(val) : Number(val)
  if (!Number.isFinite(n)) return null
  return n
}

/**
 * Safely convert a value to a percentage, with optional ratio detection.
 *
 * @param val - Raw value from API
 * @param options.isRatio - If true, always multiply by 100 (e.g., 0.5 → 50%)
 * @param options.maxReasonable - Filter outliers (default: 500000)
 */
export function safePercent(
  val: unknown,
  options?: { isRatio?: boolean; maxReasonable?: number }
): number | null {
  const n = safeNumber(val)
  if (n === null) return null
  const { isRatio = false, maxReasonable = 500000 } = options ?? {}
  const pct = isRatio ? n * 100 : n
  if (Math.abs(pct) > maxReasonable) return null
  return pct
}

/**
 * Safely convert a value to a non-negative number, or null.
 */
export function safeNonNeg(val: unknown): number | null {
  const n = safeNumber(val)
  if (n === null || n < 0) return null
  return n
}

/**
 * Safely convert a value to a positive integer, or null.
 */
export function safeInt(val: unknown): number | null {
  const n = safeNumber(val)
  if (n === null) return null
  return Math.round(n)
}

/**
 * Safe string extraction, returns null for empty/undefined.
 */
export function safeStr(val: unknown): string | null {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  return s.length > 0 ? s : null
}

/**
 * Convert max drawdown to absolute percentage (always positive).
 * Handles both ratio (0.08) and percent (8.0) formats.
 */
export function safeMdd(val: unknown, isRatio: boolean = false): number | null {
  const n = safeNumber(val)
  if (n === null) return null
  const abs = Math.abs(isRatio ? n * 100 : n)
  if (abs > 100) return null // MDD can't exceed 100%
  return abs
}

/**
 * Safely convert win rate to percentage (0-100).
 * Handles both ratio (0.65 → 65%) and percent (65.0%) formats.
 * Returns null for out-of-range values.
 */
export function safeWinRate(val: unknown): number | null {
  const n = safeNumber(val)
  if (n === null) return null
  // Auto-detect ratio vs percentage: values in (0, 1] are likely ratios
  const pct = (n > 0 && n <= 1) ? n * 100 : n
  // Must be 0-100%
  if (pct < 0 || pct > 100) return null
  return Math.round(pct * 100) / 100
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
