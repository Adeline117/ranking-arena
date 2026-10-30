#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of silently running a legacy health/alert flow.
 */

console.error('[RETIRED] health-check.mjs is disabled during the V1 NO-GO.')
console.error(
  'Use npm run check:status, npm run check:freshness, and npm run check:platforms for read-only evidence.'
)
process.exitCode = 2
