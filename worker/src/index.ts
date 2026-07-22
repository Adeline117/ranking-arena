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

import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

// Load worker/.env relative to this file's location
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '..', '.env') })

import { Worker } from 'bullmq'
import { getConnection, closeConnection } from './connection'
import { QUEUE_NAME, JOB, getQueue } from './queues'
import { PIPELINE_WORKER_CONCURRENCY } from './pipeline-runtime'
import { assertSuccessfulMeilisearchSyncResponse } from './pipeline-response'
import { registerSchedules } from './scheduler'
import { startDashboard } from './dashboard'

// ENDGAME (ARENA_DATA_SPEC v1.2): legacy fetch/enrich removed — leaderboard
// data is produced by arena-ingest-worker. This worker only keeps the
// downstream chain: Arena Score recompute + Meilisearch sync.

async function main() {
  console.log('[worker] Arena Pipeline Worker starting...')

  // 1. Register repeatable schedules (idempotent)
  await registerSchedules()

  // 2. Start worker
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case JOB.COMPUTE_LEADERBOARD: {
          // Trigger Vercel's compute-leaderboard endpoint (still runs there)
          const { season } = job.data as { season: string }
          const cronSecret = process.env.CRON_SECRET
          if (!cronSecret) {
            job.log('[skip] CRON_SECRET not set, cannot trigger compute-leaderboard')
            return { skipped: true }
          }
          const siteUrl = process.env.SITE_URL || 'https://www.arenafi.org'
          job.log(`Triggering compute-leaderboard for ${season}`)
          const resp = await fetch(`${siteUrl}/api/cron/compute-leaderboard?season=${season}`, {
            headers: { Authorization: `Bearer ${cronSecret}` },
            signal: AbortSignal.timeout(300_000), // 5 min timeout
          })
          const body = await resp.json().catch(() => ({}))
          job.log(
            `compute-leaderboard ${season}: ${resp.status} — ${JSON.stringify(body).slice(0, 200)}`
          )
          if (!resp.ok) throw new Error(`compute-leaderboard ${season} returned ${resp.status}`)
          return { season, status: resp.status, ...body }
        }

        case JOB.SYNC_MEILISEARCH: {
          // Trigger Vercel's sync-meilisearch endpoint
          const msSecret = process.env.CRON_SECRET
          if (!msSecret) return { skipped: true, reason: 'no CRON_SECRET' }
          const msUrl = process.env.SITE_URL || 'https://www.arenafi.org'
          job.log('Triggering sync-meilisearch')
          const msResp = await fetch(`${msUrl}/api/cron/sync-meilisearch`, {
            headers: { Authorization: `Bearer ${msSecret}` },
            signal: AbortSignal.timeout(120_000),
          })
          const msBody = await msResp.json().catch(() => ({}))
          job.log(`sync-meilisearch: ${msResp.status}`)
          assertSuccessfulMeilisearchSyncResponse(msResp.ok, msResp.status, msBody)
          return { status: msResp.status, ...msBody }
        }

        default:
          job.log(`[skip] Unknown job: ${job.name}`)
          return { skipped: true }
      }
    },
    {
      connection: getConnection(),
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

  worker.on('failed', async (job, err) => {
    const attempt = job?.attemptsMade ?? 0
    const maxAttempts = job?.opts?.attempts ?? 3
    console.error(`[worker] ✗ ${job?.name} attempt ${attempt}/${maxAttempts} failed:`, err.message)

    // Log to pipeline_logs so health monitoring sees worker failures
    try {
      const siteUrl = process.env.SITE_URL || 'https://www.arenafi.org'
      const secret = process.env.CRON_SECRET
      if (secret && job) {
        await fetch(`${siteUrl}/api/health/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({
            source: `worker:${job.name}`,
            status: attempt >= maxAttempts ? 'failed' : 'retrying',
            error: err.message,
            attempt,
            maxAttempts,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {}) // best-effort
      }
    } catch {
      /* don't let logging failure crash the worker */
    }
  })

  worker.on('error', (err) => {
    console.error('[worker] Worker error:', err.message)
  })

  // Crash recovery: prevent silent process death
  process.on('uncaughtException', (err) => {
    console.error('[worker] UNCAUGHT EXCEPTION:', err)
    worker
      .close()
      .then(() => closeConnection())
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
