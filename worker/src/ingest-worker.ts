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
  INGEST_JOB,
  ingestConnection,
  consumedRegions,
  regionQueueName,
  regionFastQueueName,
  tierCQueueName,
  fastLaneEnabled,
  type IngestRegion,
  type TierCJobData,
} from './ingest/queues'
import { reconcileSchedulers } from './ingest/scheduler'
import { startHeartbeat } from './ingest/heartbeat'
import { startFailoverManager } from './ingest/failover'
import { withSourceJobLease } from './ingest/source-job-lease'
import { routeTierCJobRegion } from './ingest/tier-c-region-router'

// Per-region worker concurrency. Bumped 3→5 (2026-06-12): at 3 the drain
// rate (~12-18 jobs/h, dragged by giant crawls like bybit_mt5's 29k rows)
// fell BELOW the arrival rate (~25-30/h from 35 sources × tier A/B/D cadences),
// so the queue grew unboundedly (159 waiting) and low-priority sources
// (gmx/gtrade) starved 10h+ at the tail. 5 roughly doubles drain to match
// arrival. Most sources are now pure-HTTP (light); browser sources still
// serialize one session each, and remote-region (vps_jp) sources use a remote
// WS so the Mac launches no local Chromium for them — so peak local browser
// count stays well under 5. pm2 max_memory_restart raised to 1536M to match.
//
// Now env-tunable per node (2026-07-08): after the SG box was resized 1→4 vCPU /
// 2→8GB, concurrency 5 badly under-utilized it (load 0.54, 6GB free) because
// browser-source crawls are per-fetch-latency-bound, not CPU-bound — parallelism,
// not more cores per job, is the lever. SG sets INGEST_CONCURRENCY=12 in its env;
// local (Mac) keeps the default 5 unless overridden.
const INGEST_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY) || 5

// Fast-lane pool (2026-06-13 slot-starvation root fix): light Tier-A
// leaderboard crawls (board ≤ FAST_TIER_A_MAX_COUNT) run here, fully isolated
// from the bulk pool's multi-hour giants (bybit_mt5 etc.). These crawls are
// small (seconds-to-minutes) so a modest pool keeps all ~26 small boards fresh;
// peak extra concurrent browsers stay low because each session is short-lived.
const FAST_CONCURRENCY = 3

async function route(job: Job): Promise<unknown> {
  switch (job.name) {
    case INGEST_JOB.TIER_A: {
      const { processTierA } = await import('./ingest/processors/tier-a-leaderboard')
      const sourceSlug = job.data?.sourceSlug
      if (typeof sourceSlug !== 'string' || sourceSlug.length === 0) {
        throw new Error('[ingest-worker] Tier-A job is missing sourceSlug')
      }
      const result = await withSourceJobLease({
        redis: getConnection(),
        lane: 'tier-a',
        sourceSlug,
        run: () => processTierA(job),
      })
      if (result.coalesced) {
        console.log(
          `[ingest-worker] ↪ coalesced duplicate Tier-A iteration ${job.id} (${sourceSlug})`
        )
        return { coalesced: true, sourceSlug }
      }
      return result.value
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
      throw new Error('[ingest-worker] Tier-C job arrived on a bulk queue')
    }
    case INGEST_JOB.FIRST_PARTY: {
      const { processFirstPartySync } = await import('./ingest/processors/first-party-sync')
      return processFirstPartySync(job)
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
    case INGEST_JOB.ONCHAIN_ENRICH: {
      const { processOnchainEnrich } = await import('./ingest/processors/onchain-enrich')
      return processOnchainEnrich(job)
    }
    default:
      throw new Error(`[ingest-worker] unknown job: ${job.name}`)
  }
}

async function routeTierC(job: Job<TierCJobData>, region: IngestRegion): Promise<unknown> {
  const decision = await routeTierCJobRegion(job, region)
  if (decision.action === 'rerouted') {
    console.warn(
      `[ingest-worker] ↪ tierc ${decision.jobId} rerouted ${decision.from} → ${decision.to}`
    )
    return decision
  }
  const { processTierC } = await import('./ingest/processors/tier-c-profile')
  return processTierC(job, region)
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

  // Fast-lane workers: a separate pool per consumed region for light Tier-A
  // crawls (siphoned by reconcileSchedulers). The bulk pool's hours-long
  // crawls can never occupy these slots, so small user-facing leaderboards
  // stay fresh regardless of giant-board backlog. Gated by INGEST_FAST_LANE so
  // the lane only spins up once BOTH nodes are enabled together (see queues.ts).
  const fastWorkers = !fastLaneEnabled()
    ? []
    : regions.map((region) => {
        const w = new Worker(regionFastQueueName(region), route, {
          connection: ingestConnection(),
          concurrency: FAST_CONCURRENCY,
          lockDuration: 180_000,
          stalledInterval: 300_000,
          maxStalledCount: 2,
        })
        w.on('completed', (job) => {
          console.log(`[ingest-worker] ✓ ${job.name} (${job.id}) [${region}/fast]`)
        })
        w.on('failed', (job, err) => {
          console.error(
            `[ingest-worker] ✗ ${job?.name} (${job?.id}) [${region}/fast]:`,
            err.message
          )
        })
        return w
      })

  // Dedicated Tier-C workers: user-facing on-demand fetches get their own
  // region-affine slots so they never queue behind bulk work or run from the
  // wrong egress. The local queue keeps the historical name and reroutes old
  // remote-source jobs only after their authoritative queue accepts them.
  const tiercWorkers = regions.map((region) => {
    const worker = new Worker<TierCJobData>(
      tierCQueueName(region),
      (job) => routeTierC(job, region),
      {
        connection: ingestConnection(),
        concurrency: 2,
      }
    )
    worker.on('completed', (job) => {
      console.log(`[ingest-worker] ✓ tierc ${job.id} [${region}]`)
    })
    worker.on('failed', (job, err) => {
      console.error(`[ingest-worker] ✗ tierc ${job?.id} [${region}]:`, err.message)
    })
    return worker
  })

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
    `[ingest-worker] ready (regions=${regions.join(',')}, concurrency=${INGEST_CONCURRENCY}` +
      `, fast-lane=${fastLaneEnabled() ? `on×${FAST_CONCURRENCY}` : 'off'})`
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
    await Promise.all([...workers, ...fastWorkers, ...tiercWorkers].map((w) => w.close()))
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
    // Defense-in-depth ONLY. The REAL fix is ingestClientConnect() (lib/ingest/db.ts):
    // it attaches client.on('error') at every pool.connect() site, so a mid-transaction
    // connection death (Supavisor closing the socket) is absorbed there and never
    // reaches here. This broad net stays as a last resort — the drop messages vary
    // ("terminating connection…", "(EDBHANDLEREXITED) connection to database closed",
    // "Connection terminated unexpectedly" — all verified in
    // scripts/test-edbhandler-repro.mts), so a fragile string match alone is NOT the fix.
    const msg = String((err as { message?: string })?.message ?? err)
    if (
      /EDBHANDLEREXITED|connection to database closed|terminating connection|Connection terminated|ECONNRESET/i.test(
        msg
      )
    ) {
      console.error('[ingest-worker] recoverable DB connection drop (non-fatal):', msg)
      return
    }
    console.error('[ingest-worker] UNCAUGHT EXCEPTION:', err)
    process.exit(1)
  })
}

main().catch((err) => {
  console.error('[ingest-worker] fatal:', err)
  process.exit(1)
})
