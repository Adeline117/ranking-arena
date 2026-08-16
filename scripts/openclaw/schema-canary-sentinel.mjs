#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * This path is retained only so a legacy invocation fails loudly instead of
 * performing an unapproved production write-path check.
 */

console.error('[RETIRED] schema-canary-sentinel.mjs is disabled during the V1 NO-GO.')
console.error('A write-path canary requires a separately approved, isolated release plan.')
process.exitCode = 2
