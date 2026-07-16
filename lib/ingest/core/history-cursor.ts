import type { ParsedHistoryRow } from './types'

function eventTimestamp(row: ParsedHistoryRow): string | null {
  return row.kind === 'position_history' ? row.closedAt : row.ts
}

function timestampMs(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`[history-cursor] invalid ${label} timestamp`)
  }
  return parsed
}

/** Return a canonical, strictly advancing event-time cursor, or null. */
export function nextHistoryCursor(
  rows: ParsedHistoryRow[],
  currentCursor: string | null
): string | null {
  const currentMs =
    currentCursor === null ? Number.NEGATIVE_INFINITY : timestampMs(currentCursor, 'stored cursor')
  let newestMs = Number.NEGATIVE_INFINITY

  for (const row of rows) {
    const value = eventTimestamp(row)
    if (value === null) continue
    newestMs = Math.max(newestMs, timestampMs(value, 'event'))
  }

  return newestMs > currentMs ? new Date(newestMs).toISOString() : null
}
