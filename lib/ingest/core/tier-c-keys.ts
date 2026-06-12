/**
 * Tier-C bridge contract — THE single definition of the jobId and result
 * key shared by the Vercel route (lib/data/serving/tier-c.ts) and the
 * worker (worker/src/ingest/queues.ts).
 *
 * History: these builders used to be hand-duplicated on both sides with a
 * "KEEP IN SYNC" comment; the formats drifted anyway (the worker side
 * shipped a ':' jobId that BullMQ silently rejects on the producer).
 * Zero-dependency module → both sides import it, drift is impossible.
 */

export interface TierCKeyParts {
  sourceSlug: string
  exchangeTraderId: string
  timeframe: 0 | 7 | 30 | 90
  surface: 'profile' | 'positions' | 'position_history' | 'orders' | 'transfers' | 'copiers'
}

/** Deterministic BullMQ jobId = cross-lambda single-flight key.
 *  BullMQ rejects custom ids containing ':' — '--' is the separator. */
export function tierCJobId(d: TierCKeyParts): string {
  return ['tierc', d.sourceSlug, d.exchangeTraderId, d.timeframe, d.surface].join('--')
}

/** Redis key the worker publishes results to (render-before-persist). */
export function tierCResultKey(d: TierCKeyParts): string {
  return `arena:live:${d.sourceSlug}:${d.exchangeTraderId}:${d.timeframe}:${d.surface}`
}
