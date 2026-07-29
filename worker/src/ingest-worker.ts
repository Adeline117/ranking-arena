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
const workerEnvironment = config({ path: resolve(__dirname, '..', '.env') })

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
  type TierCJobData,
} from './ingest/queues'
import { reconcileSchedulers } from './ingest/scheduler'
import {
  createWorkerOwnershipHeartbeatFactory,
  resolveWorkerRuntimeIdentity,
  startHeartbeat,
} from './ingest/heartbeat'
import { assertMetricTrustWorkerReadiness } from './ingest/metric-trust-readiness'
import {
  assertAttemptBoundCaptureEnvironmentFile,
  assertAttemptBoundCaptureRuntimeEnabled,
} from './ingest/attempt-bound-capture-runtime'
import { assertPartitionedV4WorkerReadiness } from './ingest/attempt-bound-capture-readiness'
import { startNativeIngestServing } from './ingest/startup-gate'
import { routeJobWithSourceLease } from './ingest/source-job-routing'
import { routeTierCJobRegion } from './ingest/tier-c-region-router'
import { getSourceBySlug } from '@/lib/ingest/sources'
import {
  assertSourceJobMatchesConsumedRegion,
  bindAuthorizedConsumedRegion,
  requireWorkerExecutionRegion,
  type AuthorizedConsumedRegionContext,
} from './ingest/consumed-region-context'
import { resolveNativeRegionConfig } from './ingest/native-region-config'
import { acquireRegionAuthorityLifecycleWithRetry } from './ingest/region-authority-acquisition'
import { prepareRegionConsumerRuntime } from './ingest/region-consumer-runtime'
import { createNativeProcessCoordinator } from './ingest/native-process-coordinator'
import { startBitgetBotAttemptHealthWatchdog } from './ingest/attempt-health-watchdog'
import type { BullJobAuthority } from './ingest/job-provenance'
import type { SourceJobRunProvenance } from './ingest/source-job-routing'

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
const RECONCILE_INTERVAL_MS = 60 * 60_000
const NATIVE_AUTHORITY_READY_TOKEN = '[ingest-worker] native regional authority ready'

