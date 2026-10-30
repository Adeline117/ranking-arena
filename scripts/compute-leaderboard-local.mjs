#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of silently running a legacy serving-write flow.
 */

console.error('[RETIRED] compute-leaderboard-local.mjs is disabled during the V1 NO-GO.')
console.error('Serving recomputation requires a separately approved release plan and owner GO.')
process.exitCode = 2
