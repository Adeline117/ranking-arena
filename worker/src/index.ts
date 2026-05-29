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
import { registerSchedules } from './scheduler'
import { processFetch } from './processors/fetch'
import { startDashboard } from './dashboard'

const FETCH_CONCURRENCY = 5 // 5 platforms fetching in parallel

// Track fetch completions to trigger leaderboard recompute
let fetchCompletedSinceLastScore = 0
const FETCH_BATCH_THRESHOLD = 5 // After N platforms fetch, trigger score recompute

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
          return { season, status: resp.status, ...body }
        }

        case JOB.ENRICH_PLATFORM: {
          // Trigger Vercel's batch-enrich endpoint
          const { period, tier } = job.data as { period: string; tier: string }
          const enrichSecret = process.env.CRON_SECRET
          if (!enrichSecret) return { skipped: true, reason: 'no CRON_SECRET' }
          const enrichUrl = process.env.SITE_URL || 'https://www.arenafi.org'
          job.log(`Triggering batch-enrich period=${period} tier=${tier}`)
          const enrichResp = await fetch(
            `${enrichUrl}/api/cron/batch-enrich?period=${period}&tier=${tier}`,
            {
              headers: { Authorization: `Bearer ${enrichSecret}` },
              signal: AbortSignal.timeout(300_000),
            },
          )
          const enrichBody = await enrichResp.json().catch(() => ({}))
          job.log(`batch-enrich ${period}/${tier}: ${enrichResp.status}`)
          return { period, tier, status: enrichResp.status, ...enrichBody }
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
          return { status: msResp.status, ...msBody }
        }

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

  // 3. Event logging + event-driven score trigger
  worker.on('completed', async (job) => {
    const duration =
      job.finishedOn && job.processedOn ? `${job.finishedOn - job.processedOn}ms` : '?ms'
    console.log(`[worker] ✓ ${job.name} (${JSON.stringify(job.data)}) completed in ${duration}`)

    const q = getQueue()

    // Event chain: fetch → score → enrich + meilisearch
    if (job.name === JOB.FETCH_PLATFORM) {
      fetchCompletedSinceLastScore++
      if (fetchCompletedSinceLastScore >= FETCH_BATCH_THRESHOLD) {
        fetchCompletedSinceLastScore = 0
        console.log('[worker] Fetch batch threshold reached — triggering enrich + score')
        // Enrich first (backfills metrics before score calc)
        for (const period of ['7D', '30D', '90D']) {
          for (const tier of ['fast', 'slow']) {
            await q.add(JOB.ENRICH_PLATFORM, { period, tier }, {
              jobId: `enrich-after-fetch:${period}:${tier}:${Date.now()}`,
              priority: 2,
            })
          }
        }
        // Score after enrich (priority 1 = runs after enrich completes)
        for (const season of ['7D', '30D', '90D'] as const) {
          await q.add(JOB.COMPUTE_LEADERBOARD, { season }, {
            jobId: `score-after-fetch:${season}:${Date.now()}`,
            priority: 1,
            delay: 120_000, // 2 min delay to let enrich finish first
          })
        }
      }
    }

    // After score compute → trigger meilisearch sync
    if (job.name === JOB.COMPUTE_LEADERBOARD) {
      // Only trigger once (after 90D, which runs last)
      const { season } = job.data as { season: string }
      if (season === '90D') {
        await q.add(JOB.SYNC_MEILISEARCH, {}, {
          jobId: `meilisearch-after-score:${Date.now()}`,
          priority: 1,
        })
      }
    }
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
