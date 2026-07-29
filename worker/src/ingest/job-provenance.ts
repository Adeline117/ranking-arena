import { createHash } from 'node:crypto'

export const BULL_JOB_PROVENANCE_CONTRACT = 'arena.ingest.bull-job-provenance@1' as const
export const BULL_LOCK_COMMAND_TIMEOUT_MS = 15_000
export const BULL_LOCK_DURATION_MAX_MS = 24 * 60 * 60_000
export const BULL_ATTEMPT_COUNTER_MAX = 1_000_000

class BullLockBoundaryError extends Error {
  constructor(
    readonly kind: 'ownership_lost' | 'unavailable',
    message: string
  ) {
    super(message)
  }
}

export interface BullJobProvenance {
  readonly contract: typeof BULL_JOB_PROVENANCE_CONTRACT
  readonly queueName: string | null
  readonly jobId: string | null
  readonly jobName: string | null
  readonly attemptsMade: number | null
  readonly attemptsStarted: number | null
  readonly processorTokenSha256: string | null
}

export interface BullJobProvenanceInput {
  readonly attemptsMade?: unknown
  readonly attemptsStarted?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly queueName?: unknown
  readonly extendLock?: (token: string, durationMs: number) => Promise<number>
}

export interface BullJobAuthority {
  readonly proof: BullJobProvenance
  assertActive(): void
  extendLock(durationMs: number): Promise<void>
}

export interface ManagedBullJobAuthority {
  readonly authority: BullJobAuthority
  close(): void
}

function canonicalOptionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`[ingest-worker] Bull ${label} is not canonical`)
  }
  return value
}

function canonicalOptionalCounter(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > BULL_ATTEMPT_COUNTER_MAX
  ) {
    throw new TypeError(`[ingest-worker] Bull ${label} is not canonical`)
  }
  return value
}

function processorTokenSha256(processorToken: string | undefined): string | null {
  if (processorToken === undefined) return null
  if (processorToken.length === 0) {
    throw new TypeError('[ingest-worker] Bull processor token is not canonical')
  }
  return createHash('sha256').update(processorToken, 'utf8').digest('hex')
}

/**
 * Snapshot only non-secret Bull job identity at the processor boundary. The
 * exact lock token remains in bindAuthorizedConsumedRegion's local closure;
 * downstream routing receives only its one-way digest.
 */
export function createBullJobProvenance(
  job: BullJobProvenanceInput,
  processorToken?: string
): BullJobProvenance {
  const jobId =
    typeof job.id === 'number'
      ? Number.isSafeInteger(job.id) && job.id >= 0
        ? String(job.id)
        : (() => {
            throw new TypeError('[ingest-worker] Bull job id is not canonical')
          })()
      : canonicalOptionalText(job.id, 'job id', 1_024)
  const jobName = canonicalOptionalText(job.name, 'job name', 256)
  const attemptsMade = canonicalOptionalCounter(job.attemptsMade, 'attemptsMade')
  const attemptsStarted = canonicalOptionalCounter(job.attemptsStarted, 'attemptsStarted')

  return Object.freeze({
    contract: BULL_JOB_PROVENANCE_CONTRACT,
    queueName: canonicalOptionalText(job.queueName, 'queue name', 256),
    jobId,
    jobName,
    attemptsMade,
    attemptsStarted,
    processorTokenSha256: processorTokenSha256(processorToken),
  })
}

function boundedBullCommand<T>(command: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('[ingest-worker] Bull job lock extension timed out'))
    }, BULL_LOCK_COMMAND_TIMEOUT_MS)
    ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()

    let pending: Promise<T>
    try {
      pending = command()
    } catch (error) {
      settled = true
      clearTimeout(timeout)
      reject(error)
      return
    }
    void pending.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

function bullLockError(kind: 'ownership_lost' | 'unavailable'): BullLockBoundaryError {
  return new BullLockBoundaryError(
    kind,
    kind === 'ownership_lost'
      ? '[ingest-worker] Bull job lock ownership lost'
      : '[ingest-worker] Bull job lock extension unavailable'
  )
}

/**
 * Exact-token Bull lock capability. The returned frozen authority contains no
 * token; only its closures retain the processor token needed by extendLock.
 */
export function createManagedBullJobAuthority(
  job: BullJobProvenanceInput,
  processorToken: string | undefined,
  signal: AbortSignal
): ManagedBullJobAuthority {
  const proof = createBullJobProvenance(job, processorToken)
  let closed = false
  let failure: unknown
  let extension: Promise<void> | null = null
  const assertActive = () => {
    if (closed) throw new Error('[ingest-worker] Bull job authority is closed')
    if (signal.aborted) throw signal.reason
    if (failure !== undefined) throw failure
  }
  const extendLock = (durationMs: number): Promise<void> => {
    try {
      assertActive()
      if (
        !Number.isSafeInteger(durationMs) ||
        durationMs < 1 ||
        durationMs > BULL_LOCK_DURATION_MAX_MS
      ) {
        throw new TypeError('[ingest-worker] Bull lock extension duration is invalid')
      }
      if (
        typeof processorToken !== 'string' ||
        processorToken.length === 0 ||
        typeof job.extendLock !== 'function'
      ) {
        throw new Error('[ingest-worker] Bull job lock extension is unavailable')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    if (extension !== null) return extension
    extension = boundedBullCommand(() => job.extendLock!(processorToken, durationMs))
      .then((renewed) => {
        assertActive()
        if (renewed !== 1) throw bullLockError('ownership_lost')
      })
      .catch((error) => {
        const sanitized = bullLockError(
          error instanceof BullLockBoundaryError && error.kind === 'ownership_lost'
            ? 'ownership_lost'
            : 'unavailable'
        )
        failure = sanitized
        throw sanitized
      })
      .finally(() => {
        extension = null
      })
    return extension
  }
  const authority: BullJobAuthority = Object.freeze({ proof, assertActive, extendLock })
  return Object.freeze({
    authority,
    close: () => {
      closed = true
    },
  })
}

/** Proof-only fallback for direct routing tests; it owns no lock or timer. */
export function createUnownedBullJobAuthority(job: BullJobProvenanceInput): BullJobAuthority {
  const proof = createBullJobProvenance(job)
  const unavailable = (): never => {
    throw bullLockError('unavailable')
  }
  return Object.freeze({
    proof,
    assertActive: unavailable,
    extendLock: async () => unavailable(),
  })
}
