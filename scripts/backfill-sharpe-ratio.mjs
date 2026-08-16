#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of writing a legacy backfill.
 */

console.error('[RETIRED] backfill-sharpe-ratio.mjs is disabled during the V1 NO-GO.')
console.error(
  'No backfill is authorized without a separately approved provenance-bound release plan.'
)
process.exitCode = 2
