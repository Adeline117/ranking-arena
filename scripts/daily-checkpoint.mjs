#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of writing an unproven legacy daily series.
 */

console.error('[RETIRED] daily-checkpoint.mjs is disabled during the V1 NO-GO.')
console.error('Legacy daily publication remains quarantined pending a provenance-bound publisher.')
process.exitCode = 2
