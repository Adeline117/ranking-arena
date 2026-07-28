import {
  acquireWorkerDbFenceAuthority,
  type AcquireWorkerDbFenceResult,
  type WorkerDbFence,
  type WorkerDbFencedWrite,
} from './worker-db-fence'
import {
  normalizeWorkerOwnershipHeartbeat,
  WORKER_OWNER_LEASE_RENEW_MS,
  type WorkerOwnershipHeartbeatInput,
  type WorkerOwnershipRedis,
  type WorkerAuthorityScope,
  type WorkerOwnershipRegion,
} from './worker-instance-ownership'

export type RegionAuthorityLifecycleState = 'active' | 'lost' | 'stopped' | 'stopping'

export type RegionAuthorityFailureCode =
  | 'authority_lost'
  | 'drain_failed'
  | 'heartbeat_invalid'
  | 'proof_mismatch'
  | 'release_failed'
  | 'renew_failed'
  | 'renew_schedule_failed'

export class RegionAuthorityLifecycleError extends Error {
  readonly code: RegionAuthorityFailureCode
  readonly region: WorkerOwnershipRegion

  constructor(code: RegionAuthorityFailureCode, region: WorkerOwnershipRegion) {
    super(`[ingest-worker] ${region} authority lifecycle failed (${code})`)
    this.name = 'RegionAuthorityLifecycleError'
    this.code = code
    this.region = region
  }
}

export interface RegionAuthorityLifecycle {
  readonly failure: RegionAuthorityLifecycleError | undefined
  /** Runtime-limited write capability. Renewal and release stay private. */
  readonly fence: RegionAuthorityFence
  readonly region: WorkerOwnershipRegion
  readonly state: RegionAuthorityLifecycleState
  /**
   * Keep renewing while drain runs. Only after the caller proves that every
   * consumer has stopped does the fence release database authority first and
   * the Redis owner token second. A failed drain deliberately retains the
   * authority until its leases expire instead of admitting a second owner.
   */
  stopAfterDrain(drain: () => Promise<void>): Promise<void>
}

export interface RegionAuthorityFence {
  readonly proof: WorkerDbFence['proof']
  readonly signal: AbortSignal
  readonly state: WorkerDbFence['state']
  isActive(): boolean
  withFencedWrite<T>(callback: (transaction: WorkerDbFencedWrite) => Promise<T>): Promise<T>
}

export type AcquireRegionAuthorityLifecycleResult =
  | {
      readonly authorityScope: WorkerAuthorityScope
      readonly observedControlEpoch: number
      readonly observedControlServerTimeMs: number
      readonly region: WorkerOwnershipRegion
      readonly status: 'contended'
    }
  | { readonly lifecycle: RegionAuthorityLifecycle; readonly status: 'active' }

type AcquireAuthority = (options: {
  heartbeat: WorkerOwnershipHeartbeatInput
  redis: WorkerOwnershipRedis
}) => Promise<AcquireWorkerDbFenceResult>

export interface RegionAuthorityRenewalTimer {
  cancel(): void
  unref?(): void
}

export interface AcquireRegionAuthorityLifecycleOptions {
  acquireAuthority?: AcquireAuthority
  heartbeat: () => WorkerOwnershipHeartbeatInput
  onLost: (failure: RegionAuthorityLifecycleError) => Promise<void> | void
  redis: WorkerOwnershipRedis
  region: WorkerOwnershipRegion
  renewAfterMs?: number
  scheduleRenewal?: (callback: () => void, delayMs: number) => RegionAuthorityRenewalTimer
}

function lifecycleError(
  code: RegionAuthorityFailureCode,
  region: WorkerOwnershipRegion
): RegionAuthorityLifecycleError {
  return new RegionAuthorityLifecycleError(code, region)
}

function exactHeartbeat(
  build: () => WorkerOwnershipHeartbeatInput,
  region: WorkerOwnershipRegion
): WorkerOwnershipHeartbeatInput {
  let heartbeat: WorkerOwnershipHeartbeatInput
  try {
    heartbeat = normalizeWorkerOwnershipHeartbeat(build())
  } catch {
    throw lifecycleError('heartbeat_invalid', region)
  }
  if (heartbeat.regions[0] !== region) {
    throw lifecycleError('heartbeat_invalid', region)
  }
  return heartbeat
}

/**
 * Own the renewal and release lifecycle around the existing composite fence.
 * This module intentionally does not create consumers. Callers must acquire
 * an active lifecycle first, then construct region-bound consumers, and pass
 * their complete drain into stopAfterDrain().
 */
