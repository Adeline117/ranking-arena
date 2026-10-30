#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * The path remains so an old scheduler or operator invocation fails loudly
 * instead of reading or writing a retired profile workflow.
 */

console.error('[RETIRED] generate-trader-bios.ts is disabled during the V1 NO-GO.')
console.error(
  'A future profile-enrichment workflow needs its own reviewed source and publication contract.'
)
process.exitCode = 2
