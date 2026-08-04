import { ingestClientConnect, type IngestQueryExecutor } from '@/lib/ingest/db'

export const HISTORY_TRANSACTION_FAILURE_CONTRACT =
  'arena.ingest.history-transaction-failure@1' as const

export type HistoryTransactionFailureStage =
  | 'connect'
  | 'begin'
  | 'operation'
  | 'commit'
  | 'rollback'
  | 'release'

export type HistoryTransactionOutcome = 'not_committed' | 'committed' | 'ambiguous'

/**
 * `exact_input_only` is deliberately narrower than a general retry signal. If
 * COMMIT may already have succeeded, a publisher may reconcile or replay only
 * the same idempotency-bound input; it must not create a fresh publication.
 */
export type HistoryTransactionReplayPolicy = 'caller_decides' | 'exact_input_only' | 'never'

export type HistoryTransactionClientDisposition =
  | 'not_acquired'
  | 'released_reusable'
  | 'destroyed'
  | 'release_failed'

export interface HistoryTransactionFailure {
  readonly contract: typeof HISTORY_TRANSACTION_FAILURE_CONTRACT
  readonly code: 'history_transaction_failed'
  /** The last phase that failed, including rollback/release cleanup. */
  readonly stage: HistoryTransactionFailureStage
  /** The phase whose failure caused transaction processing to stop. */
  readonly primaryStage: HistoryTransactionFailureStage
  /** Ordered phases that failed; the primary phase is always first. */
  readonly failedStages: readonly HistoryTransactionFailureStage[]
  readonly outcome: HistoryTransactionOutcome
  readonly outcomeAmbiguous: boolean
  readonly replayPolicy: HistoryTransactionReplayPolicy
  readonly primaryCause: unknown
  readonly rollbackCause?: unknown
  readonly releaseCause?: unknown
  readonly clientDisposition: HistoryTransactionClientDisposition
  readonly destroyRequested: boolean
  readonly releaseSucceeded: boolean | null
}

export type HistoryTransactionError = Error & {
  readonly historyTransactionFailure: HistoryTransactionFailure
}

// Callers make replay decisions from this metadata. A matching public string,
// or even a genuine contract copied from another failure, is not authority:
// only the exact error/contract pair created inside this boundary is trusted.
const HISTORY_TRANSACTION_FAILURES = new WeakMap<object, HistoryTransactionFailure>()

interface PendingTransactionFailure {
  readonly primaryCause: unknown
  readonly primaryStage: 'begin' | 'operation' | 'commit'
  readonly outcome: 'not_committed' | 'ambiguous'
  rollbackCause?: unknown
  rollbackFailed: boolean
}

interface FailureContractInput {
  readonly primaryCause: unknown
  readonly primaryStage: HistoryTransactionFailureStage
  readonly outcome: HistoryTransactionOutcome
  readonly failedStages: HistoryTransactionFailureStage[]
  readonly rollbackFailed?: boolean
  readonly rollbackCause?: unknown
  readonly releaseFailed?: boolean
  readonly releaseCause?: unknown
  readonly destroyRequested: boolean
  readonly clientDisposition: HistoryTransactionClientDisposition
  readonly releaseSucceeded: boolean | null
}

function replayPolicyFor(outcome: HistoryTransactionOutcome): HistoryTransactionReplayPolicy {
  if (outcome === 'ambiguous') return 'exact_input_only'
  if (outcome === 'committed') return 'never'
  return 'caller_decides'
}

function failureContract(input: FailureContractInput): HistoryTransactionFailure {
  const failedStages = Object.freeze([...input.failedStages])
  const failure: HistoryTransactionFailure = {
    contract: HISTORY_TRANSACTION_FAILURE_CONTRACT,
    code: 'history_transaction_failed',
    stage: failedStages.at(-1) ?? input.primaryStage,
    primaryStage: input.primaryStage,
    failedStages,
    outcome: input.outcome,
    outcomeAmbiguous: input.outcome === 'ambiguous',
    replayPolicy: replayPolicyFor(input.outcome),
    primaryCause: input.primaryCause,
    clientDisposition: input.clientDisposition,
    destroyRequested: input.destroyRequested,
    releaseSucceeded: input.releaseSucceeded,
    ...(input.rollbackFailed ? { rollbackCause: input.rollbackCause } : {}),
    ...(input.releaseFailed ? { releaseCause: input.releaseCause } : {}),
  }
  return Object.freeze(failure)
}

function fallbackError(cause: unknown): Error {
  const error = new Error(cause instanceof Error ? cause.message : String(cause), { cause })
  if (cause instanceof Error) error.name = cause.name
  return error
}

function attachFailureContract(
  cause: unknown,
  failure: HistoryTransactionFailure
): HistoryTransactionError {
  const error = cause instanceof Error ? cause : fallbackError(cause)
  try {
    if (Object.hasOwn(error, 'historyTransactionFailure')) throw new TypeError('contract exists')
    Object.defineProperty(error, 'historyTransactionFailure', {
      configurable: false,
      enumerable: false,
      value: failure,
      writable: false,
    })
    HISTORY_TRANSACTION_FAILURES.set(error, failure)
    return error as HistoryTransactionError
  } catch {
    const wrapped = fallbackError(cause)
    Object.defineProperty(wrapped, 'historyTransactionFailure', {
      configurable: false,
      enumerable: false,
      value: failure,
      writable: false,
    })
    HISTORY_TRANSACTION_FAILURES.set(wrapped, failure)
    return wrapped as HistoryTransactionError
  }
}

