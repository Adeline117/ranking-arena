import {
  acquireRegionAuthorityLifecycle,
  type AcquireRegionAuthorityLifecycleOptions,
  type AcquireRegionAuthorityLifecycleResult,
  type RegionAuthorityLifecycle,
} from './region-authority-lifecycle'
import {
  WORKER_OWNER_LEASE_RENEW_MS,
  WORKER_OWNER_LEASE_TTL_MS,
  type WorkerOwnershipRegion,
} from './worker-instance-ownership'

/**
 * Covers a 30 second process kill window, the authority TTL, and one renewal
 * interval of scheduling/network margin without forcing the process to restart.
 */
export const REGION_AUTHORITY_ACQUISITION_CONTENTION_DEADLINE_MS =
  30_000 + WORKER_OWNER_LEASE_TTL_MS + WORKER_OWNER_LEASE_RENEW_MS
export const REGION_AUTHORITY_ACQUISITION_PARK_KEEPALIVE_MS = 60_000
export const REGION_AUTHORITY_ACQUISITION_RETRY_MS = 3_000

export type RegionAuthorityAcquisitionFailureCode =
  | 'aborted'
  | 'acquire_failed'
  | 'invalid_retry_policy'

export class RegionAuthorityAcquisitionError extends Error {
  readonly code: RegionAuthorityAcquisitionFailureCode
  readonly region: WorkerOwnershipRegion

  constructor(code: RegionAuthorityAcquisitionFailureCode, region: WorkerOwnershipRegion) {
    super(`[ingest-worker] ${region} authority acquisition failed (${code})`)
    this.name = 'RegionAuthorityAcquisitionError'
    this.code = code
    this.region = region
  }
}

type AcquireLifecycle = (
  options: AcquireRegionAuthorityLifecycleOptions
) => Promise<AcquireRegionAuthorityLifecycleResult>

export interface AcquireRegionAuthorityLifecycleWithRetryOptions extends AcquireRegionAuthorityLifecycleOptions {
  acquireLifecycle?: AcquireLifecycle
  contentionDeadlineMs?: number
  log?: (message: string) => Promise<void> | void
  retryAfterMs?: number
  signal: AbortSignal
}

type AbortTermination = {
  readonly error: RegionAuthorityAcquisitionError
  readonly kind: 'aborted'
}

type Parked = {
  readonly kind: 'parked'
}

type AcquisitionOutcome =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'result'; readonly result: AcquireRegionAuthorityLifecycleResult }

const MAX_TIMER_DELAY_MS = 2_147_483_647

function acquisitionError(
  code: RegionAuthorityAcquisitionFailureCode,
  region: WorkerOwnershipRegion
): RegionAuthorityAcquisitionError {
  return new RegionAuthorityAcquisitionError(code, region)
}

function fixedLogMessage(
  event: 'aborted' | 'acquire_failed' | 'cleanup_failed' | 'contended' | 'parked',
  region: WorkerOwnershipRegion
): string {
  switch (event) {
    case 'aborted':
      return `[ingest-worker] ${region} authority acquisition aborted`
    case 'acquire_failed':
      return `[ingest-worker] ${region} authority acquisition failed`
    case 'cleanup_failed':
      return `[ingest-worker] ${region} late authority acquisition cleanup failed`
    case 'contended':
      return `[ingest-worker] ${region} authority is contended; retrying`
    case 'parked':
      return `[ingest-worker] ${region} authority acquisition parked after contention deadline`
  }
}

function emitFixedLog(
  log: AcquireRegionAuthorityLifecycleWithRetryOptions['log'],
  message: string
): void {
  if (log === undefined) return
  try {
    const result = log(message)
    void Promise.resolve(result).catch(() => undefined)
  } catch {
    // Operator logging must never alter authority admission.
  }
}

function validateDelay(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_DELAY_MS
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
}

async function releaseLateAuthority(
  outcome: AcquisitionOutcome,
  log: AcquireRegionAuthorityLifecycleWithRetryOptions['log'],
  region: WorkerOwnershipRegion
): Promise<void> {
  try {
    if (outcome.kind !== 'result' || outcome.result.status !== 'active') return
    await outcome.result.lifecycle.stopAfterDrain(async () => undefined)
  } catch {
    emitFixedLog(log, fixedLogMessage('cleanup_failed', region))
  }
}

/**
 * Wait for one native region's authority in the current process. Only a
 * validated contention result is retried. Consumers, legacy heartbeats and
 * schedulers remain the caller's responsibility and must be created only
 * after this function returns an active lifecycle. Once the contention
 * deadline passes, retries stop and this promise remains parked until the
 * caller aborts it; a deployment handoff therefore cannot increment a process
 * restart counter merely because the old lease took the full TTL to expire.
 * Abort closes admission immediately, but this promise observes the current
 * acquire and releases any late active lifecycle before it rejects.
 */
