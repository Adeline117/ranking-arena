/**
 * Retired V1 scheduler kick command.
 *
 * This source hold does not inspect or mutate any Redis queue state.
 */
console.error('[RETIRED] V1 ingest execution is not published; scheduler kick will not run.')
process.exitCode = 2
