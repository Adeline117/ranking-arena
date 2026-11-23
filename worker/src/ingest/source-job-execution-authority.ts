import { randomUUID } from 'node:crypto'

import type { QueryResult, QueryResultRow } from 'pg'

import type { IngestQueryExecutor } from '@/lib/ingest/db'
import { isIngestRegion } from '@/lib/ingest/core/regions'

import type { AuthorizedConsumedRegionContext } from './consumed-region-context'
import {
  BULL_ATTEMPT_COUNTER_MAX,
  BULL_JOB_PROVENANCE_CONTRACT,
  type BullJobAuthority,
  type BullJobProvenance,
} from './job-provenance'
import { INGEST_JOB } from './job-names'
import type { SourceJobRunProvenance } from './source-job-routing'
import {
  SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
  type SourceJobLeaseAuthority,
  type SourceJobLeaseProof,
} from './source-job-lease'
import type { WorkerDbFenceProof, WorkerDbFencedWrite } from './worker-db-fence'
import { WORKER_OWNER_LEASE_TTL_MS } from './worker-instance-ownership'

export const SOURCE_JOB_EXECUTION_CONTRACT = 'arena.ingest.tier-a-execution@1' as const
export const SOURCE_JOB_EXECUTION_HEARTBEAT_MS = 30_000
export const SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS = 90
export const SOURCE_JOB_EXECUTION_BULL_LOCK_MS = 180_000

const MAX_SAFE_DATABASE_INTEGER = 9_007_199_254_740_000
const SOURCE_ID_MAX = 32_767
const CLAIM_RESULT_ALIAS = 'tier_a_execution_claim'
const HEARTBEAT_RESULT_ALIAS = 'tier_a_execution_heartbeat'
const ASSERT_RESULT_ALIAS = 'tier_a_execution_assertion'
const CLOSE_RESULT_ALIAS = 'tier_a_execution_close'

export const SOURCE_JOB_EXECUTION_CLAIM_SQL = `SELECT arena.claim_tier_a_execution(
    $1::uuid,
    $2::integer,
    $3::text,
    $4::text,
    $5::text,
    $6::integer,
    $7::integer,
    $8::text,
    $9::uuid,
    $10::text,
    $11::text,
    $12::integer
  ) AS ${CLAIM_RESULT_ALIAS}`

export const SOURCE_JOB_EXECUTION_HEARTBEAT_SQL = `SELECT arena.heartbeat_tier_a_execution(
    $1::uuid,
    $2::bigint
  ) AS ${HEARTBEAT_RESULT_ALIAS}`

export const SOURCE_JOB_EXECUTION_ASSERT_SQL = `SELECT arena.assert_tier_a_execution_write(
    $1::uuid,
    $2::bigint
  ) AS ${ASSERT_RESULT_ALIAS}`

export const SOURCE_JOB_EXECUTION_CLOSE_SQL = `SELECT arena.close_tier_a_execution(
    $1::uuid,
    $2::bigint,
    $3::text
  ) AS ${CLOSE_RESULT_ALIAS}`

const CLAIM_ROW_KEYS = [
  'authority_epoch',
  'authority_scope',
  'bull_lock_token_sha256',
  'bull_proof_contract',
  'claim_id',
  'claimed_at',
  'contract',
  'control_epoch',
  'execution_region',
  'generation_seq',
  'git_sha',
  'last_heartbeat_at',
  'lease_expires_at',
  'lease_seconds',
  'phase',
  'queue_attempt',
  'queue_attempt_started',
  'queue_job_id',
  'queue_job_name',
  'queue_name',
  'release_id',
  'source_id',
  'source_lease_contract',
  'source_lease_id',
  'source_lease_lane',
  'source_lease_scope_id',
  'source_lease_token_sha256',
  'worker_instance_id',
  'worker_node_id',
  'worker_region',
] as const

const HEARTBEAT_ROW_KEYS = [
  'claim_id',
  'contract',
  'generation_seq',
  'last_heartbeat_at',
  'lease_expires_at',
  'phase',
  'source_id',
] as const

const ASSERT_ROW_KEYS = [
  'asserted_at',
  'claim_id',
  'contract',
  'generation_seq',
  'lease_expires_at_at_assertion',
  'phase',
  'source_id',
] as const

const CLOSE_ROW_KEYS = [
  'claim_id',
  'closed_at',
  'contract',
  'generation_seq',
  'phase',
  'source_id',
] as const

const BULL_PROOF_KEYS = [
  'attemptsMade',
  'attemptsStarted',
  'contract',
  'jobId',
  'jobName',
  'processorTokenSha256',
  'queueName',
] as const

const SOURCE_PROOF_KEYS = ['contract', 'lane', 'leaseId', 'ownerTokenSha256', 'scopeId'] as const

const WORKER_PROOF_KEYS = [
  'authorityScope',
  'controlEpoch',
  'controlServerTimeMs',
  'databaseEpoch',
  'databaseLeaseExpiresAt',
  'databaseServerTime',
  'initialControlServerTimeMs',
  'instanceId',
  'nodeId',
  'region',
] as const

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_WORKER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CANONICAL_DIGEST = /^[0-9a-f]{64}$/
const CANONICAL_RELEASE_ID = /^[0-9a-f]{64}$/
const CANONICAL_GIT_SHA = /^[0-9a-f]{40}$/
const CANONICAL_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CANONICAL_SCOPE_ID = /^[a-z0-9][a-z0-9_-]{0,255}$/

