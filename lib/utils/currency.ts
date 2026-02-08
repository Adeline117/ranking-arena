/**
 * Currency.js utility wrapper for precise financial calculations.
 *
 * Use these helpers whenever you need accurate money arithmetic
 * (PnL sums, balance calculations, percentage rounding) to avoid
 * floating-point drift.
 */
import currency from 'currency.js'

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Add two monetary values with precision. */
export function moneyAdd(a: number, b: number): number {
  return currency(a).add(b).value
}

/** Subtract b from a with precision. */
export function moneySub(a: number, b: number): number {
  return currency(a).subtract(b).value
}

/** Multiply a monetary value by a factor. */
export function moneyMul(a: number, factor: number): number {
  return currency(a).multiply(factor).value
}

/** Divide a monetary value by a divisor. */
export function moneyDiv(a: number, divisor: number): number {
  if (divisor === 0) return 0
  return currency(a).divide(divisor).value
}

/** Sum an array of numbers with precision. */
export function moneySum(values: number[]): number {
  return values.reduce((acc, v) => currency(acc).add(v), currency(0)).value
}

// ---------------------------------------------------------------------------
// Rounding helpers
// ---------------------------------------------------------------------------

/** Round a number to N decimal places using currency.js precision. */
export function roundTo(value: number, decimals: number): number {
  return currency(value, { precision: decimals }).value
}

/**
 * Round to 2 decimal places.
 * Drop-in replacement for the common `Math.round(x * 100) / 100` pattern.
 */
export function round2(value: number): number {
  return currency(value).value
}

/**
 * Round to 1 decimal place.
 * Drop-in replacement for `Math.round(x * 10) / 10`.
 */
export function round1(value: number): number {
  return currency(value, { precision: 1 }).value
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure display — no locale side-effects)
// ---------------------------------------------------------------------------

/** Format a number as a dollar string, e.g. "$1,234.56". */
export function formatUSD(amount: number, decimals = 2): string {
  return currency(amount, { precision: decimals }).format()
}

// Re-export currency for advanced one-off usage
export { currency }
