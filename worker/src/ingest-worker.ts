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
import {
  TIERC_QUEUE_NAME,
  INGEST_JOB,
  ingestConnection,
  consumedRegions,
  regionQueueName,
} from './ingest/queues'
import { reconcileSchedulers } from './ingest/scheduler'
import { startHeartbeat } from './ingest/heartbeat'
import { startFailoverManager } from './ingest/failover'

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
    case INGEST_JOB.TIER_B_SERIES: {
      const { processTierBSeries } = await import('./ingest/processors/tier-b-series')
      return processTierBSeries(job)
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

  const regions = consumedRegions()
  const workers = regions.map((region) => {
    const w = new Worker(regionQueueName(region), route, {
      connection: ingestConnection(),
      concurrency: INGEST_CONCURRENCY,
      // Tier-A full crawls run 25-90 min; default 30s lock + stall detection
      // misfires across pm2 restarts ("job stalled more than allowable limit").
      // Longer lock + renewal headroom; stalled jobs still recover via retry.
      lockDuration: 180_000,
      stalledInterval: 300_000,
      maxStalledCount: 2,
    })
    w.on('completed', (job) => {
      console.log(`[ingest-worker] ✓ ${job.name} (${job.id}) [${region}]`)
    })
    w.on('failed', (job, err) => {
      console.error(`[ingest-worker] ✗ ${job?.name} (${job?.id}) [${region}]:`, err.message)
    })
    return w
  })

  // Dedicated Tier-C worker: user-facing on-demand fetches get their own
  // slots so they never queue behind hours-long Tier-A/B bulk crawls
  // (the API route's polling window is 8s).
  // ONLY on the primary node (consumes 'local'): a region-pinned satellite
  // (e.g. SG VPS, INGEST_REGIONS=vps_sg) must not steal Tier-C jobs for
  // local-region sources — it would run them from the wrong egress IP and
  // lacks the branded-chrome channel some sources need (bybit).
  let tiercWorker: Worker | null = null
  if (regions.includes('local')) {
    tiercWorker = new Worker(TIERC_QUEUE_NAME, route, {
      connection: ingestConnection(),
      concurrency: 2,
    })
    tiercWorker.on('completed', (job) => {
      console.log(`[ingest-worker] ✓ tierc ${job.id}`)
    })
    tiercWorker.on('failed', (job, err) => {
      console.error(`[ingest-worker] ✗ tierc ${job?.id}:`, err.message)
    })
  }

  await reconcileSchedulers()
  // Re-reconcile hourly: sources rows are the live config (spec §2.1).
  const reconcileTimer = setInterval(() => {
    reconcileSchedulers().catch((err) => console.error('[ingest-worker] reconcile failed:', err))
  }, 60 * 60_000)

  // Liveness heartbeat → shared cloud Redis, read by the worker-heartbeat-check
  // Vercel cron (de-single-point: detect this node dying within ~15min,
  // independent of crawl cadence and of this node being alive).
  const heartbeatTimer = startHeartbeat(getConnection(), regions)

  // Standby failover: when an operator sets arena:failover:regions in response
  // to a heartbeat-down page, this worker temporarily consumes the downed
  // node's queue (auto-stands-down when that node's heartbeat returns).
  const failover = startFailoverManager(getConnection(), regions, route, {
    concurrency: INGEST_CONCURRENCY,
    lockDuration: 180_000,
    stalledInterval: 300_000,
    maxStalledCount: 2,
  })

  console.log(
    `[ingest-worker] ready (regions=${regions.join(',')}, concurrency=${INGEST_CONCURRENCY})`
  )

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    // SIGINT+SIGTERM can both fire (pm2 stop) — double closeIngestPool()
    // throws "Called end on pool more than once" as an unhandled rejection.
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[ingest-worker] ${signal} — shutting down…`)
    clearInterval(reconcileTimer)
    clearInterval(heartbeatTimer)
    await failover.stop()
    await Promise.all(workers.map((w) => w.close()))
    await tiercWorker?.close()
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
