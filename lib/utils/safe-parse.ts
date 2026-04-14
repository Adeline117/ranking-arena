/**
 * Safe parseInt with guaranteed radix 10 and NaN fallback.
 * Returns fallback if the value is null, undefined, empty, or non-numeric.
 */
export function safeParseInt(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

/**
 * Parse a 'limit' query param: safeParseInt + clamp to [1, max].
 */
export function parseLimit(value: string | null | undefined, fallback: number, max: number): number {
  const n = safeParseInt(value, fallback)
  return Math.min(Math.max(n, 1), max)
}

/**
 * Parse an 'offset' query param: safeParseInt + floor at 0.
 */
export function parseOffset(value: string | null | undefined): number {
  return Math.max(safeParseInt(value, 0), 0)
}

/**
 * Parse a 'page' query param: safeParseInt + floor at 1.
 */
export function parsePage(value: string | null | undefined, fallback = 1): number {
  return Math.max(safeParseInt(value, fallback), 1)
}
