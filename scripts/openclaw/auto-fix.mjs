#!/usr/bin/env node
/**
 * Retired V1 compatibility tombstone.
 *
 * This path is retained only so a legacy invocation fails loudly instead of
 * autonomously changing code or external state.
 */

console.error('[RETIRED] auto-fix.mjs is disabled during the V1 NO-GO.')
console.error('Use the owner-approved incident and release process for any proposed remediation.')
process.exitCode = 2
