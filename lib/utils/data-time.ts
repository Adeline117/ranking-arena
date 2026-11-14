/**
 * Display helpers for "data as of" / "updated" labels.
 *
 * The value passed in must already be a source-capture time (an upstream
 * watermark such as `leaderboard_source_freshness.source_as_of`, a snapshot's
 * `scraped_at`, or a news item's publish time). These helpers never substitute
 * the render/request time or Arena's score recompute time (`computed_at`) for a
 * missing value: an unusable timestamp is reported as unknown.
 */

import {
  RANKING_SOURCE_FUTURE_TOLERANCE_MS,
  RANKING_SOURCE_STALE_MS,
} from '@/lib/rankings/source-freshness'

export { RANKING_SOURCE_STALE_MS }

/**
 * Parse a source timestamp. Returns null for a missing/invalid value, for the
 * Unix-epoch "unknown" sentinel the serving RPCs emit (`1970-01-01T00:00:00Z`),
 * and for a value too far in the future to be a real capture time.
 */
export function parseDataTimestamp(
  value: string | number | Date | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (value === null || value === undefined || value === '') return null
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (Number.isFinite(nowMs) && ms > nowMs + RANKING_SOURCE_FUTURE_TOLERANCE_MS) return null
  return ms
}

/** True when a valid source timestamp is older than the 48h serving boundary. */
export function isDataTimestampStale(timestampMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - timestampMs > RANKING_SOURCE_STALE_MS
}

export interface DataTimeState {
  /** Parsed source timestamp, or null when unknown. */
  timestampMs: number | null
  /** ISO form of the parsed timestamp, or null when unknown. */
  iso: string | null
  /** Older than RANKING_SOURCE_STALE_MS. False when unknown (unknown is shown as such). */
  isStale: boolean
}

export function describeDataTime(
  value: string | number | Date | null | undefined,
  nowMs: number = Date.now()
): DataTimeState {
  const timestampMs = parseDataTimestamp(value, nowMs)
  if (timestampMs === null) return { timestampMs: null, iso: null, isStale: false }
  return {
    timestampMs,
    iso: new Date(timestampMs).toISOString(),
    isStale: isDataTimestampStale(timestampMs, nowMs),
  }
}

/**
 * Clock label that never implies "today" for an older timestamp: a value from
 * the viewer's current local day renders as a time only, anything else also
 * carries the date (and the year when it differs).
 */
export function formatDataClock(
  timestampMs: number,
  nowMs: number = Date.now(),
  locale: string = 'en-US',
  timeZone?: string
): string {
  const date = new Date(timestampMs)
  const now = new Date(nowMs)
  const dayKey = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(d)
  const yearOf = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { year: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(
      d
    )
  const sameDay = dayKey(date) === dayKey(now)
  const sameYear = yearOf(date) === yearOf(now)
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    ...(sameDay || sameYear ? {} : { year: 'numeric' }),
    ...(timeZone ? { timeZone } : {}),
  }
  try {
    return date.toLocaleString(locale, options)
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** Oldest valid source timestamp in a list (a page-level watermark must not
 * hide a stale source behind a fresher one). Null when none is valid. */
export function oldestDataTimestamp(
  values: ReadonlyArray<string | null | undefined>,
  nowMs: number = Date.now()
): string | null {
  let oldest: number | null = null
  for (const value of values) {
    const ms = parseDataTimestamp(value, nowMs)
    if (ms !== null && (oldest === null || ms < oldest)) oldest = ms
  }
  return oldest === null ? null : new Date(oldest).toISOString()
}

/** Newest valid source timestamp in a list. Null when none is valid. */
export function newestDataTimestamp(
  values: ReadonlyArray<string | null | undefined>,
  nowMs: number = Date.now()
): string | null {
  let newest: number | null = null
  for (const value of values) {
    const ms = parseDataTimestamp(value, nowMs)
    if (ms !== null && (newest === null || ms > newest)) newest = ms
  }
  return newest === null ? null : new Date(newest).toISOString()
}
