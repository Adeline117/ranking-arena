/**
 * Historical V1 ingest worker entrypoint.
 *
 * The checked-in V1 publication gate below exits before dotenv or any runtime
 * dependency loads. This source-level hold cannot inspect, stop, or prove the
 * state of an already-running host process, Redis queue, or external schedule.
 */

import { isV1IngestExecutionPublished } from '@/lib/ingest/v1-execution-publication'
import type { Job } from 'bullmq'
import type { TierCJobData } from './ingest/queues'
import type { AuthorizedConsumedRegionContext } from './ingest/consumed-region-context'
import type { BullJobAuthority } from './ingest/job-provenance'
import type { SourceJobRunProvenance } from './ingest/source-job-routing'

type ProcessCoordinator = ReturnType<
  typeof import('./ingest/native-process-coordinator').createNativeProcessCoordinator
>

let Worker: typeof import('bullmq').Worker
let getConnection: typeof import('./connection').getConnection
let closeConnection: typeof import('./connection').closeConnection
let INGEST_JOB: typeof import('./ingest/queues').INGEST_JOB
let ingestConnection: typeof import('./ingest/queues').ingestConnection
let consumedRegions: typeof import('./ingest/queues').consumedRegions
let regionQueueName: typeof import('./ingest/queues').regionQueueName
let regionFastQueueName: typeof import('./ingest/queues').regionFastQueueName
let tierCQueueName: typeof import('./ingest/queues').tierCQueueName
let fastLaneEnabled: typeof import('./ingest/queues').fastLaneEnabled
let reconcileSchedulers: typeof import('./ingest/scheduler').reconcileSchedulers
let createWorkerOwnershipHeartbeatFactory: typeof import('./ingest/heartbeat').createWorkerOwnershipHeartbeatFactory
let resolveWorkerRuntimeIdentity: typeof import('./ingest/heartbeat').resolveWorkerRuntimeIdentity
let startHeartbeat: typeof import('./ingest/heartbeat').startHeartbeat
let assertMetricTrustWorkerReadiness: typeof import('./ingest/metric-trust-readiness').assertMetricTrustWorkerReadiness
let assertWorkerEnvironmentFileLoaded: typeof import('./ingest/worker-environment-file').assertWorkerEnvironmentFileLoaded
let assertPartitionedV4WorkerReadiness: typeof import('./ingest/attempt-bound-capture-readiness').assertPartitionedV4WorkerReadiness
let startNativeIngestServing: typeof import('./ingest/startup-gate').startNativeIngestServing
let routeJobWithSourceLease: typeof import('./ingest/source-job-routing').routeJobWithSourceLease
let routeTierCJobRegion: typeof import('./ingest/tier-c-region-router').routeTierCJobRegion
let getSourceBySlug: typeof import('@/lib/ingest/sources').getSourceBySlug
let assertSourceJobMatchesConsumedRegion: typeof import('./ingest/consumed-region-context').assertSourceJobMatchesConsumedRegion
let bindAuthorizedConsumedRegion: typeof import('./ingest/consumed-region-context').bindAuthorizedConsumedRegion
let requireWorkerExecutionRegion: typeof import('./ingest/consumed-region-context').requireWorkerExecutionRegion
let resolveNativeRegionConfig: typeof import('./ingest/native-region-config').resolveNativeRegionConfig
let acquireRegionAuthorityLifecycleWithRetry: typeof import('./ingest/region-authority-acquisition').acquireRegionAuthorityLifecycleWithRetry
let prepareRegionConsumerRuntime: typeof import('./ingest/region-consumer-runtime').prepareRegionConsumerRuntime
let createNativeProcessCoordinator: typeof import('./ingest/native-process-coordinator').createNativeProcessCoordinator
let startBitgetBotAttemptHealthWatchdog: typeof import('./ingest/attempt-health-watchdog').startBitgetBotAttemptHealthWatchdog
let workerEnvironment: ReturnType<typeof import('dotenv').config>
let processCoordinator: ProcessCoordinator

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
let INGEST_CONCURRENCY = 5

// Fast-lane pool (2026-06-13 slot-starvation root fix): light Tier-A
// leaderboard crawls (board ≤ FAST_TIER_A_MAX_COUNT) run here, fully isolated
// from the bulk pool's multi-hour giants (bybit_mt5 etc.). These crawls are
// small (seconds-to-minutes) so a modest pool keeps all ~26 small boards fresh;
// peak extra concurrent browsers stay low because each session is short-lived.
const FAST_CONCURRENCY = 3
const RECONCILE_INTERVAL_MS = 60 * 60_000
const NATIVE_AUTHORITY_READY_TOKEN = '[ingest-worker] native regional authority ready'