async function runJob(
  job: Job,
  context: AuthorizedConsumedRegionContext,
  provenance: SourceJobRunProvenance,
  signal: AbortSignal
): Promise<unknown> {
  // Safe hand-off point for a future queue/source claim coordinator. Only
  // one-way token digests and the public lease proof can cross this boundary.
  void provenance
  switch (job.name) {
    case INGEST_JOB.TIER_A: {
      const { processTierA } = await import('./ingest/processors/tier-a-leaderboard')
      return processTierA(job, context, signal)
    }
    case INGEST_JOB.TIER_B: {
      const { processTierB } = await import('./ingest/processors/tier-b-profiles')
      return processTierB(job, context)
    }
    case INGEST_JOB.TIER_B_SERIES: {
      const { processTierBSeries } = await import('./ingest/processors/tier-b-series')
      return processTierBSeries(job, context)
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
      return processTierD(job, context)
    }
    case INGEST_JOB.DERIVE_BOARDS: {
      const { processDeriveBoards } = await import('./ingest/processors/derive-boards')
      return processDeriveBoards(job, context)
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

async function route(
  job: Job,
  context: AuthorizedConsumedRegionContext,
  bullJob: BullJobAuthority,
  signal?: AbortSignal
): Promise<unknown> {
  return routeJobWithSourceLease({
    redis: getConnection(),
    job,
    bullJob,
    signal,
    run: async (provenance, runSignal) => {
      await assertSourceJobMatchesConsumedRegion(
        job,
        context,
        async (sourceSlug) => (await getSourceBySlug(sourceSlug)).fetch_region
      )
      return runJob(job, context, provenance, runSignal)
    },
  })
}

async function routeTierC(
  job: Job<TierCJobData>,
  context: AuthorizedConsumedRegionContext,
  _bullJob: BullJobAuthority,
  _signal?: AbortSignal
): Promise<unknown> {
  const decision = await routeTierCJobRegion(job, context.consumedRegion)
  if (decision.action === 'rerouted') {
    console.warn(
      `[ingest-worker] ↪ tierc ${decision.jobId} rerouted ${decision.from} → ${decision.to}`
    )
    return decision
  }
  const { processTierC } = await import('./ingest/processors/tier-c-profile')
  return processTierC(job, context.consumedRegion)
}

const processCoordinator = createNativeProcessCoordinator({
  closeDatabase: async () => {
    const { closeIngestPool } = await import('@/lib/ingest/db')
    await closeIngestPool()
  },
  closeRedis: closeConnection,
  markFatal: (code) => {
    console.error(`[ingest-worker] native process shutdown failed (${code})`)
  },
  setExitCode: (code) => {
    process.exitCode = code
  },
})

let processHandlersInstalled = false

function installProcessHandlers(): void {
  if (processHandlersInstalled) return
  processHandlersInstalled = true

  const requestSignalShutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    console.log(`[ingest-worker] ${signal} — shutting down…`)
    void processCoordinator.requestShutdown('signal')
  }
  process.once('SIGINT', () => requestSignalShutdown('SIGINT'))
  process.once('SIGTERM', () => requestSignalShutdown('SIGTERM'))

  process.on('unhandledRejection', () => {
    console.error('[ingest-worker] unhandled rejection')
    void processCoordinator.requestShutdown('consumer_failed')
  })
  process.on('uncaughtException', () => {
    console.error('[ingest-worker] uncaught exception')
    void processCoordinator.requestShutdown('consumer_failed')
  })
}

async function main(): Promise<void> {
  // Signals and fatal process events must be captured before the first await;
  // startup may already own a database or Redis operation when they arrive.
  installProcessHandlers()
  console.log('[ingest-worker] starting…')

  try {
    // The box-local file is the rollout authority. Prove both its literal value
    // and the effective process value so inherited PM2/shell state cannot mask
    // a missing or disabled release flag.
    assertAttemptBoundCaptureEnvironmentFile(workerEnvironment)
    assertAttemptBoundCaptureRuntimeEnabled(process.env)

    // No scheduler, BullMQ consumer, heartbeat, or authority attempt may start
    // until the production database proves the exact source-lineage contract.
    await assertMetricTrustWorkerReadiness()
    processCoordinator.assertStartupOpen()
    console.log('[ingest-worker] metric-trust database release contract ready')
    await assertPartitionedV4WorkerReadiness()
    processCoordinator.assertStartupOpen()
    console.log('[ingest-worker] partitioned V4 database release contract ready')

    // Register adapters (side-effect imports add them to the registry).
    await import('@/lib/ingest/adapters/register')
    processCoordinator.assertStartupOpen()

    const regions = consumedRegions()
    const executionRegion = requireWorkerExecutionRegion(process.env.INGEST_LOCAL_REGION)
    const nativeConfig = resolveNativeRegionConfig(regions, executionRegion)
    const region = nativeConfig.nativeRegion
    const redis = getConnection()
    const runtimeIdentity = resolveWorkerRuntimeIdentity()
    const buildAuthorityHeartbeat = createWorkerOwnershipHeartbeatFactory(runtimeIdentity, region)

    console.warn(
      '[ingest-worker] cross-region failover disabled pending a fenced target authority lifecycle'
    )
    const lifecycle = await acquireRegionAuthorityLifecycleWithRetry({
      heartbeat: buildAuthorityHeartbeat,
      log: (message) => console.warn(message),
      onLost: (failure) => {
        console.error(`[ingest-worker] regional authority lost (${failure.code})`)
        void processCoordinator.requestShutdown('authority_lost')
      },
      redis,
      region,
      signal: processCoordinator.startupSignal,
    })
    processCoordinator.bindLifecycle(lifecycle)
    processCoordinator.assertStartupOpen()

    const fastLane = fastLaneEnabled()
    const runtime = await prepareRegionConsumerRuntime({
      createConsumers: (context, register) => {
        const bulkWorker = register(
          new Worker(regionQueueName(region), bindAuthorizedConsumedRegion(context, route), {
            autorun: false,
            connection: ingestConnection(),
            concurrency: INGEST_CONCURRENCY,
            // Tier-A full crawls run 25-90 min; default 30s lock + stall detection
            // misfires across pm2 restarts ("job stalled more than allowable limit").
            lockDuration: 180_000,
            stalledInterval: 300_000,
            maxStalledCount: 2,
          })
        )
        bulkWorker.on('completed', (job) => {
          console.log(`[ingest-worker] ✓ ${job.name} (${job.id}) [${region}]`)
        })
        bulkWorker.on('failed', (job, error) => {
          console.error(`[ingest-worker] ✗ ${job?.name} (${job?.id}) [${region}]:`, error.message)
        })

        if (fastLane) {
          const fastWorker = register(
            new Worker(regionFastQueueName(region), bindAuthorizedConsumedRegion(context, route), {
              autorun: false,
              connection: ingestConnection(),
              concurrency: FAST_CONCURRENCY,
              lockDuration: 180_000,
              stalledInterval: 300_000,
              maxStalledCount: 2,
            })
          )
          fastWorker.on('completed', (job) => {
            console.log(`[ingest-worker] ✓ ${job.name} (${job.id}) [${region}/fast]`)
          })
          fastWorker.on('failed', (job, error) => {
            console.error(
              `[ingest-worker] ✗ ${job?.name} (${job?.id}) [${region}/fast]:`,
              error.message
            )
          })
        }

        const tierCWorker = register(
          new Worker<TierCJobData>(
            tierCQueueName(region),
            bindAuthorizedConsumedRegion(context, routeTierC),
            {
              autorun: false,
              connection: ingestConnection(),
              concurrency: 2,
            }
          )
        )
        tierCWorker.on('completed', (job) => {
          console.log(`[ingest-worker] ✓ tierc ${job.id} [${region}]`)
        })
        tierCWorker.on('failed', (job, error) => {
          console.error(`[ingest-worker] ✗ tierc ${job?.id} [${region}]:`, error.message)
        })
      },
      executionRegion: nativeConfig.executionRegion,
      lifecycle,
      onUnexpectedStop: (failure, regionalShutdown) => {
        console.error(`[ingest-worker] regional consumers stopped (${failure.code})`)
        return processCoordinator.requestShutdown(
          failure.code === 'authority_lost' ? 'authority_lost' : 'consumer_failed',
          regionalShutdown
        )
      },
      startupSignal: processCoordinator.startupSignal,
    })
    processCoordinator.bindRuntime(runtime)
    processCoordinator.assertStartupOpen()

    let reconcileInFlight: Promise<void> | undefined
    const reconcileOnce = (): Promise<void> => {
      if (reconcileInFlight !== undefined) return reconcileInFlight
      processCoordinator.assertStartupOpen()
      const reconciliation = reconcileSchedulers()
      processCoordinator.trackReconcile(reconciliation)
      const operation = reconciliation.then(() => processCoordinator.assertStartupOpen())
      reconcileInFlight = operation
      const clear = () => {
        if (reconcileInFlight === operation) reconcileInFlight = undefined
      }
      void operation.then(clear, clear)
      return operation
    }

    await startNativeIngestServing({
      lifecycle,
      markReady: () => {
        processCoordinator.assertStartupOpen()
        console.log(`${NATIVE_AUTHORITY_READY_TOKEN} region=${region}`)
        console.log(
          `[ingest-worker] ready (regions=${nativeConfig.consumedRegions.join(',')}, ` +
            `concurrency=${INGEST_CONCURRENCY}, ` +
            `fast-lane=${fastLane ? `on×${FAST_CONCURRENCY}` : 'off'})`
        )
      },
      reconcileSchedulers: reconcileOnce,
      runtime,
      startHeartbeat: async () => {
        const timer = await startHeartbeat(redis, nativeConfig.consumedRegions, runtimeIdentity)
        try {
          processCoordinator.bindHeartbeatTimer(() => clearInterval(timer))
          processCoordinator.assertStartupOpen()
          return timer
        } catch (error) {
          clearInterval(timer)
          throw error
        }
      },
      startReconcileTimer: () => {
        const timer = setInterval(() => {
          if (processCoordinator.shutdownReason !== undefined) return
          void reconcileOnce().catch(() => {
            if (processCoordinator.shutdownReason === undefined) {
              console.error('[ingest-worker] periodic reconcile failed')
            }
          })
        }, RECONCILE_INTERVAL_MS)
        timer.unref?.()
        try {
          processCoordinator.bindReconcileTimer(() => clearInterval(timer))
          processCoordinator.assertStartupOpen()
          return timer
        } catch (error) {
          clearInterval(timer)
          throw error
        }
      },
    })
    processCoordinator.assertStartupOpen()

    const attemptHealthWatchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      track: (operation) => processCoordinator.trackReconcile(operation),
    })
    try {
      processCoordinator.bindAttemptHealthTimer(attemptHealthWatchdog.stop)
      processCoordinator.assertStartupOpen()
    } catch (error) {
      attemptHealthWatchdog.stop()
      throw error
    }
  } catch (error) {
    if (processCoordinator.shutdownReason === undefined) {
      const message = error instanceof Error ? error.message : ''
      console.error(
        message.startsWith('[ingest-worker] partitioned V4 startup gate failed closed:')
          ? message
          : '[ingest-worker] startup failed'
      )
    }
    void processCoordinator.requestShutdown(processCoordinator.shutdownReason ?? 'startup_failed')
  } finally {
    processCoordinator.settleStartup()
  }

  const shutdownReason = processCoordinator.shutdownReason
  if (shutdownReason !== undefined) {
    await processCoordinator.requestShutdown(shutdownReason)
  }
}

void main().catch(() => {
  const shutdownReason = processCoordinator.shutdownReason
  if (shutdownReason === undefined) console.error('[ingest-worker] fatal main failure')
  processCoordinator.settleStartup()
  void processCoordinator.requestShutdown(shutdownReason ?? 'startup_failed')
})
