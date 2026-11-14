import type { RegionAuthorityLifecycle } from './region-authority-lifecycle'
import type { RegionConsumerRuntime } from './region-consumer-runtime'

export type NativeIngestStartupFailureCode =
  | 'authority_lost'
  | 'invalid_runtime'
  | 'rollback_failed'
  | 'startup_failed'

export class NativeIngestStartupError extends Error {
  readonly code: NativeIngestStartupFailureCode

  constructor(code: NativeIngestStartupFailureCode) {
    super(`[ingest-worker] native serving startup failed (${code})`)
    this.name = 'NativeIngestStartupError'
    this.code = code
  }
}

export interface NativeIngestAuthorityStatus {
  readonly fence: Pick<RegionAuthorityLifecycle['fence'], 'isActive' | 'signal'>
  readonly state: RegionAuthorityLifecycle['state']
}

export interface NativeIngestServingStartupSteps {
  clearServingTimer?: (timer: NodeJS.Timeout) => void
  /**
   * Monthly partition pre-creation, run once before any consumer starts
   * (2026-11 audit P1-6): the scheduled housekeeping first fires only after
   * its full 6h interval, while consumers write immediately.
   */
  ensurePartitions: () => Promise<unknown>
  lifecycle: NativeIngestAuthorityStatus
  markReady: () => unknown
  reconcileSchedulers: () => Promise<void>
  runtime: RegionConsumerRuntime
  startHeartbeat: () => Promise<NodeJS.Timeout>
  startReconcileTimer: () => NodeJS.Timeout
}

export interface NativeIngestServingRuntime {
  readonly heartbeatTimer: NodeJS.Timeout
  readonly reconcileTimer: NodeJS.Timeout
  stopServingTimers(): void
}

function nativeStartupError(code: NativeIngestStartupFailureCode): NativeIngestStartupError {
  return new NativeIngestStartupError(code)
}

function assertAuthorityActive(lifecycle: NativeIngestAuthorityStatus): void {
  if (
    lifecycle.state !== 'active' ||
    lifecycle.fence.signal.aborted ||
    !lifecycle.fence.isActive()
  ) {
    throw nativeStartupError('authority_lost')
  }
}

function assertRuntimeState(
  runtime: RegionConsumerRuntime,
  expected: RegionConsumerRuntime['state']
): void {
  if (runtime.state !== expected) throw nativeStartupError('invalid_runtime')
}

/**
 * Cross the serving boundary for an already-prepared, inert regional runtime.
 * The runtime owns consumer rollback and authority release; this gate owns the
 * shared Redis heartbeat and scheduler timers around it. No ready evidence is emitted
 * until every prerequisite is active and consumer admission has opened.
 */
export async function startNativeIngestServing({
  clearServingTimer = (timer) => clearInterval(timer),
  ensurePartitions,
  lifecycle,
  markReady,
  reconcileSchedulers,
  runtime,
  startHeartbeat,
  startReconcileTimer,
}: NativeIngestServingStartupSteps): Promise<NativeIngestServingRuntime> {
  let heartbeatTimer: NodeJS.Timeout | undefined
  let reconcileTimer: NodeJS.Timeout | undefined
  let timerCleanupFailed = false
  let timersStopped = false

  const stopServingTimers = (): void => {
    if (timersStopped) return
    timersStopped = true
    for (const timer of [reconcileTimer, heartbeatTimer]) {
      if (timer === undefined) continue
      try {
        clearServingTimer(timer)
      } catch {
        timerCleanupFailed = true
      }
    }
  }

  try {
    assertRuntimeState(runtime, 'prepared')
    assertAuthorityActive(lifecycle)

    heartbeatTimer = await startHeartbeat()
    assertAuthorityActive(lifecycle)

    await reconcileSchedulers()
    assertAuthorityActive(lifecycle)

    reconcileTimer = startReconcileTimer()
    assertAuthorityActive(lifecycle)

    await ensurePartitions()
    assertAuthorityActive(lifecycle)

    await runtime.start()
    assertRuntimeState(runtime, 'running')
    assertAuthorityActive(lifecycle)

    const readyResult = markReady()
    if (readyResult !== undefined) {
      // TypeScript permits an async callback where an unknown result is
      // accepted. Observe but reject it so ready cannot be logged later after
      // startup has already rolled back.
      void Promise.resolve(readyResult).catch(() => undefined)
      throw nativeStartupError('invalid_runtime')
    }
    assertAuthorityActive(lifecycle)

    return Object.freeze({
      heartbeatTimer,
      reconcileTimer,
      stopServingTimers,
    })
  } catch (error) {
    stopServingTimers()
    try {
      // stop() closes admission synchronously before this await and owns the
      // complete consumer drain + DB-first authority release.
      await runtime.stop('startup_failed')
    } catch {
      throw nativeStartupError('rollback_failed')
    }
    if (timerCleanupFailed) throw nativeStartupError('rollback_failed')
    if (error instanceof NativeIngestStartupError) throw error
    throw nativeStartupError('startup_failed')
  }
}
