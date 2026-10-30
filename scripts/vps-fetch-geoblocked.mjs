#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of making a legacy worker/proxy fetch or write.
 */

console.error('[RETIRED] vps-fetch-geoblocked.mjs is disabled during the V1 NO-GO.')
console.error('Source routing changes require a separately approved source and release plan.')
process.exitCode = 2
