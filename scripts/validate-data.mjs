#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of silently treating legacy inventory as current validation.
 */

console.error('[RETIRED] validate-data.mjs is disabled during the V1 NO-GO.')
console.error('Use npm run check:freshness for the published-ranking authority verdict.')
process.exitCode = 2