export function getHistoryTransactionFailure(
  value: unknown
): HistoryTransactionFailure | undefined {
  if (!(value instanceof Error)) return undefined
  try {
    const failure = (value as Partial<HistoryTransactionError>).historyTransactionFailure
    return failure !== null &&
      typeof failure === 'object' &&
      HISTORY_TRANSACTION_FAILURES.get(value) === failure
      ? failure
      : undefined
  } catch {
    return undefined
  }
}

export function isHistoryTransactionError(value: unknown): value is HistoryTransactionError {
  return getHistoryTransactionFailure(value) !== undefined
}

function errorCause(value: unknown): Error {
  return value instanceof Error ? value : fallbackError(value)
}

function transactionFailureError(
  failure: PendingTransactionFailure,
  releaseFailed: boolean,
  releaseCause: unknown
): unknown {
  const cleanupCauses: Error[] = []
  if (failure.rollbackFailed) cleanupCauses.push(errorCause(failure.rollbackCause))
  if (releaseFailed) cleanupCauses.push(errorCause(releaseCause))
  if (cleanupCauses.length === 0) return failure.primaryCause

  const phases = [failure.rollbackFailed ? 'rollback' : null, releaseFailed ? 'release' : null]
    .filter((phase): phase is 'rollback' | 'release' => phase !== null)
    .join(' and ')
  const message =
    failure.rollbackFailed && !releaseFailed
      ? '[ingest] history transaction and rollback both failed'
      : `[ingest] history transaction and ${phases} failed`
  return new AggregateError([errorCause(failure.primaryCause), ...cleanupCauses], message, {
    cause: failure.primaryCause,
  })
}

/**
 * Short worker-owned transaction for immutable history evidence. A failed
 * body is rolled back. Once COMMIT is requested, any rejection is classified
 * as outcome-ambiguous and the checked-out client is destroyed; callers can
 * then reconcile or replay the exact same idempotency-bound input.
 */
export async function runHistoryTransaction<T>(
  operation: (transaction: IngestQueryExecutor) => Promise<T>
): Promise<T> {
  let client: Awaited<ReturnType<typeof ingestClientConnect>>
  try {
    client = await ingestClientConnect()
  } catch (cause) {
    throw attachFailureContract(
      cause,
      failureContract({
        primaryCause: cause,
        primaryStage: 'connect',
        outcome: 'not_committed',
        failedStages: ['connect'],
        destroyRequested: false,
        clientDisposition: 'not_acquired',
        releaseSucceeded: null,
      })
    )
  }

  let transactionOpen = false
  let commitAttempted = false
  let destroyClient = false
  let result!: T
  let transactionFailure: PendingTransactionFailure | undefined

  try {
    await client.query('BEGIN')
    transactionOpen = true
    result = await operation(client)
    commitAttempted = true
    await client.query('COMMIT')
    transactionOpen = false
  } catch (cause) {
    if (commitAttempted) {
      destroyClient = true
      transactionFailure = {
        primaryCause: cause,
        primaryStage: 'commit',
        outcome: 'ambiguous',
        rollbackFailed: false,
      }
    } else if (!transactionOpen) {
      // No operation ran, so no application write can have committed. The
      // protocol state may still be uncertain, therefore destroy this client.
      destroyClient = true
      transactionFailure = {
        primaryCause: cause,
        primaryStage: 'begin',
        outcome: 'not_committed',
        rollbackFailed: false,
      }
    } else {
      transactionFailure = {
        primaryCause: cause,
        primaryStage: 'operation',
        outcome: 'not_committed',
        rollbackFailed: false,
      }
      try {
        await client.query('ROLLBACK')
        transactionOpen = false
      } catch (rollbackCause) {
        destroyClient = true
        transactionFailure.rollbackFailed = true
        transactionFailure.rollbackCause = rollbackCause
      }
    }
  }

  let releaseFailed = false
  let releaseCause: unknown
  try {
    client.release(destroyClient)
  } catch (cause) {
    releaseFailed = true
    releaseCause = cause
  }

  if (transactionFailure === undefined && !releaseFailed) return result

  if (transactionFailure === undefined) {
    throw attachFailureContract(
      releaseCause,
      failureContract({
        primaryCause: releaseCause,
        primaryStage: 'release',
        outcome: 'committed',
        failedStages: ['release'],
        releaseFailed: true,
        releaseCause,
        destroyRequested: false,
        clientDisposition: 'release_failed',
        releaseSucceeded: false,
      })
    )
  }

  const failedStages: HistoryTransactionFailureStage[] = [transactionFailure.primaryStage]
  if (transactionFailure.rollbackFailed) failedStages.push('rollback')
  if (releaseFailed) failedStages.push('release')
  const clientDisposition: HistoryTransactionClientDisposition = releaseFailed
    ? 'release_failed'
    : destroyClient
      ? 'destroyed'
      : 'released_reusable'
  const throwable = transactionFailureError(transactionFailure, releaseFailed, releaseCause)
  throw attachFailureContract(
    throwable,
    failureContract({
      primaryCause: transactionFailure.primaryCause,
      primaryStage: transactionFailure.primaryStage,
      outcome: transactionFailure.outcome,
      failedStages,
      rollbackFailed: transactionFailure.rollbackFailed,
      rollbackCause: transactionFailure.rollbackCause,
      releaseFailed,
      releaseCause,
      destroyRequested: destroyClient,
      clientDisposition,
      releaseSucceeded: !releaseFailed,
    })
  )
}