export type SourceJobExecutionClosePhase = 'completed' | 'failed' | 'revoked'
export type SourceJobExecutionOperation = 'assert' | 'claim' | 'close' | 'heartbeat' | 'write'
export type SourceJobExecutionFailureCode =
  | 'cancelled'
  | 'closed'
  | 'invalid_input'
  | 'ownership_lost'
  | 'region_lost'
  | 'rpc_contract_violation'
  | 'unavailable'

export class SourceJobExecutionError extends Error {
  readonly code: SourceJobExecutionFailureCode
  readonly operation: SourceJobExecutionOperation

  constructor(operation: SourceJobExecutionOperation, code: SourceJobExecutionFailureCode) {
    super(`[ingest-worker] Tier-A execution ${operation} failed (${code})`)
    this.name = 'SourceJobExecutionError'
    this.operation = operation
    this.code = code
  }
}

export interface SourceJobExecutionClaimProof {
  readonly contract: typeof SOURCE_JOB_EXECUTION_CONTRACT
  readonly sourceId: number
  readonly generationSeq: number
  readonly claimId: string
  readonly bullProofContract: typeof BULL_JOB_PROVENANCE_CONTRACT
  readonly queueName: string
  readonly queueJobId: string
  readonly queueJobName: typeof INGEST_JOB.TIER_A
  readonly queueAttempt: number
  readonly queueAttemptStarted: number
  readonly bullLockTokenSha256: string
  readonly sourceLeaseContract: typeof SOURCE_JOB_LEASE_PROVENANCE_CONTRACT
  readonly sourceLeaseId: string
  readonly sourceLeaseLane: 'tier-a'
  readonly sourceLeaseScopeId: string
  readonly sourceLeaseTokenSha256: string
  readonly executionRegion: AuthorizedConsumedRegionContext['executionRegion']
  readonly authorityScope: WorkerDbFenceProof['authorityScope']
  readonly authorityEpoch: number
  readonly workerInstanceId: string
  readonly workerNodeId: string
  readonly workerRegion: WorkerDbFenceProof['region']
  readonly controlEpoch: number
  readonly releaseId: string
  readonly gitSha: string
  readonly leaseSeconds: typeof SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS
  readonly phase: 'active'
  readonly claimedAt: string
  readonly lastHeartbeatAt: string
  readonly leaseExpiresAt: string
}

export interface SourceJobExecutionHeartbeatProof {
  readonly contract: typeof SOURCE_JOB_EXECUTION_CONTRACT
  readonly sourceId: number
  readonly generationSeq: number
  readonly claimId: string
  readonly phase: 'active'
  readonly lastHeartbeatAt: string
  readonly leaseExpiresAt: string
}

export interface SourceJobExecutionAssertionProof {
  readonly contract: typeof SOURCE_JOB_EXECUTION_CONTRACT
  readonly sourceId: number
  readonly generationSeq: number
  readonly claimId: string
  readonly phase: 'active'
  readonly assertedAt: string
  readonly leaseExpiresAtAtAssertion: string
}

export interface SourceJobExecutionCloseProof {
  readonly contract: typeof SOURCE_JOB_EXECUTION_CONTRACT
  readonly sourceId: number
  readonly generationSeq: number
  readonly claimId: string
  readonly phase: SourceJobExecutionClosePhase
  readonly closedAt: string
}

declare const TIER_A_EXECUTION_CLAIMED_WRITE_BRAND: unique symbol

export interface TierAExecutionClaimedWrite extends IngestQueryExecutor {
  readonly [TIER_A_EXECUTION_CLAIMED_WRITE_BRAND]: true
  readonly signal: AbortSignal
}

const TIER_A_EXECUTION_CLAIMED_WRITES = new WeakSet<object>()

export function assertTierAExecutionClaimedWrite(
  value: unknown
): asserts value is TierAExecutionClaimedWrite {
  if (
    value === null ||
    typeof value !== 'object' ||
    !Object.isFrozen(value) ||
    !TIER_A_EXECUTION_CLAIMED_WRITES.has(value)
  ) {
    throw executionError('write', 'invalid_input')
  }
}

export interface SourceJobExecutionAuthority {
  readonly proof: SourceJobExecutionClaimProof
  readonly signal: AbortSignal
  assertActive(): void
  close(phase: SourceJobExecutionClosePhase): Promise<SourceJobExecutionCloseProof>
  heartbeat(): Promise<SourceJobExecutionHeartbeatProof>
  withClaimedWrite<T>(callback: (transaction: TierAExecutionClaimedWrite) => Promise<T>): Promise<T>
}

export interface SourceJobExecutionHeartbeatTimer {
  cancel(): void
  unref?(): void
}

