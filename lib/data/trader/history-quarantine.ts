import type { HistoryCompleteness } from '@/lib/data/serving/types'

/**
 * Legacy position-history payloads are not bound to terminal scan evidence.
 * Keep the trust state explicit wherever an old cache or route can still
 * surface the payload during the serving-layer cutover.
 */
export const LEGACY_HISTORY_COMPLETENESS_UNKNOWN: HistoryCompleteness = {
  state: 'unknown',
  reason: 'history_evidence_not_bound',
}

type LegacyHistoryQuarantine = {
  positionHistory: never[]
  historyCompleteness: HistoryCompleteness
}

type LegacyFullHistoryQuarantine = {
  positions: never[]
  historyCompleteness: HistoryCompleteness
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Sanitize after every legacy cache read. Returning a copy is intentional: a
 * warm in-process cache must never be mutated into a new source of authority.
 */
export function quarantineLegacyPositionHistory<T>(payload: T): T | (T & LegacyHistoryQuarantine) {
  if (!isObjectRecord(payload)) return payload
  return {
    ...payload,
    positionHistory: [],
    historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  }
}

/** `/full` exposes the same legacy rows under the historical `positions` key. */
export function quarantineLegacyFullPositions<T>(
  payload: T
): T | (T & LegacyFullHistoryQuarantine) {
  if (!isObjectRecord(payload)) return payload
  return {
    ...payload,
    positions: [],
    historyCompleteness: LEGACY_HISTORY_COMPLETENESS_UNKNOWN,
  }
}
