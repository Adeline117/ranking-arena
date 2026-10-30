#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of writing unproven direct leaderboard risk metrics.
 */

console.error('[RETIRED] compute-leaderboard-risk-metrics.mjs is disabled during the V1 NO-GO.')
console.error(
  'Direct leaderboard metric recomputation requires a separately approved provenance-bound release plan and owner GO.'
)
process.exitCode = 2
