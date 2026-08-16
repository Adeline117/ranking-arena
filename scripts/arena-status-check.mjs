#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * This script formerly inferred infrastructure health from stale local files and
 * host crontab state. It cannot certify the current serving or release state.
 */

console.error('[RETIRED] arena-status-check.mjs is disabled during the V1 NO-GO.')
console.error(
  'Use npm run check:status, npm run check:freshness, and npm run check:platforms for read-only evidence.'
)
process.exitCode = 2
