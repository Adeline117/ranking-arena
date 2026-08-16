#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of silently running a legacy external-diagnosis flow.
 */

console.error('[RETIRED] diagnose-enrichment.mjs is disabled during the V1 NO-GO.')
console.error('Use npm run check:enrichment for the bounded read-only inventory.')
process.exitCode = 2
