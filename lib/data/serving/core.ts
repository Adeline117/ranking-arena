/**
 * Timeframe and freshness helpers shared by the serving routes. The public
 * /core route is quarantined (core-quarantine.ts), so nothing reads the raw
 * arena_core_modules RPC from the app any more.
 */

import type { ServingTimeframe } from './types'

export function tfToInt(tf: ServingTimeframe): 0 | 7 | 30 | 90 {
  return tf === 'inception' ? 0 : tf
}

export function intToTf(n: number): ServingTimeframe {
  return n === 0 ? 'inception' : (n as 7 | 30 | 90)
}

/** Is an as_of timestamp within the freshness TTL? */
export function isFresh(asOf: string | null | undefined, ttlSeconds: number): boolean {
  if (!asOf) return false
  const t = Date.parse(asOf)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < ttlSeconds * 1000
}