if (!isV1IngestExecutionPublished()) {
  console.error('[RETIRED] V1 ingest execution is not published; worker will not start.')
  process.exitCode = 2
} else {
  void main().catch(() => {
    if (processCoordinator === undefined) {
      console.error('[ingest-worker] fatal startup failure')
      process.exitCode = 2
      return
    }

    const shutdownReason = processCoordinator.shutdownReason
    if (shutdownReason === undefined) console.error('[ingest-worker] fatal main failure')
    processCoordinator.settleStartup()
    void processCoordinator.requestShutdown(shutdownReason ?? 'startup_failed')
  })
}

async function initializeRuntime(): Promise<void> {
  // The caller reaches this only after the fixed V1 publication gate. Keep
  // dotenv, BullMQ, database, Redis, adapter, and provider imports deferred so
  // a disabled entrypoint has no runtime initialization path.
  const [{ resolve, dirname }, { fileURLToPath }, { config }] = await Promise.all([
    import('node:path'),
    import('node:url'),
    import('dotenv'),
  ])

  const workerDirectory = dirname(fileURLToPath(import.meta.url))
  workerEnvironment = config({ path: resolve(workerDirectory, '..', '.env') })
  INGEST_CONCURRENCY = Number(process.env.INGEST_CONCURRENCY) || 5

  const [
    bullmq,
    connection,
    queues,
    scheduler,
    heartbeat,
    metricTrust,
    workerEnvironmentFile,
    partitionedReadiness,
    startupGate,
    sourceRouting,
    tierCRouting,
    sources,
    consumedContext,
    nativeRegion,
    authority,
    consumerRuntime,
    coordinator,
    healthWatchdog,
  ] = await Promise.all([
    import('bullmq'),
    import('./connection'),
    import('./ingest/queues'),
    import('./ingest/scheduler'),
    import('./ingest/heartbeat'),
    import('./ingest/metric-trust-readiness'),
    import('./ingest/worker-environment-file'),
    import('./ingest/attempt-bound-capture-readiness'),
    import('./ingest/startup-gate'),
    import('./ingest/source-job-routing'),
    import('./ingest/tier-c-region-router'),
    import('@/lib/ingest/sources'),
    import('./ingest/consumed-region-context'),
    import('./ingest/native-region-config'),
    import('./ingest/region-authority-acquisition'),
    import('./ingest/region-consumer-runtime'),
    import('./ingest/native-process-coordinator'),
    import('./ingest/attempt-health-watchdog'),
  ])

  Worker = bullmq.Worker
  getConnection = connection.getConnection
  closeConnection = connection.closeConnection
  INGEST_JOB = queues.INGEST_JOB
  ingestConnection = queues.ingestConnection
  consumedRegions = queues.consumedRegions
  regionQueueName = queues.regionQueueName
  regionFastQueueName = queues.regionFastQueueName
  tierCQueueName = queues.tierCQueueName
  fastLaneEnabled = queues.fastLaneEnabled
  reconcileSchedulers = scheduler.reconcileSchedulers
  createWorkerOwnershipHeartbeatFactory = heartbeat.createWorkerOwnershipHeartbeatFactory
  resolveWorkerRuntimeIdentity = heartbeat.resolveWorkerRuntimeIdentity
  startHeartbeat = heartbeat.startHeartbeat
  assertMetricTrustWorkerReadiness = metricTrust.assertMetricTrustWorkerReadiness
  assertWorkerEnvironmentFileLoaded = workerEnvironmentFile.assertWorkerEnvironmentFileLoaded
  assertPartitionedV4WorkerReadiness = partitionedReadiness.assertPartitionedV4WorkerReadiness
  startNativeIngestServing = startupGate.startNativeIngestServing
  routeJobWithSourceLease = sourceRouting.routeJobWithSourceLease
  routeTierCJobRegion = tierCRouting.routeTierCJobRegion
  getSourceBySlug = sources.getSourceBySlug
  assertSourceJobMatchesConsumedRegion = consumedContext.assertSourceJobMatchesConsumedRegion
  bindAuthorizedConsumedRegion = consumedContext.bindAuthorizedConsumedRegion
  requireWorkerExecutionRegion = consumedContext.requireWorkerExecutionRegion
  resolveNativeRegionConfig = nativeRegion.resolveNativeRegionConfig
  acquireRegionAuthorityLifecycleWithRetry = authority.acquireRegionAuthorityLifecycleWithRetry
  prepareRegionConsumerRuntime = consumerRuntime.prepareRegionConsumerRuntime
  createNativeProcessCoordinator = coordinator.createNativeProcessCoordinator
  startBitgetBotAttemptHealthWatchdog = healthWatchdog.startBitgetBotAttemptHealthWatchdog

  processCoordinator = createNativeProcessCoordinator({
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
}

async function runJob(
  job: Job,
  context: AuthorizedConsumedRegionContext,
  provenance: SourceJobRunProvenance,
  signal: AbortSignal
): Promise<unknown> {
  // Safe hand-off point for a future queue/source claim coordinator. Only
  // one-way token digests and the public lease proof can cross this boundary.
  void provenance
  const { runMaintenanceWithStandby } = await import('./ingest/maintenance-standby')
  const pagePrimaryDown = async (jobName: string) => {
    const { alert } = await import('@/lib/ingest/alerting')
    await alert(getConnection(), {
      sourceSlug: `framework:maintenance-primary-down:${jobName}`,
      phase: 0,
      tier: 'A',
      page: true,
      message:
        `${jobName}: the primary (local) node has not run this maintenance job for over 1.5× ` +
        'its cadence; the SG standby took over. The primary node is likely down — restart it.',
    })
  }
  switch (job.name) {
    case INGEST_JOB.TIER_A: {
      const { processTierA } = await import('./ingest/processors/tier-a-leaderboard')
      return processTierA(job, context, provenance, signal)
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
    case INGEST_JOB.AVATAR_MIRROR:
      return { mirrored: 0, failed: 0 }
    case INGEST_JOB.MAINTENANCE: {
      const { processMaintenance } = await import('./ingest/processors/maintenance')
      return runMaintenanceWithStandby(
        getConnection(),
        job.name,
        job.data,
        () => processMaintenance(job),
        Date.now,
        pagePrimaryDown
      )
    }
    case INGEST_JOB.FRESHNESS: {
      const { processFreshness } = await import('./ingest/processors/freshness-sentinel')
      return runMaintenanceWithStandby(
        getConnection(),
        job.name,
        job.data,
        () => processFreshness(job),
        Date.now,
        pagePrimaryDown
      )
    }
    case INGEST_JOB.DAILY_DIGEST: {
      const { processDailyDigest } = await import('./ingest/processors/daily-digest')
      return runMaintenanceWithStandby(
        getConnection(),
        job.name,
        job.data,
        () => processDailyDigest(job),
        Date.now,
        pagePrimaryDown
      )
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
  // Old queue entries can remain after source publication is withdrawn. Drop
  // this retired identity in route() before this handler's getConnection(),
  // per-job source lease, or processor load. A running BullMQ worker can
  // already have its shared Redis connection; this branch makes no claim about it.
  if (job.name === INGEST_JOB.AVATAR_MIRROR) return { mirrored: 0, failed: 0 }

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
  // This is reachable only after the checked-in V1 gate. Dependency loading is
  // deferred to here, before any dotenv-driven runtime, DB, Redis, BullMQ, or
  // provider operation can begin.
  await initializeRuntime()

  // Runtime dependencies are loaded but no worker resource has been created;
  // capture signals before beginning the first native setup phase.
  installProcessHandlers()
  console.log('[ingest-worker] starting…')

  try {
    // The box-local file is the runtime authority; inherited PM2/shell state
    // cannot stand in for a missing file.
    assertWorkerEnvironmentFileLoaded(workerEnvironment)

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
          new Worker(regionQueueName(region), bindAuthorizedConsumedRegion(context, route, redis), {
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
          // Completion mark for the deep-crawl stall page (audit HOP-2).
          const tier =
            job.name === INGEST_JOB.TIER_B ? 'B' : job.name === INGEST_JOB.TIER_D ? 'D' : null
          const slug: unknown = job.data?.sourceSlug
          if (tier && typeof slug === 'string') {
            void import('./ingest/progress').then((m) => m.noteDeepCrawlCompleted(tier, slug))
          }
        })
        bulkWorker.on('failed', (job, error) => {
          console.error(`[ingest-worker] ✗ ${job?.name} (${job?.id}) [${region}]:`, error.message)
        })

        if (fastLane) {
          const fastWorker = register(
            new Worker(
              regionFastQueueName(region),
              bindAuthorizedConsumedRegion(context, route, redis),
              {
                autorun: false,
                connection: ingestConnection(),
                concurrency: FAST_CONCURRENCY,
                lockDuration: 180_000,
                stalledInterval: 300_000,
                maxStalledCount: 2,
              }
            )
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
            bindAuthorizedConsumedRegion(context, routeTierC, redis),
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
      // Same idempotent call as maint:housekeeping; fail-closed before consumers.
      ensurePartitions: async () => {
        const { ensurePartitions } = await import('@/lib/ingest/serving/series')
        return ensurePartitions()
      },
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
        // Output-watermark grace baseline (audit P2-8); best-effort, never throws.
        const { markWorkerStarted } = await import('./ingest/progress')
        await markWorkerStarted(redis, runtimeIdentity.node)
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
