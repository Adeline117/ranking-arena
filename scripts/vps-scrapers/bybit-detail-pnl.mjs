#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * This path is retained only so a legacy invocation fails loudly instead of
 * acquiring or publishing unproven source data.
 */

console.error('[RETIRED] bybit-detail-pnl.mjs is disabled during the V1 NO-GO.')
console.error('Source acquisition requires a separately approved provenance-bound release plan.')
process.exitCode = 2
