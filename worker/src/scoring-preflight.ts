/**
 * Preflight of a scoring release (worker/deploy-scoring-local.sh): proves,
 * with the candidate release's own code and environment file, that the
 * startup gate the worker runs first would pass, BEFORE the deploy touches
 * the running process.
 *
 * Why: the deploy used to delete the healthy process and only then find out
 * whether the new one could start. On 2026-11-26 the database was unreachable
 * (network outage): the new release failed its startup gate, the rollback
 * failed the same gate, and scoring stayed down for 1.5 hours. The old
 * process needed no restart and would have ridden the outage out.
 *
 * Read-only: one read-only transaction calling the readiness RPC. No BullMQ,
 * Redis or schedule is touched.
 */

import { isV1RankingCommandChainPublished } from '../../lib/cron/v1-ranking-command-chain-publication'

if (!isV1RankingCommandChainPublished()) {
  console.error('[RETIRED] V1 ranking command chain is not published; preflight will not run.')
  process.exitCode = 2
} else {
  void main().then(
    () => process.exit(0),
    (error: unknown) => {
      // The gate's messages carry a category and safe fields only.
      console.error(
        `[scoring-preflight] ✗ ${error instanceof Error ? error.message : 'unexpected failure'}`
      )
      process.exit(1)
    }
  )
}

async function main(): Promise<void> {
  const [{ resolve, dirname }, { fileURLToPath }, { config }] = await Promise.all([
    import('node:path'),
    import('node:url'),
    import('dotenv'),
  ])
  // Same environment file the worker entry loads (worker/dist/../.env).
  config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') })

  const [{ assertMetricTrustWorkerReadiness }, { closeIngestPool }] = await Promise.all([
    import('./ingest/metric-trust-readiness'),
    import('../../lib/ingest/db'),
  ])
  try {
    await assertMetricTrustWorkerReadiness()
    console.log('[scoring-preflight] metric-trust database release contract ready')
  } finally {
    await closeIngestPool().catch(() => undefined)
  }
}