export async function acquireRegionAuthorityLifecycleWithRetry({
  acquireAuthority,
  acquireLifecycle = acquireRegionAuthorityLifecycle,
  contentionDeadlineMs = REGION_AUTHORITY_ACQUISITION_CONTENTION_DEADLINE_MS,
  heartbeat,
  log,
  onLost,
  redis,
  region,
  renewAfterMs,
  retryAfterMs = REGION_AUTHORITY_ACQUISITION_RETRY_MS,
  scheduleRenewal,
  signal,
}: AcquireRegionAuthorityLifecycleWithRetryOptions): Promise<RegionAuthorityLifecycle> {
  if (!validateDelay(retryAfterMs) || !validateDelay(contentionDeadlineMs)) {
    throw acquisitionError('invalid_retry_policy', region)
  }
  if (signal.aborted) {
    emitFixedLog(log, fixedLogMessage('aborted', region))
    throw acquisitionError('aborted', region)
  }

  let terminate!: (termination: AbortTermination) => void
  const terminationState: { current?: AbortTermination } = {}
  const terminationPromise = new Promise<AbortTermination>((resolve) => {
    terminate = (nextTermination) => {
      if (terminationState.current !== undefined) return
      terminationState.current = nextTermination
      resolve(nextTermination)
    }
  })
  const currentTermination = (): AbortTermination | undefined => terminationState.current

  let park!: (parked: Parked) => void
  const parkedState = { current: false }
  const parkedPromise = new Promise<Parked>((resolve) => {
    park = (parked) => {
      if (parkedState.current) return
      parkedState.current = true
      resolve(parked)
    }
  })

  const abort = () => {
    emitFixedLog(log, fixedLogMessage('aborted', region))
    terminate({ error: acquisitionError('aborted', region), kind: 'aborted' })
  }
  signal.addEventListener('abort', abort, { once: true })

  let parkKeepaliveTimer: ReturnType<typeof setInterval> | undefined
  const deadlineTimer = setTimeout(() => {
    // A pending Promise does not keep Node's event loop alive. This referenced
    // interval deliberately preserves the same PID while admission is parked;
    // unlike retry/deadline timers, it remains until acquisition cleanup has
    // settled after the caller aborts.
    parkKeepaliveTimer = setInterval(
      () => undefined,
      REGION_AUTHORITY_ACQUISITION_PARK_KEEPALIVE_MS
    )
    if (terminationState.current !== undefined) return
    emitFixedLog(log, fixedLogMessage('parked', region))
    park({ kind: 'parked' })
  }, contentionDeadlineMs)
  // This deadline must stay referenced. Before parked mode creates its own
  // keepalive, a pending acquisition Promise alone cannot keep Node alive.

  try {
    while (true) {
      const beforeAcquisition = currentTermination()
      if (beforeAcquisition !== undefined) throw beforeAcquisition.error
      if (parkedState.current) throw (await terminationPromise).error

      const acquisition = Promise.resolve()
        .then(() => {
          const beforeInvocation = currentTermination()
          if (beforeInvocation !== undefined) throw beforeInvocation.error
          return acquireLifecycle({
            acquireAuthority,
            heartbeat,
            onLost,
            redis,
            region,
            renewAfterMs,
            scheduleRenewal,
          })
        })
        .then<AcquisitionOutcome, AcquisitionOutcome>(
          (result) => ({ kind: 'result', result }),
          () => ({ kind: 'rejected' })
        )

      const outcome = await Promise.race<AcquisitionOutcome | AbortTermination | Parked>([
        acquisition,
        terminationPromise,
        parkedPromise,
      ])

      if (outcome.kind === 'aborted') {
        const lateOutcome = await acquisition
        await releaseLateAuthority(lateOutcome, log, region)
        throw outcome.error
      }
      if (outcome.kind === 'parked') {
        const cleanup = acquisition
          .then((lateOutcome) => releaseLateAuthority(lateOutcome, log, region))
          .catch(() => emitFixedLog(log, fixedLogMessage('cleanup_failed', region)))
        const aborted = await terminationPromise
        await cleanup
        throw aborted.error
      }

      // Abort/deadline can be delivered in the same turn as acquisition. Never
      // hand a lifecycle to startup after termination has already won locally.
      const concurrentTermination = currentTermination()
      if (concurrentTermination !== undefined) {
        await releaseLateAuthority(outcome, log, region)
        throw concurrentTermination.error
      }
      if (parkedState.current) {
        const cleanup = releaseLateAuthority(outcome, log, region)
        const aborted = await terminationPromise
        await cleanup
        throw aborted.error
      }

      if (outcome.kind === 'rejected') {
        emitFixedLog(log, fixedLogMessage('acquire_failed', region))
        throw acquisitionError('acquire_failed', region)
      }
      if (outcome.result.status === 'active') return outcome.result.lifecycle
      if (outcome.result.status !== 'contended') {
        emitFixedLog(log, fixedLogMessage('acquire_failed', region))
        throw acquisitionError('acquire_failed', region)
      }

      emitFixedLog(log, fixedLogMessage('contended', region))
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      const retryReady = new Promise<{ readonly kind: 'retry' }>((resolve) => {
        retryTimer = setTimeout(() => resolve({ kind: 'retry' }), retryAfterMs)
        unrefTimer(retryTimer)
      })
      let retryOutcome: { readonly kind: 'retry' } | AbortTermination | Parked
      try {
        retryOutcome = await Promise.race([retryReady, terminationPromise, parkedPromise])
      } finally {
        if (retryTimer !== undefined) clearTimeout(retryTimer)
      }
      if (retryOutcome.kind === 'aborted') throw retryOutcome.error
      if (retryOutcome.kind === 'parked') throw (await terminationPromise).error
    }
  } finally {
    clearTimeout(deadlineTimer)
    if (parkKeepaliveTimer !== undefined) clearInterval(parkKeepaliveTimer)
    signal.removeEventListener('abort', abort)
  }
}
