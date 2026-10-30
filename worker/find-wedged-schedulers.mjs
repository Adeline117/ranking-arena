/**
 * Retired V1 scheduler repair command.
 *
 * This source hold does not inspect or mutate any Redis scheduler state.
 */
console.error('[RETIRED] V1 ingest execution is not published; scheduler repair will not run.')
process.exitCode = 2
