#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old operator invocation fails loudly instead of
 * presenting a legacy relation inventory as current data validation.
 */

console.error('[RETIRED] check-data-distribution.mjs is disabled during the V1 NO-GO.')
console.error('Use npm run check:freshness for the published-ranking authority verdict.')
process.exitCode = 2
