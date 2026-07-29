import { createHash } from 'node:crypto'

export const BULL_JOB_PROVENANCE_CONTRACT = 'arena.ingest.bull-job-provenance@1' as const
export const BULL_LOCK_COMMAND_TIMEOUT_MS = 15_000
export const BULL_LOCK_DURATION_MAX_MS = 24 * 60 * 60_000
export const BULL_ATTEMPT_COUNTER_MAX = 1_000_000
export const BULL_JOB_DATA_MAX_JSON_LENGTH = 1_048_576
export const BULL_JOB_DATA_MAX_DEPTH = 64
export const BULL_JOB_DATA_MAX_VALUES = 100_000

/**
 * One Redis command owns the whole checkpoint transition. In particular, the
 * lock check and data compare cannot be separated by a competing worker write.
 */
export const BULL_JOB_DATA_CHECKPOINT_SCRIPT = `
local lock_token = redis.call('GET', KEYS[2])
if lock_token ~= ARGV[1] then
  return -1
end
if redis.call('EXISTS', KEYS[1]) ~= 1 then
  return -2
end
local current_data = redis.call('HGET', KEYS[1], 'data')
if current_data ~= ARGV[2] then
  return -3
end
redis.call('HSET', KEYS[1], 'data', ARGV[3])
return 1
`.trim()

type BullAuthorityFailureKind =
  | 'ownership_lost'
  | 'lock_unavailable'
  | 'checkpoint_job_missing'
  | 'checkpoint_data_changed'
  | 'checkpoint_unavailable'

class BullAuthorityBoundaryError extends Error {
  constructor(
    readonly kind: BullAuthorityFailureKind,
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
  data?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly queueName?: unknown
  readonly queueQualifiedName?: unknown
  readonly extendLock?: (token: string, durationMs: number) => Promise<number>
}

/** The only Redis surface needed by the exact-token checkpoint capability. */
export interface BullCheckpointEvaluator {
  eval(
    script: string,
    numberOfKeys: number,
    jobKey: string,
    lockKey: string,
    processorToken: string,
    expectedJson: string,
    nextJson: string
  ): Promise<unknown>
}

export interface BullJobCheckpointTarget {
  readonly evaluator: BullCheckpointEvaluator
  readonly jobId: string
  readonly jobKey: string
  readonly lockKey: string
  readonly queueName: string
}

export interface BullJobAuthority {
  readonly proof: BullJobProvenance
  assertActive(): void
  extendLock(durationMs: number): Promise<void>
  replaceDataIfOwned(nextData: unknown): Promise<void>
}

export interface ManagedBullJobAuthority {
  readonly authority: BullJobAuthority
  close(): void
}

const AUTHENTIC_BULL_JOB_CHECKPOINT_TARGETS = new WeakSet<object>()
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

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

/**
 * Validate Bull's public queue identity and derive only documented key shapes.
 * No access to Job.queue or another protected/internal Bull field is needed.
 */
export function createBullJobCheckpointTarget(
  proof: BullJobProvenance,
  queueQualifiedNameValue: unknown,
  evaluator: BullCheckpointEvaluator
): BullJobCheckpointTarget {
  if (
    proof.contract !== BULL_JOB_PROVENANCE_CONTRACT ||
    proof.queueName === null ||
    proof.jobId === null
  ) {
    throw new Error('[ingest-worker] Bull job identity is unavailable for checkpoint')
  }
  const queueQualifiedName = canonicalOptionalText(
    queueQualifiedNameValue,
    'queue qualified name',
    2_048
  )
  if (queueQualifiedName === null) {
    throw new TypeError('[ingest-worker] Bull queue qualified name is not canonical')
  }
  const queueSuffix = `:${proof.queueName}`
  if (
    queueQualifiedName.length <= queueSuffix.length ||
    !queueQualifiedName.endsWith(queueSuffix)
  ) {
    throw new Error(
      '[ingest-worker] Bull queue qualified name does not identify the provenance queue'
    )
  }
  let hasEvaluator = false
  try {
    hasEvaluator =
      evaluator !== null && typeof evaluator === 'object' && typeof evaluator.eval === 'function'
  } catch {
    hasEvaluator = false
  }
  if (!hasEvaluator) {
    throw new Error('[ingest-worker] Bull checkpoint evaluator is unavailable')
  }

  const jobKey = `${queueQualifiedName}:${proof.jobId}`
  const target: BullJobCheckpointTarget = Object.freeze({
    evaluator,
    jobId: proof.jobId,
    jobKey,
    lockKey: `${jobKey}:lock`,
    queueName: proof.queueName,
  })
  AUTHENTIC_BULL_JOB_CHECKPOINT_TARGETS.add(target)
  return target
}

function boundedBullCommand<T>(command: () => Promise<T>, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMessage))
    }, BULL_LOCK_COMMAND_TIMEOUT_MS)
    ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()

    let pending: Promise<T>
    try {
      pending = command()
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
    } catch (error) {
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
  })
}