export interface ClaimSourceJobExecutionOptions {
  readonly claimId?: string
  readonly context: AuthorizedConsumedRegionContext
  readonly provenance: SourceJobRunProvenance
  readonly scheduleHeartbeat?: (
    callback: () => void,
    intervalMs: number
  ) => SourceJobExecutionHeartbeatTimer
  readonly signal?: AbortSignal
  readonly sourceId: number
}

interface ValidatedInputs {
  bullJob: BullJobAuthority
  bullProof: BullJobProvenance & {
    attemptsMade: number
    attemptsStarted: number
    jobId: string
    jobName: typeof INGEST_JOB.TIER_A
    processorTokenSha256: string
    queueName: string
  }
  claimId: string
  sourceId: number
  sourceLease: SourceJobLeaseAuthority
  sourceProof: SourceJobLeaseProof & { lane: 'tier-a' }
  workerProof: WorkerDbFenceProof
}

class ExecutionRpcContractViolation extends Error {}
class ExecutionCallbackFailure extends Error {
  constructor(readonly original: unknown) {
    super('Tier-A execution callback failed')
  }
}

function executionError(
  operation: SourceJobExecutionOperation,
  code: SourceJobExecutionFailureCode
): SourceJobExecutionError {
  return new SourceJobExecutionError(operation, code)
}

/**
 * A database or transport error that is about to be reported under one of the
 * fixed failure codes. The code alone hid the reason: on 2026-11-22 two
 * bybit_mt5 windows ended in "assert failed (region_lost)" with no authority
 * loss, shutdown or restart anywhere in the logs.
 *
 * The thrown error stays sanitized (messages can carry SQL and connection
 * details), so only fields that cannot are logged: the error class, a
 * SQLSTATE / errno-style code, and whether it was the client's query timeout.
 */
const SAFE_CAUSE_CODE = /^[A-Z0-9_]{2,40}$/

function logUnclassifiedCause(
  operation: SourceJobExecutionOperation,
  code: SourceJobExecutionFailureCode,
  cause: unknown
): void {
  let detail = `non-error rejection (${typeof cause})`
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: unknown }).code
    detail =
      (/^[A-Za-z]{1,60}$/.test(cause.name) ? cause.name : 'Error') +
      (typeof causeCode === 'string' && SAFE_CAUSE_CODE.test(causeCode)
        ? ` code=${causeCode}`
        : '') +
      (cause.message === 'Query read timeout' ? ' query_read_timeout' : '')
  }
  console.error(`[ingest-worker] Tier-A execution ${operation} ${code} cause: ${detail}`)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.prototype.hasOwnProperty.call(value, 'toJSON') ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !== Object.keys(value).length
  ) {
    throw new ExecutionRpcContractViolation()
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new ExecutionRpcContractViolation()
    }
  }
  return value as Record<string, unknown>
}

function safeInteger(value: unknown, minimum = 0, maximum = MAX_SAFE_DATABASE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return value
}

function sourceId(value: unknown): number {
  return safeInteger(value, 1, SOURCE_ID_MAX)
}

function canonicalText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return value
}

function canonicalUuid(value: unknown, worker = false): string {
  if (typeof value !== 'string' || !(worker ? CANONICAL_WORKER_UUID : CANONICAL_UUID).test(value)) {
    throw new ExecutionRpcContractViolation()
  }
  return value
}

function canonicalDigest(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_DIGEST.test(value) || value === '0'.repeat(64)) {
    throw new ExecutionRpcContractViolation()
  }
  return value
}

function canonicalTimestamp(value: unknown): { encoded: string; timeMs: number } {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) {
    throw new ExecutionRpcContractViolation()
  }
  const timeMs = Date.parse(value)
  if (!Number.isFinite(timeMs) || new Date(timeMs).toISOString() !== value) {
    throw new ExecutionRpcContractViolation()
  }
  return { encoded: value, timeMs }
}

