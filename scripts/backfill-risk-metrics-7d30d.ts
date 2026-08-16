#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old package alias or operator invocation fails loudly
 * instead of writing a legacy backfill.
 */

console.error('[RETIRED] backfill-risk-metrics-7d30d.ts is disabled during the V1 NO-GO.')
console.error(
  'No backfill is authorized without a separately approved provenance-bound release plan.'
)
process.exitCode = 2