function bullBoundaryError(kind: BullAuthorityFailureKind): BullAuthorityBoundaryError {
  const messages: Record<BullAuthorityFailureKind, string> = {
    ownership_lost: '[ingest-worker] Bull job lock ownership lost',
    lock_unavailable: '[ingest-worker] Bull job lock extension unavailable',
    checkpoint_job_missing: '[ingest-worker] Bull job no longer exists for checkpoint',
    checkpoint_data_changed: '[ingest-worker] Bull job data changed before checkpoint',
    checkpoint_unavailable: '[ingest-worker] Bull job data checkpoint unavailable',
  }
  return new BullAuthorityBoundaryError(kind, messages[kind])
}

interface JsonSnapshotState {
  readonly active: WeakSet<object>
  values: number
}

function invalidJobData(): TypeError {
  return new TypeError('[ingest-worker] Bull job data must be canonical plain JSON')
}

function copyPlainJsonValue(value: unknown, depth: number, state: JsonSnapshotState): unknown {
  state.values += 1
  if (depth > BULL_JOB_DATA_MAX_DEPTH || state.values > BULL_JOB_DATA_MAX_VALUES) {
    throw invalidJobData()
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalidJobData()
    return value
  }
  if (typeof value !== 'object') throw invalidJobData()
  if (state.active.has(value)) throw invalidJobData()
  state.active.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > BULL_JOB_DATA_MAX_VALUES) throw invalidJobData()
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || keys[keys.length - 1] !== 'length') {
        throw invalidJobData()
      }
      const copy: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ) {
          throw invalidJobData()
        }
        copy.push(copyPlainJsonValue(descriptor.value, depth + 1, state))
      }
      return copy
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw invalidJobData()
    const keys = Reflect.ownKeys(value)
    if (keys.length > BULL_JOB_DATA_MAX_VALUES) throw invalidJobData()
    const copy: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string' || DANGEROUS_JSON_KEYS.has(key)) throw invalidJobData()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        throw invalidJobData()
      }
      copy[key] = copyPlainJsonValue(descriptor.value, depth + 1, state)
    }
    return copy
  } finally {
    state.active.delete(value)
  }
}

function freezeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeJsonValue(child)
  return Object.freeze(value)
}

interface BullJobDataSnapshot {
  readonly data: unknown
  readonly json: string
}

function snapshotJobData(value: unknown): BullJobDataSnapshot {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw invalidJobData()
    }
    const copy = copyPlainJsonValue(value, 0, { active: new WeakSet(), values: 0 })
    const json = JSON.stringify(copy)
    if (json.length > BULL_JOB_DATA_MAX_JSON_LENGTH) throw invalidJobData()
    const roundTrip: unknown = JSON.parse(json)
    if (JSON.stringify(roundTrip) !== json) throw invalidJobData()
    return Object.freeze({ data: freezeJsonValue(roundTrip), json })
  } catch {
    throw invalidJobData()
  }
}

function currentJobDataSnapshot(job: BullJobProvenanceInput): BullJobDataSnapshot {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(job, 'data')
    if (
      descriptor === undefined ||
      !descriptor.writable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw invalidJobData()
    }
    return snapshotJobData(descriptor.value)
  } catch {
    throw invalidJobData()
  }
}

function checkpointStatusFailure(status: unknown): BullAuthorityBoundaryError | null {
  switch (status) {
    case 1:
      return null
    case -1:
      return bullBoundaryError('ownership_lost')
    case -2:
      return bullBoundaryError('checkpoint_job_missing')
    case -3:
      return bullBoundaryError('checkpoint_data_changed')
    default:
      return bullBoundaryError('checkpoint_unavailable')
  }
}