function validateWorkerProof(
  proof: WorkerDbFenceProof,
  context: AuthorizedConsumedRegionContext
): WorkerDbFenceProof {
  if (!Object.isFrozen(proof) || !exactKeys(strictRecord(proof), WORKER_PROOF_KEYS)) {
    throw new ExecutionRpcContractViolation()
  }
  const databaseServerTime = canonicalTimestamp(proof.databaseServerTime)
  const databaseLeaseExpiresAt = canonicalTimestamp(proof.databaseLeaseExpiresAt)
  if (
    (proof.region !== 'local' && proof.region !== 'vps_sg') ||
    proof.region !== context.consumedRegion ||
    proof.authorityScope !== `region:${proof.region}` ||
    !CANONICAL_NODE_ID.test(proof.nodeId) ||
    canonicalUuid(proof.instanceId, true) !== proof.instanceId ||
    safeInteger(proof.controlEpoch, 1) !== proof.controlEpoch ||
    safeInteger(proof.controlServerTimeMs, 1) !== proof.controlServerTimeMs ||
    safeInteger(proof.initialControlServerTimeMs, 1) !== proof.initialControlServerTimeMs ||
    proof.controlServerTimeMs < proof.initialControlServerTimeMs ||
    safeInteger(proof.databaseEpoch, 1) !== proof.databaseEpoch ||
    databaseLeaseExpiresAt.timeMs <= databaseServerTime.timeMs ||
    databaseLeaseExpiresAt.timeMs - databaseServerTime.timeMs > WORKER_OWNER_LEASE_TTL_MS
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return proof
}

function validateInputs(options: ClaimSourceJobExecutionOptions): ValidatedInputs {
  const { context, provenance } = options
  if (
    (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
    (options.scheduleHeartbeat !== undefined && typeof options.scheduleHeartbeat !== 'function') ||
    !Object.isFrozen(context) ||
    !Object.isFrozen(context.authority) ||
    !Object.isFrozen(provenance) ||
    !Object.isFrozen(provenance.bullJob) ||
    provenance.sourceLease === null ||
    !Object.isFrozen(provenance.sourceLease)
  ) {
    throw new ExecutionRpcContractViolation()
  }
  if (
    !isIngestRegion(context.executionRegion) ||
    context.executionRegion !== context.consumedRegion
  ) {
    throw new ExecutionRpcContractViolation()
  }
  const bullProof = provenance.bullJob.proof
  const sourceProof = provenance.sourceLease.proof
  if (
    !Object.isFrozen(bullProof) ||
    !Object.isFrozen(sourceProof) ||
    !exactKeys(strictRecord(bullProof), BULL_PROOF_KEYS) ||
    !exactKeys(strictRecord(sourceProof), SOURCE_PROOF_KEYS) ||
    bullProof.contract !== BULL_JOB_PROVENANCE_CONTRACT ||
    sourceProof.contract !== SOURCE_JOB_LEASE_PROVENANCE_CONTRACT ||
    bullProof.jobName !== INGEST_JOB.TIER_A ||
    sourceProof.lane !== 'tier-a'
  ) {
    throw new ExecutionRpcContractViolation()
  }
  const queueName = canonicalText(bullProof.queueName, 256)
  const jobId = canonicalText(bullProof.jobId, 512)
  const attemptsMade = safeInteger(bullProof.attemptsMade, 0, BULL_ATTEMPT_COUNTER_MAX)
  const attemptsStarted = safeInteger(bullProof.attemptsStarted, 0, BULL_ATTEMPT_COUNTER_MAX)
  const processorTokenSha256 = canonicalDigest(bullProof.processorTokenSha256)
  const leaseId = canonicalUuid(sourceProof.leaseId)
  const ownerTokenSha256 = canonicalDigest(sourceProof.ownerTokenSha256)
  if (!CANONICAL_SCOPE_ID.test(sourceProof.scopeId)) throw new ExecutionRpcContractViolation()
  if (
    typeof provenance.bullJob.extendLock !== 'function' ||
    typeof provenance.bullJob.assertActive !== 'function' ||
    typeof provenance.sourceLease.renew !== 'function' ||
    typeof provenance.sourceLease.assertOwned !== 'function' ||
    typeof context.assertCanConsume !== 'function' ||
    typeof context.authority.withFencedWrite !== 'function' ||
    typeof context.authority.isActive !== 'function'
  ) {
    throw new ExecutionRpcContractViolation()
  }
  const validatedSourceId = sourceId(options.sourceId)
  const claimId = canonicalUuid(options.claimId ?? randomUUID())
  const workerProof = validateWorkerProof(context.authority.proof, context)
  return {
    bullJob: provenance.bullJob,
    bullProof: {
      ...bullProof,
      attemptsMade,
      attemptsStarted,
      jobId,
      jobName: INGEST_JOB.TIER_A,
      processorTokenSha256,
      queueName,
    },
    claimId,
    sourceId: validatedSourceId,
    sourceLease: provenance.sourceLease,
    sourceProof: {
      ...sourceProof,
      lane: 'tier-a',
      leaseId,
      ownerTokenSha256,
    },
    workerProof,
  }
}

function rpcPayload(
  result: QueryResult<QueryResultRow>,
  alias: string,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  const row = result.rows.length === 1 ? strictRecord(result.rows[0]) : undefined
  if (
    result.command !== 'SELECT' ||
    result.rowCount !== 1 ||
    row === undefined ||
    !exactKeys(row, [alias])
  ) {
    throw new ExecutionRpcContractViolation()
  }
  const payload = strictRecord(row[alias])
  if (!exactKeys(payload, expectedKeys)) throw new ExecutionRpcContractViolation()
  return payload
}

function parseClaimResult(
  result: QueryResult<QueryResultRow>,
  input: ValidatedInputs,
  context: AuthorizedConsumedRegionContext
): SourceJobExecutionClaimProof {
  const row = rpcPayload(result, CLAIM_RESULT_ALIAS, CLAIM_ROW_KEYS)
  const claimedAt = canonicalTimestamp(row.claimed_at)
  const lastHeartbeatAt = canonicalTimestamp(row.last_heartbeat_at)
  const leaseExpiresAt = canonicalTimestamp(row.lease_expires_at)
  const generationSeq = safeInteger(row.generation_seq, 1)
  const authorityEpoch = safeInteger(row.authority_epoch, 1)
  const controlEpoch = safeInteger(row.control_epoch, 1)
  if (
    row.contract !== SOURCE_JOB_EXECUTION_CONTRACT ||
    sourceId(row.source_id) !== input.sourceId ||
    canonicalUuid(row.claim_id) !== input.claimId ||
    row.bull_proof_contract !== BULL_JOB_PROVENANCE_CONTRACT ||
    row.queue_name !== input.bullProof.queueName ||
    row.queue_job_id !== input.bullProof.jobId ||
    row.queue_job_name !== INGEST_JOB.TIER_A ||
    safeInteger(row.queue_attempt, 0, BULL_ATTEMPT_COUNTER_MAX) !== input.bullProof.attemptsMade ||
    safeInteger(row.queue_attempt_started, 0, BULL_ATTEMPT_COUNTER_MAX) !==
      input.bullProof.attemptsStarted ||
    canonicalDigest(row.bull_lock_token_sha256) !== input.bullProof.processorTokenSha256 ||
    row.source_lease_contract !== SOURCE_JOB_LEASE_PROVENANCE_CONTRACT ||
    canonicalUuid(row.source_lease_id) !== input.sourceProof.leaseId ||
    row.source_lease_lane !== 'tier-a' ||
    row.source_lease_scope_id !== input.sourceProof.scopeId ||
    canonicalDigest(row.source_lease_token_sha256) !== input.sourceProof.ownerTokenSha256 ||
    row.execution_region !== context.executionRegion ||
    row.authority_scope !== input.workerProof.authorityScope ||
    authorityEpoch !== input.workerProof.databaseEpoch ||
    canonicalUuid(row.worker_instance_id, true) !== input.workerProof.instanceId ||
    row.worker_node_id !== input.workerProof.nodeId ||
    row.worker_region !== input.workerProof.region ||
    controlEpoch !== input.workerProof.controlEpoch ||
    typeof row.release_id !== 'string' ||
    !CANONICAL_RELEASE_ID.test(row.release_id) ||
    row.release_id === '0'.repeat(64) ||
    typeof row.git_sha !== 'string' ||
    !CANONICAL_GIT_SHA.test(row.git_sha) ||
    row.git_sha === '0'.repeat(40) ||
    safeInteger(row.lease_seconds, 1) !== SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS ||
    row.phase !== 'active' ||
    claimedAt.timeMs !== lastHeartbeatAt.timeMs ||
    leaseExpiresAt.timeMs - lastHeartbeatAt.timeMs !== SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS * 1_000
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return Object.freeze({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    sourceId: input.sourceId,
    generationSeq,
    claimId: input.claimId,
    bullProofContract: BULL_JOB_PROVENANCE_CONTRACT,
    queueName: input.bullProof.queueName,
    queueJobId: input.bullProof.jobId,
    queueJobName: INGEST_JOB.TIER_A,
    queueAttempt: input.bullProof.attemptsMade,
    queueAttemptStarted: input.bullProof.attemptsStarted,
    bullLockTokenSha256: input.bullProof.processorTokenSha256,
    sourceLeaseContract: SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
    sourceLeaseId: input.sourceProof.leaseId,
    sourceLeaseLane: 'tier-a',
    sourceLeaseScopeId: input.sourceProof.scopeId,
    sourceLeaseTokenSha256: input.sourceProof.ownerTokenSha256,
    executionRegion: context.executionRegion,
    authorityScope: input.workerProof.authorityScope,
    authorityEpoch,
    workerInstanceId: input.workerProof.instanceId,
    workerNodeId: input.workerProof.nodeId,
    workerRegion: input.workerProof.region,
    controlEpoch,
    releaseId: row.release_id,
    gitSha: row.git_sha,
    leaseSeconds: SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS,
    phase: 'active',
    claimedAt: claimedAt.encoded,
    lastHeartbeatAt: lastHeartbeatAt.encoded,
    leaseExpiresAt: leaseExpiresAt.encoded,
  })
}

function validateSharedActiveRow(
  row: Record<string, unknown>,
  proof: SourceJobExecutionClaimProof
): void {
  if (
    row.contract !== SOURCE_JOB_EXECUTION_CONTRACT ||
    sourceId(row.source_id) !== proof.sourceId ||
    safeInteger(row.generation_seq, 1) !== proof.generationSeq ||
    canonicalUuid(row.claim_id) !== proof.claimId ||
    row.phase !== 'active'
  ) {
    throw new ExecutionRpcContractViolation()
  }
}

function parseHeartbeatResult(
  result: QueryResult<QueryResultRow>,
  proof: SourceJobExecutionClaimProof,
  previousHeartbeatAt: string
): SourceJobExecutionHeartbeatProof {
  const row = rpcPayload(result, HEARTBEAT_RESULT_ALIAS, HEARTBEAT_ROW_KEYS)
  validateSharedActiveRow(row, proof)
  const lastHeartbeatAt = canonicalTimestamp(row.last_heartbeat_at)
  const leaseExpiresAt = canonicalTimestamp(row.lease_expires_at)
  if (
    lastHeartbeatAt.timeMs < canonicalTimestamp(previousHeartbeatAt).timeMs ||
    leaseExpiresAt.timeMs - lastHeartbeatAt.timeMs !== SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS * 1_000
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return Object.freeze({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    sourceId: proof.sourceId,
    generationSeq: proof.generationSeq,
    claimId: proof.claimId,
    phase: 'active',
    lastHeartbeatAt: lastHeartbeatAt.encoded,
    leaseExpiresAt: leaseExpiresAt.encoded,
  })
}

function parseAssertionResult(
  result: QueryResult<QueryResultRow>,
  proof: SourceJobExecutionClaimProof,
  currentHeartbeatAt: string,
  currentLeaseExpiresAt: string
): SourceJobExecutionAssertionProof {
  const row = rpcPayload(result, ASSERT_RESULT_ALIAS, ASSERT_ROW_KEYS)
  validateSharedActiveRow(row, proof)
  const assertedAt = canonicalTimestamp(row.asserted_at)
  const leaseExpiresAt = canonicalTimestamp(row.lease_expires_at_at_assertion)
  if (
    assertedAt.timeMs < canonicalTimestamp(currentHeartbeatAt).timeMs ||
    leaseExpiresAt.timeMs < canonicalTimestamp(currentLeaseExpiresAt).timeMs ||
    leaseExpiresAt.timeMs <= assertedAt.timeMs
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return Object.freeze({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    sourceId: proof.sourceId,
    generationSeq: proof.generationSeq,
    claimId: proof.claimId,
    phase: 'active',
    assertedAt: assertedAt.encoded,
    leaseExpiresAtAtAssertion: leaseExpiresAt.encoded,
  })
}

function parseCloseResult(
  result: QueryResult<QueryResultRow>,
  proof: SourceJobExecutionClaimProof,
  phase: SourceJobExecutionClosePhase,
  currentHeartbeatAt: string
): SourceJobExecutionCloseProof {
  const row = rpcPayload(result, CLOSE_RESULT_ALIAS, CLOSE_ROW_KEYS)
  const closedAt = canonicalTimestamp(row.closed_at)
  if (
    row.contract !== SOURCE_JOB_EXECUTION_CONTRACT ||
    sourceId(row.source_id) !== proof.sourceId ||
    safeInteger(row.generation_seq, 1) !== proof.generationSeq ||
    canonicalUuid(row.claim_id) !== proof.claimId ||
    row.phase !== phase ||
    closedAt.timeMs < canonicalTimestamp(currentHeartbeatAt).timeMs
  ) {
    throw new ExecutionRpcContractViolation()
  }
  return Object.freeze({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    sourceId: proof.sourceId,
    generationSeq: proof.generationSeq,
    claimId: proof.claimId,
    phase,
    closedAt: closedAt.encoded,
  })
}

function fixedQuery<R extends QueryResultRow = QueryResultRow>(
  transaction: WorkerDbFencedWrite,
  text: string,
  values: readonly unknown[]
): Promise<QueryResult<R>> {
  return transaction.query<R>(text, Object.freeze([...values]))
}

function defaultScheduleHeartbeat(
  callback: () => void,
  intervalMs: number
): SourceJobExecutionHeartbeatTimer {
  const timer = setInterval(callback, intervalMs)
  return {
    cancel: () => clearInterval(timer),
    unref: () => timer.unref?.(),
  }
}

export async function claimSourceJobExecutionAuthority(
  options: ClaimSourceJobExecutionOptions
): Promise<SourceJobExecutionAuthority> {
  let input: ValidatedInputs
  let scheduleHeartbeat: NonNullable<ClaimSourceJobExecutionOptions['scheduleHeartbeat']>
  try {
    if (options === null || typeof options !== 'object') {
      throw new ExecutionRpcContractViolation()
    }
    input = validateInputs(options)
    scheduleHeartbeat = options.scheduleHeartbeat ?? defaultScheduleHeartbeat
  } catch {
    throw executionError('claim', 'invalid_input')
  }

  const executionAbort = new AbortController()
  let failure: SourceJobExecutionError | undefined
  let heartbeatTimer: SourceJobExecutionHeartbeatTimer | undefined
  let heartbeatPromise: Promise<SourceJobExecutionHeartbeatProof> | null = null
  let closePromise: Promise<SourceJobExecutionCloseProof> | null = null
  const inFlightWrites = new Set<Promise<unknown>>()
  let closePhase: SourceJobExecutionClosePhase | undefined
  let closing = false
  let closed = false
  let lifecycleOperation: SourceJobExecutionOperation = 'claim'
  const detachAbortListeners: Array<() => void> = []

  const cancelHeartbeatTimer = () => {
    const timer = heartbeatTimer
    heartbeatTimer = undefined
    try {
      timer?.cancel()
    } catch {
      // A timer adapter must never replace the sticky fenced outcome.
    }
  }

  const abortExecution = (nextFailure: SourceJobExecutionError) => {
    if (failure === undefined) failure = nextFailure
    cancelHeartbeatTimer()
    if (!executionAbort.signal.aborted) executionAbort.abort(failure)
  }
  const watchAbort = (
    signal: AbortSignal | undefined,
    nextFailure: () => SourceJobExecutionError
  ) => {
    if (signal === undefined) return
    const abort = () => abortExecution(nextFailure())
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    detachAbortListeners.push(() => signal.removeEventListener('abort', abort))
  }
  watchAbort(options.context.authority.signal, () =>
    executionError(lifecycleOperation, 'region_lost')
  )
  watchAbort(options.signal, () => executionError(lifecycleOperation, 'cancelled'))

  const detach = () => {
    while (detachAbortListeners.length > 0) detachAbortListeners.pop()?.()
  }
  const throwIfAborted = () => {
    if (executionAbort.signal.aborted) {
      throw failure ?? executionError('heartbeat', 'cancelled')
    }
  }
  const assertRegionAvailable = (operation: SourceJobExecutionOperation) => {
    throwIfAborted()
    try {
      options.context.assertCanConsume()
      if (!options.context.authority.isActive()) throw new Error('inactive')
    } catch {
      const nextFailure = executionError(operation, 'region_lost')
      abortExecution(nextFailure)
      throw nextFailure
    }
  }
  const refreshUpstreamOwnership = async (operation: SourceJobExecutionOperation) => {
    throwIfAborted()
    try {
      await input.bullJob.extendLock(SOURCE_JOB_EXECUTION_BULL_LOCK_MS)
      throwIfAborted()
      await input.sourceLease.renew()
      throwIfAborted()
    } catch (error) {
      if (error instanceof SourceJobExecutionError) throw error
      const nextFailure = executionError(operation, 'ownership_lost')
      abortExecution(nextFailure)
      throw nextFailure
    }
  }

  let proof: SourceJobExecutionClaimProof
  try {
    await refreshUpstreamOwnership('claim')
    assertRegionAvailable('claim')
    proof = await options.context.authority.withFencedWrite(async (transaction) => {
      throwIfAborted()
      const result = await fixedQuery(transaction, SOURCE_JOB_EXECUTION_CLAIM_SQL, [
        input.claimId,
        input.sourceId,
        input.bullProof.queueName,
        input.bullProof.jobId,
        input.bullProof.jobName,
        input.bullProof.attemptsMade,
        input.bullProof.attemptsStarted,
        input.bullProof.processorTokenSha256,
        input.sourceProof.leaseId,
        input.sourceProof.ownerTokenSha256,
        options.context.executionRegion,
        SOURCE_JOB_EXECUTION_DB_LEASE_SECONDS,
      ])
      throwIfAborted()
      return parseClaimResult(result, input, options.context)
    })
    throwIfAborted()
  } catch (error) {
    detach()
    if (error instanceof SourceJobExecutionError) throw error
    throw executionError(
      'claim',
      error instanceof ExecutionRpcContractViolation ? 'rpc_contract_violation' : 'unavailable'
    )
  }

  let currentHeartbeatAt = proof.lastHeartbeatAt
  let currentLeaseExpiresAt = proof.leaseExpiresAt
  lifecycleOperation = 'heartbeat'

  const assertActive = () => {
    if (failure !== undefined) throw failure
    if (closing || closed) throw executionError('assert', 'closed')
    if (executionAbort.signal.aborted) throw executionError('assert', 'cancelled')
    try {
      input.bullJob.assertActive()
      input.sourceLease.assertOwned()
    } catch {
      const nextFailure = executionError('assert', 'ownership_lost')
      abortExecution(nextFailure)
      throw nextFailure
    }
    assertRegionAvailable('assert')
  }

  const heartbeat = (): Promise<SourceJobExecutionHeartbeatProof> => {
    try {
      assertActive()
    } catch (error) {
      return Promise.reject(error)
    }
    if (heartbeatPromise !== null) return heartbeatPromise
    const task = (async () => {
      try {
        await refreshUpstreamOwnership('heartbeat')
        assertRegionAvailable('heartbeat')
        const heartbeatProof = await options.context.authority.withFencedWrite(
          async (transaction) => {
            throwIfAborted()
            const result = await fixedQuery(transaction, SOURCE_JOB_EXECUTION_HEARTBEAT_SQL, [
              proof.claimId,
              String(proof.generationSeq),
            ])
            throwIfAborted()
            return parseHeartbeatResult(result, proof, currentHeartbeatAt)
          }
        )
        throwIfAborted()
        currentHeartbeatAt = heartbeatProof.lastHeartbeatAt
        currentLeaseExpiresAt = heartbeatProof.leaseExpiresAt
        return heartbeatProof
      } catch (error) {
        const nextFailure =
          error instanceof SourceJobExecutionError
            ? error
            : executionError(
                'heartbeat',
                error instanceof ExecutionRpcContractViolation
                  ? 'rpc_contract_violation'
                  : 'unavailable'
              )
        if (nextFailure !== error) logUnclassifiedCause('heartbeat', nextFailure.code, error)
        abortExecution(nextFailure)
        throw nextFailure
      }
    })()
    heartbeatPromise = task
    const clearHeartbeat = () => {
      if (heartbeatPromise === task) heartbeatPromise = null
    }
    void task.then(clearHeartbeat, clearHeartbeat)
    return task
  }

  try {
    let schedulerReady = false
    heartbeatTimer = scheduleHeartbeat(() => {
      if (
        !schedulerReady ||
        closing ||
        closed ||
        failure !== undefined ||
        heartbeatPromise !== null
      ) {
        return
      }
      void heartbeat().catch(() => undefined)
    }, SOURCE_JOB_EXECUTION_HEARTBEAT_MS)
    if (
      heartbeatTimer === null ||
      typeof heartbeatTimer !== 'object' ||
      typeof heartbeatTimer.cancel !== 'function'
    ) {
      throw new Error('invalid heartbeat timer')
    }
    schedulerReady = true
    heartbeatTimer.unref?.()
  } catch {
    const nextFailure = executionError('heartbeat', 'unavailable')
    abortExecution(nextFailure)
    detach()
    throw nextFailure
  }

  const withClaimedWrite = <T>(
    callback: (transaction: TierAExecutionClaimedWrite) => Promise<T>
  ): Promise<T> => {
    try {
      if (typeof callback !== 'function') throw executionError('write', 'invalid_input')
      assertActive()
    } catch (error) {
      return Promise.reject(error)
    }
    const minimumHeartbeatAt = currentHeartbeatAt
    const minimumLeaseExpiresAt = currentLeaseExpiresAt
    const task = (async () => {
      try {
        return await options.context.authority.withFencedWrite(async (transaction) => {
          throwIfAborted()
          parseAssertionResult(
            await fixedQuery(transaction, SOURCE_JOB_EXECUTION_ASSERT_SQL, [
              proof.claimId,
              String(proof.generationSeq),
            ]),
            proof,
            minimumHeartbeatAt,
            minimumLeaseExpiresAt
          )
          throwIfAborted()
          const claimedWrite = Object.freeze({
            query: <R extends QueryResultRow = QueryResultRow>(
              text: string,
              values?: readonly unknown[]
            ) => transaction.query<R>(text, values),
            signal: executionAbort.signal,
          }) as TierAExecutionClaimedWrite
          TIER_A_EXECUTION_CLAIMED_WRITES.add(claimedWrite)
          let value!: T
          try {
            value = await callback(claimedWrite)
          } catch (error) {
            throw new ExecutionCallbackFailure(error)
          } finally {
            TIER_A_EXECUTION_CLAIMED_WRITES.delete(claimedWrite)
          }
          throwIfAborted()
          return value
        })
      } catch (error) {
        if (error instanceof ExecutionCallbackFailure) {
          throw error.original
        }
        const nextFailure =
          error instanceof SourceJobExecutionError
            ? error
            : executionError(
                'assert',
                error instanceof ExecutionRpcContractViolation
                  ? 'rpc_contract_violation'
                  : 'region_lost'
              )
        if (nextFailure !== error) logUnclassifiedCause('assert', nextFailure.code, error)
        abortExecution(nextFailure)
        throw nextFailure
      }
    })()
    inFlightWrites.add(task)
    const clearWrite = () => inFlightWrites.delete(task)
    void task.then(clearWrite, clearWrite)
    return task
  }

  const close = (
    requestedPhase: SourceJobExecutionClosePhase
  ): Promise<SourceJobExecutionCloseProof> => {
    if (
      requestedPhase !== 'completed' &&
      requestedPhase !== 'failed' &&
      requestedPhase !== 'revoked'
    ) {
      return Promise.reject(executionError('close', 'invalid_input'))
    }
    if (closePromise !== null) {
      if (closePhase !== requestedPhase) {
        return Promise.reject(executionError('close', 'closed'))
      }
      return closePromise
    }
    closePhase = requestedPhase
    closing = true
    cancelHeartbeatTimer()
    const task = Promise.resolve()
      .then(async () => {
        const pendingHeartbeat = heartbeatPromise
        if (pendingHeartbeat !== null) await pendingHeartbeat.catch(() => undefined)
        const pendingWrites = [...inFlightWrites]
        await Promise.all(pendingWrites.map((write) => write.catch(() => undefined)))
        const effectivePhase =
          failure !== undefined && requestedPhase === 'completed' ? 'revoked' : requestedPhase
        if (options.context.authority.signal.aborted || !options.context.authority.isActive()) {
          throw executionError('close', 'region_lost')
        }
        let closeProof: SourceJobExecutionCloseProof
        try {
          closeProof = await options.context.authority.withFencedWrite(async (transaction) =>
            parseCloseResult(
              await fixedQuery(transaction, SOURCE_JOB_EXECUTION_CLOSE_SQL, [
                proof.claimId,
                String(proof.generationSeq),
                effectivePhase,
              ]),
              proof,
              effectivePhase,
              currentHeartbeatAt
            )
          )
        } catch (error) {
          if (error instanceof SourceJobExecutionError) throw error
          throw executionError(
            'close',
            error instanceof ExecutionRpcContractViolation
              ? 'rpc_contract_violation'
              : 'unavailable'
          )
        }
        return closeProof
      })
      .catch((error) => {
        const nextFailure =
          error instanceof SourceJobExecutionError ? error : executionError('close', 'unavailable')
        abortExecution(nextFailure)
        throw nextFailure
      })
      .finally(() => {
        closing = false
        closed = true
        cancelHeartbeatTimer()
        detach()
        if (!executionAbort.signal.aborted) {
          executionAbort.abort(executionError('close', 'closed'))
        }
      })
    closePromise = task
    return task
  }

  return Object.freeze({
    proof,
    signal: executionAbort.signal,
    assertActive,
    close,
    heartbeat,
    withClaimedWrite,
  })
}
