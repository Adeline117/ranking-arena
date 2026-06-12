/**
 * Arena Ingest Worker — orchestrator for the unified scraping framework
 * (ARENA_DATA_SPEC v1.2 §2). Separate PM2 app + BullMQ queue from the
 * legacy arena-worker so the two pipelines fail independently during the
 * parallel-build migration.
 *
 * Usage: npx tsx worker/src/ingest-worker.ts
 * Env (worker/.env): REDIS_URL, INGEST_DATABASE_URL,
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   PLAYWRIGHT_WS_SG / PLAYWRIGHT_WS_JP (only for remote-region sources)
 */

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '..', '.env') })

import { Worker, type Job } from 'bullmq'
import { getConnection, closeConnection } from './connection'
import { INGEST_QUEUE_NAME, TIERC_QUEUE_NAME, INGEST_JOB, ingestConnection } from './ingest/queues'
import { reconcileSchedulers } from './ingest/scheduler'

// Playwright sessions are heavy on a Mac Mini; per-source serialization
// happens inside processors (one session per source at a time).
const INGEST_CONCURRENCY = 3

async function route(job: Job): Promise<unknown> {
  switch (job.name) {
    case INGEST_JOB.TIER_A: {
      const { processTierA } = await import('./ingest/processors/tier-a-leaderboard')
      return processTierA(job)
    }
    case INGEST_JOB.TIER_B: {
      const { processTierB } = await import('./ingest/processors/tier-b-profiles')
      return processTierB(job)
    }
    case INGEST_JOB.TIER_C: {
      const { processTierC } = await import('./ingest/processors/tier-c-profile')
      return processTierC(job)
    }
    case INGEST_JOB.TIER_D: {
      const { processTierD } = await import('./ingest/processors/tier-d-positions')
      return processTierD(job)
    }
    case INGEST_JOB.DERIVE_BOARDS: {
      const { processDeriveBoards } = await import('./ingest/processors/derive-boards')
      return processDeriveBoards(job)
    }
    case INGEST_JOB.AVATAR_MIRROR: {
      const { processAvatarMirror } = await import('./ingest/processors/avatar-mirror')
      return processAvatarMirror(job)
    }
    case INGEST_JOB.MAINTENANCE: {
      const { processMaintenance } = await import('./ingest/processors/maintenance')
      return processMaintenance(job)
    }
    case INGEST_JOB.FRESHNESS: {
      const { processFreshness } = await import('./ingest/processors/freshness-sentinel')
      return processFreshness(job)
    }
    case INGEST_JOB.DAILY_DIGEST: {
      const { processDailyDigest } = await import('./ingest/processors/daily-digest')
      return processDailyDigest(job)
    }
    default:
      throw new Error(`[ingest-worker] unknown job: ${job.name}`)
  }
}

async function main(): Promise<void> {
  console.log('[ingest-worker] starting…')

  // Register adapters (side-effect imports add them to the registry).
  await import('@/lib/ingest/adapters/register')

  const worker = new Worker(INGEST_QUEUE_NAME, route, {
    connection: ingestConnection(),
    concurrency: INGEST_CONCURRENCY,
  })

  worker.on('completed', (job) => {
    console.log(`[ingest-worker] ✓ ${job.name} (${job.id})`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[ingest-worker] ✗ ${job?.name} (${job?.id}):`, err.message)
  })

  // Dedicated Tier-C worker: user-facing on-demand fetches get their own
  // slots so they never queue behind hours-long Tier-A/B bulk crawls
  // (the API route's polling window is 8s).
  const tiercWorker = new Worker(TIERC_QUEUE_NAME, route, {
    connection: ingestConnection(),
    concurrency: 2,
  })
  tiercWorker.on('completed', (job) => {
    console.log(`[ingest-worker] ✓ tierc ${job.id}`)
  })
  tiercWorker.on('failed', (job, err) => {
    console.error(`[ingest-worker] ✗ tierc ${job?.id}:`, err.message)
  })

  await reconcileSchedulers()
  // Re-reconcile hourly: sources rows are the live config (spec §2.1).
  const reconcileTimer = setInterval(() => {
    reconcileSchedulers().catch((err) => console.error('[ingest-worker] reconcile failed:', err))
  }, 60 * 60_000)

  console.log(`[ingest-worker] ready (concurrency=${INGEST_CONCURRENCY})`)

  const shutdown = async (signal: string) => {
    console.log(`[ingest-worker] ${signal} — shutting down…`)
    clearInterval(reconcileTimer)
    await worker.close()
    await tiercWorker.close()
    const { closeIngestPool } = await import('@/lib/ingest/db')
    await closeIngestPool()
    await closeConnection()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // Crash visibility — PM2 restarts us; never die silently.
  process.on('unhandledRejection', (reason) => {
    console.error('[ingest-worker] UNHANDLED REJECTION:', reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('[ingest-worker] UNCAUGHT EXCEPTION:', err)
    process.exit(1)
  })
}

main().catch((err) => {
  console.error('[ingest-worker] fatal:', err)
  process.exit(1)
})