/**
 * Exact-token Bull lock and checkpoint capabilities. The returned frozen
 * authority contains no token; only its closures retain the processor token.
 */
export function createManagedBullJobAuthority(
  job: BullJobProvenanceInput,
  processorToken: string | undefined,
  signal: AbortSignal,
  checkpointTarget?: BullJobCheckpointTarget
): ManagedBullJobAuthority {
  const proof = createBullJobProvenance(job, processorToken)
  if (
    checkpointTarget !== undefined &&
    (!AUTHENTIC_BULL_JOB_CHECKPOINT_TARGETS.has(checkpointTarget) ||
      checkpointTarget.jobId !== proof.jobId ||
      checkpointTarget.queueName !== proof.queueName)
  ) {
    throw new Error('[ingest-worker] Bull checkpoint target does not match job provenance')
  }

  let closed = false
  let failure: BullAuthorityBoundaryError | undefined
  let extension: Promise<void> | null = null
  let checkpointInFlight = false
  const assertActive = () => {
    if (closed) throw new Error('[ingest-worker] Bull job authority is closed')
    if (signal.aborted) throw signal.reason
    if (failure !== undefined) throw failure
  }
  const retainFailure = (nextFailure: BullAuthorityBoundaryError): BullAuthorityBoundaryError => {
    failure ??= nextFailure
    return failure
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
    const operation = boundedBullCommand(
      () => job.extendLock!(processorToken, durationMs),
      '[ingest-worker] Bull job lock extension timed out'
    )
      .then((renewed) => {
        assertActive()
        if (renewed !== 1) throw bullBoundaryError('ownership_lost')
      })
      .catch((error) => {
        const sanitized =
          error instanceof BullAuthorityBoundaryError && error.kind === 'ownership_lost'
            ? bullBoundaryError('ownership_lost')
            : bullBoundaryError('lock_unavailable')
        throw retainFailure(sanitized)
      })
    extension = operation
    const clear = () => {
      if (extension === operation) extension = null
    }
    void operation.then(clear, clear)
    return operation
  }
  const replaceDataIfOwned = (nextData: unknown): Promise<void> => {
    let expected: BullJobDataSnapshot
    let next: BullJobDataSnapshot
    try {
      assertActive()
      if (checkpointInFlight) {
        throw new Error('[ingest-worker] Bull job data checkpoint already in progress')
      }
      if (
        typeof processorToken !== 'string' ||
        processorToken.length === 0 ||
        checkpointTarget === undefined
      ) {
        throw retainFailure(bullBoundaryError('checkpoint_unavailable'))
      }
      expected = currentJobDataSnapshot(job)
      next = snapshotJobData(nextData)
      checkpointInFlight = true
    } catch (error) {
      return Promise.reject(error)
    }

    const operation = boundedBullCommand(
      () =>
        checkpointTarget.evaluator.eval(
          BULL_JOB_DATA_CHECKPOINT_SCRIPT,
          2,
          checkpointTarget.jobKey,
          checkpointTarget.lockKey,
          processorToken,
          expected.json,
          next.json
        ),
      '[ingest-worker] Bull job data checkpoint timed out'
    )
      .then((status) => {
        assertActive()
        const statusFailure = checkpointStatusFailure(status)
        if (statusFailure !== null) throw statusFailure
        job.data = next.data
      })
      .catch((error) => {
        const sanitized =
          error instanceof BullAuthorityBoundaryError
            ? bullBoundaryError(error.kind)
            : bullBoundaryError('checkpoint_unavailable')
        throw retainFailure(sanitized)
      })
    const clear = () => {
      checkpointInFlight = false
    }
    void operation.then(clear, clear)
    return operation
  }
  const authority: BullJobAuthority = Object.freeze({
    proof,
    assertActive,
    extendLock,
    replaceDataIfOwned,
  })
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
  const lockUnavailable = (): never => {
    throw bullBoundaryError('lock_unavailable')
  }
  const checkpointUnavailable = (): never => {
    throw bullBoundaryError('checkpoint_unavailable')
  }
  return Object.freeze({
    proof,
    assertActive: lockUnavailable,
    extendLock: async () => lockUnavailable(),
    replaceDataIfOwned: async () => checkpointUnavailable(),
  })
}
