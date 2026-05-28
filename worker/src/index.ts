/**
 * Arena Data Pipeline Worker
 *
 * Long-running Node.js process that replaces Vercel Cron for data-intensive jobs.
 * Runs on Mac Mini (or any VPS) with no timeout limits.
 *
 * Usage:
 *   npx tsx worker/src/index.ts
 *
 * Required env vars:
 *   REDIS_URL                     — native Redis TCP (rediss://default:TOKEN@HOST:6379)
 *   NEXT_PUBLIC_SUPABASE_URL      — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY     — Supabase service role key
 *
 * Architecture:
 *   Scheduler → Queue (BullMQ) → Workers (per job type)
 *   Each platform runs independently. No timeout cascading.
 *   Failed jobs auto-retry 3x with exponential backoff.
 */

import { Worker } from 'bullmq'
import { getConnection, closeConnection } from './connection'
import { QUEUE_NAME, JOB } from './queues'
import { registerSchedules } from './scheduler'
import { processFetch } from './processors/fetch'

const FETCH_CONCURRENCY = 5 // 5 platforms fetching in parallel

async function main() {
  console.log('[worker] Arena Pipeline Worker starting...')

  // 1. Register repeatable schedules (idempotent)
  await registerSchedules()

  // 2. Start worker
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case JOB.FETCH_PLATFORM:
          return processFetch(job)

        case JOB.COMPUTE_LEADERBOARD:
          // TODO: Phase 2 — migrate compute-leaderboard
          job.log(`[skip] ${job.name} not yet migrated — still running on Vercel cron`)
          return { skipped: true }

        case JOB.ENRICH_PLATFORM:
          // TODO: Phase 2 — migrate batch-enrich
          job.log(`[skip] ${job.name} not yet migrated`)
          return { skipped: true }

        default:
          job.log(`[skip] Unknown job: ${job.name}`)
          return { skipped: true }
      }
    },
    {
      connection: getConnection(),
      concurrency: FETCH_CONCURRENCY,
      removeOnComplete: { age: 24 * 3600, count: 1000 }, // Keep last 1000 completed jobs for 24h
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 }, // Keep failed jobs for 7 days
    }
  )

  // 3. Event logging
  worker.on('completed', (job) => {
    const duration =
      job.finishedOn && job.processedOn ? `${job.finishedOn - job.processedOn}ms` : '?ms'
    console.log(`[worker] ✓ ${job.name} (${JSON.stringify(job.data)}) completed in ${duration}`)
  })

  worker.on('failed', (job, err) => {
    const attempt = job?.attemptsMade ?? '?'
    console.error(`[worker] ✗ ${job?.name} attempt ${attempt} failed:`, err.message)
  })

  worker.on('error', (err) => {
    console.error('[worker] Worker error:', err.message)
  })

  console.log(
    `[worker] Ready — processing queue "${QUEUE_NAME}" with concurrency=${FETCH_CONCURRENCY}`
  )
  console.log('[worker] Press Ctrl+C to stop')

  // 4. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[worker] ${signal} received, shutting down gracefully...`)
    await worker.close()
    await closeConnection()
    console.log('[worker] Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[worker] Fatal error:', err)
  process.exit(1)
})
