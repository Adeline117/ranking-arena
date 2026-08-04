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