export async function acquireRegionAuthorityLifecycle({
  acquireAuthority = acquireWorkerDbFenceAuthority,
  heartbeat: buildHeartbeat,
  onLost,
  redis,
  region,
  renewAfterMs = WORKER_OWNER_LEASE_RENEW_MS,
  scheduleRenewal = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    return {
      cancel: () => clearTimeout(timer),
      unref: () => timer.unref?.(),
    }
  },
}: AcquireRegionAuthorityLifecycleOptions): Promise<AcquireRegionAuthorityLifecycleResult> {
  if (
    !Number.isSafeInteger(renewAfterMs) ||
    renewAfterMs <= 0 ||
    renewAfterMs > WORKER_OWNER_LEASE_RENEW_MS
  ) {
    throw lifecycleError('renew_schedule_failed', region)
  }

  const acquired = await acquireAuthority({
    heartbeat: exactHeartbeat(buildHeartbeat, region),
    redis,
  })
  if (acquired.status === 'contended') {
    if (acquired.region !== region || acquired.authorityScope !== `region:${region}`) {
      throw lifecycleError('proof_mismatch', region)
    }
    return Object.freeze({
      authorityScope: acquired.authorityScope,
      observedControlEpoch: acquired.observedControlEpoch,
      observedControlServerTimeMs: acquired.observedControlServerTimeMs,
      region,
      status: 'contended' as const,
    })
  }

  const fence = acquired.fence
  if (fence.proof.region !== region || fence.proof.authorityScope !== `region:${region}`) {
    await fence.release().catch(() => undefined)
    throw lifecycleError('proof_mismatch', region)
  }

  let state: RegionAuthorityLifecycleState = 'active'
  let failure: RegionAuthorityLifecycleError | undefined
  let lossNotified = false
  let renewalEnabled = true
  let renewalTimer: RegionAuthorityRenewalTimer | undefined
  let renewalInFlight: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let intentionalRelease = false

  const clearRenewalTimer = () => {
    renewalTimer?.cancel()
    renewalTimer = undefined
  }

  const notifyLoss = (nextFailure: RegionAuthorityLifecycleError) => {
    if (failure === undefined) failure = nextFailure
    if (state !== 'stopped') state = 'lost'
    renewalEnabled = false
    clearRenewalTimer()
    if (lossNotified) return
    lossNotified = true
    try {
      const notification = onLost(failure)
      void Promise.resolve(notification).catch(() => {
        console.error(`[ingest-worker] ${region} authority loss callback failed`)
      })
    } catch {
      console.error(`[ingest-worker] ${region} authority loss callback failed`)
    }
  }

  const scheduleNextRenewal = () => {
    if (!renewalEnabled || renewalTimer !== undefined || renewalInFlight !== undefined) return
    renewalTimer = scheduleRenewal(() => {
      renewalTimer = undefined
      if (!renewalEnabled || renewalInFlight !== undefined) return

      const task = (async () => {
        try {
          const heartbeat = exactHeartbeat(buildHeartbeat, region)
          await fence.renewAndPublish(heartbeat)
          if (!fence.isActive()) throw lifecycleError('authority_lost', region)
        } catch (error) {
          notifyLoss(
            error instanceof RegionAuthorityLifecycleError
              ? error
              : lifecycleError('renew_failed', region)
          )
        }
      })()
      renewalInFlight = task
      void task.finally(() => {
        if (renewalInFlight === task) renewalInFlight = undefined
        if (!renewalEnabled) return
        try {
          scheduleNextRenewal()
        } catch {
          notifyLoss(lifecycleError('renew_schedule_failed', region))
        }
      })
    }, renewAfterMs)
    renewalTimer.unref?.()
  }

  fence.signal.addEventListener(
    'abort',
    () => {
      if (!intentionalRelease) notifyLoss(lifecycleError('authority_lost', region))
    },
    { once: true }
  )

  if (fence.signal.aborted || !fence.isActive()) {
    notifyLoss(lifecycleError('authority_lost', region))
    await fence.release().catch(() => undefined)
    throw failure
  }

  try {
    scheduleNextRenewal()
  } catch {
    notifyLoss(lifecycleError('renew_schedule_failed', region))
    await fence.release().catch(() => undefined)
    throw failure
  }

  // Do not leak renewAndPublish() or release(). This must be a distinct runtime
  // object, not a TypeScript-only Pick that still exposes lifecycle controls.
  const writeFence: RegionAuthorityFence = Object.freeze({
    get proof() {
      return fence.proof
    },
    get signal() {
      return fence.signal
    },
    get state() {
      return fence.state
    },
    isActive: () => fence.isActive(),
    withFencedWrite: <T>(callback: (transaction: WorkerDbFencedWrite) => Promise<T>): Promise<T> =>
      fence.withFencedWrite(callback),
  })

  const lifecycle: RegionAuthorityLifecycle = {
    get failure() {
      return failure
    },
    fence: writeFence,
    region,
    get state() {
      return state
    },
    stopAfterDrain: (drain) => {
      if (stopPromise) return stopPromise
      if (state === 'stopped') return Promise.resolve()
      if (typeof drain !== 'function') {
        return Promise.reject(lifecycleError('drain_failed', region))
      }
      if (state === 'active') state = 'stopping'

      // Defer drain until after stopPromise is assigned. A synchronous drain
      // callback may re-enter stopAfterDrain(); it must observe and return this
      // exact memoized operation instead of starting a second release path.
      stopPromise = Promise.resolve().then(async () => {
        try {
          await drain()
        } catch {
          notifyLoss(lifecycleError('drain_failed', region))
          throw failure
        }

        renewalEnabled = false
        clearRenewalTimer()
        if (renewalInFlight !== undefined) await renewalInFlight

        intentionalRelease = true
        try {
          await fence.release()
        } catch {
          const releaseFailure = lifecycleError('release_failed', region)
          notifyLoss(releaseFailure)
          throw failure ?? releaseFailure
        }
        state = 'stopped'
        if (failure !== undefined) throw failure
      })
      return stopPromise
    },
  }

  return Object.freeze({ lifecycle: Object.freeze(lifecycle), status: 'active' as const })
}
