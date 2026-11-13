/**
 * Legacy ranking command-chain worker.
 *
 * The historical design used a long-running Node process to trigger ranking
 * publication and Meilisearch sync. The fixed V1 source gate below prevents
 * startup before dotenv or runtime dependencies load. This source file cannot
 * establish or stop the state of an already-running host process.
 */

import { isV1RankingCommandChainPublished } from '../../lib/cron/v1-ranking-command-chain-publication'
import type { RankPublicationAlertSink } from '../../lib/rankings/publication/publish-season'

// ENDGAME (ARENA_DATA_SPEC v1.2): legacy fetch/enrich removed — leaderboard
// data is produced by arena-ingest-worker. This worker only keeps the
// downstream chain: Arena Score recompute + Meilisearch sync.

if (!isV1RankingCommandChainPublished()) {
  console.error('[RETIRED] V1 ranking command chain is not published; worker will not start.')
  process.exitCode = 2
} else {
  void main().catch((err) => {
    console.error('[worker] Fatal error:', err)
    process.exit(1)
  })
}

async function main() {
  // Keep all dependency loading and dotenv configuration behind the checked-in
  // V1 gate above. The disabled worker must not initialize DB, Redis, BullMQ,
  // or downstream HTTP clients.
  const [{ resolve, dirname }, { fileURLToPath }, { config }] = await Promise.all([
    import('node:path'),
    import('node:url'),
    import('dotenv'),
  ])

  const __dirname = dirname(fileURLToPath(import.meta.url))
  config({ path: resolve(__dirname, '..', '.env') })

  const [
    { Worker },
    { getRankingCommandChainConnection, closeRankingCommandChainConnection },
    { QUEUE_NAME, JOB, getQueue },
    { PIPELINE_WORKER_CONCURRENCY },
    { assertSuccessfulMeilisearchSyncResponse },
    { registerSchedules },
    { startDashboard },
    { assertMetricTrustWorkerReadiness },
    { publishLeaderboardSeason, pgRankPublicationDatabase, createDefaultCohortScorer },
    { rankPublicationClientConnect, closeRankPublicationPool },
    { alert: ingestAlert },
    { syncPublicRankingsToMeilisearch },
    { routeRankPublicationAlert },
  ] = await Promise.all([
    import('bullmq'),
    import('./connection'),
    import('./queues'),
    import('./pipeline-runtime'),
    import('./pipeline-response'),
    import('./scheduler'),
    import('./dashboard'),
    import('./ingest/metric-trust-readiness'),
    import('../../lib/rankings/publication/publish-season'),
    import('../../lib/ingest/db'),
    import('../../lib/ingest/alerting'),
    import('../../lib/search/meilisearch-sync'),
    import('../../lib/rankings/publication/alert-routing'),
  ])

  // The season publication (and the Meilisearch read) runs in-process on the
  // worker's direct postgres connection (the fence/claim/seal RPCs are
  // owner-only), as one transaction, on a dedicated 2-client pool so it neither
  // starves nor is starved by ingest (lib/ingest/db.ts RANK_PUBLICATION_POOL_MAX).
  const connectPublicationClient = async () => {
    const client = await rankPublicationClientConnect()
    return {
      query: (text: string, values?: readonly unknown[]) =>
        client.query(text, values ? [...values] : undefined),
      release: (destroy?: boolean) => client.release(destroy),
    }
  }
  const rankPublicationDatabase = pgRankPublicationDatabase(connectPublicationClient)
  const scoreCohort = createDefaultCohortScorer()
  // Publication alerts go through the shared ingest alert interface. Routing
  // (lib/rankings/publication/alert-routing) gives every isolated source its
  // own season×source page-cooldown key and a refusal its own key; exclusion
  // warnings and restorations go to the digest. The orchestrator logs and swallows delivery failures itself.
  const rankPublicationAlert: RankPublicationAlertSink = async (publicationAlert) => {
    for (const routed of routeRankPublicationAlert(publicationAlert)) {
      await ingestAlert(getRankingCommandChainConnection(), routed)
    }
  }

  console.log('[worker] Arena Pipeline Worker starting...')

  // Keep score schedules and consumers on the same exact database release as
  // the ingest workers. A missing or stale readiness RPC stops startup before
  // either process can mutate BullMQ state.
  await assertMetricTrustWorkerReadiness()
  console.log('[worker] metric-trust database release contract ready')

  // 1. Register repeatable schedules (idempotent)
  await registerSchedules()

  // 2. Start worker
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case JOB.COMPUTE_LEADERBOARD: {
          // Score + publish one season: claim -> cohort upsert -> cleanup ->
          // rerank -> seal, all-or-nothing (lib/rankings/publication). The
          // former HTTP trigger targeted a 410 route tombstone.
          const { season } = job.data as { season: '7D' | '30D' | '90D' }
          job.log(`Publishing leaderboard season ${season}`)
          const published = await publishLeaderboardSeason(season, {
            database: rankPublicationDatabase,
            scoreCohort,
            log: (message) => void job.log(message),
            alert: rankPublicationAlert,
          })
          job.log(
            `published ${season}: cohort=${published.scoreCohortId} rows=${published.publishedRankCount} sources=${published.sources.length}`
          )
          return published
        }

        case JOB.SYNC_MEILISEARCH: {
          // In-process sync from the sealed public view. The former HTTP call
          // targeted /api/cron/sync-meilisearch, a V1 410 tombstone.
          job.log('Syncing sealed public rankings to Meilisearch')
          const synced = await syncPublicRankingsToMeilisearch({
            connect: connectPublicationClient,
            meiliUrl: process.env.MEILISEARCH_URL ?? '',
            meiliAdminKey: process.env.MEILISEARCH_ADMIN_KEY ?? '',
            log: (message) => void job.log(message),
          })
          assertSuccessfulMeilisearchSyncResponse(true, 200, synced)
          return synced
        }

        default:
          job.log(`[skip] Unknown job: ${job.name}`)
          return { skipped: true }
      }
    },
    {
      connection: getRankingCommandChainConnection(),
      concurrency: PIPELINE_WORKER_CONCURRENCY,
      removeOnComplete: { age: 24 * 3600, count: 1000 }, // Keep last 1000 completed jobs for 24h
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 }, // Keep failed jobs for 7 days
    }
  )

  // 3. Event logging + event-driven score trigger
  worker.on('completed', async (job) => {
    try {
      const duration =
        job.finishedOn && job.processedOn ? `${job.finishedOn - job.processedOn}ms` : '?ms'
      console.log(`[worker] ✓ ${job.name} (${JSON.stringify(job.data)}) completed in ${duration}`)

      const q = getQueue()

      // After score compute → trigger meilisearch sync
      if (job.name === JOB.COMPUTE_LEADERBOARD) {
        const { season } = job.data as { season: string }
        if (season === '90D') {
          await q.add(
            JOB.SYNC_MEILISEARCH,
            {},
            {
              jobId: `meilisearch-after-score_${Date.now()}`,
              priority: 1,
            }
          )
        }
      }
    } catch (err) {
      console.error(`[worker] Error in completed handler for ${job?.name}:`, err)
    }
  })

  worker.on('failed', (job, err) => {
    const attempt = job?.attemptsMade ?? 0
    const maxAttempts = job?.opts?.attempts ?? 3
    console.error(`[worker] ✗ ${job?.name} attempt ${attempt}/${maxAttempts} failed:`, err.message)
  })

  worker.on('error', (err) => {
    console.error('[worker] Worker error:', err.message)
  })

  // Crash recovery: prevent silent process death
  process.on('uncaughtException', (err) => {
    console.error('[worker] UNCAUGHT EXCEPTION:', err)
    worker
      .close()
      .then(() => closeRankingCommandChainConnection())
      .finally(() => process.exit(1))
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[worker] UNHANDLED REJECTION:', reason)
  })

  console.log(
    `[worker] Ready — processing queue "${QUEUE_NAME}" with ` +
      `concurrency=${PIPELINE_WORKER_CONCURRENCY}`
  )
  console.log('[worker] Press Ctrl+C to stop')

  // 5. Start Bull Board dashboard
  startDashboard()

  // 4. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[worker] ${signal} received, shutting down gracefully...`)
    await worker.close()
    await closeRankingCommandChainConnection()
    await closeRankPublicationPool()
    console.log('[worker] Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
