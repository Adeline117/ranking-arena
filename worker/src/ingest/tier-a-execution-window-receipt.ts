import type { QueryResult, QueryResultRow } from 'pg'

import type { IngestQueryExecutor } from '@/lib/ingest/db'

import {
  assertTierAExecutionClaimedWrite,
  type TierAExecutionClaimedWrite,
} from './source-job-execution-authority'

export const TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT =
  'arena.ingest.tier-a-execution-window-receipt@1' as const

const RECEIPT_RESULT_ALIAS = 'tier_a_execution_window_receipt'
const MAX_SOURCE_ID = 32_767
const MAX_DATABASE_ID = 9_007_199_254_740_000
const MAX_QUEUE_NAME_LENGTH = 256
const MAX_QUEUE_JOB_ID_LENGTH = 512
const MAX_OBSERVATION_CYCLE_ID_LENGTH = 512
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_DIGEST = /^[0-9a-f]{64}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const RECEIPT_KEYS = [
  'attempt_id',
  'attempt_seq',
  'claim_id',
  'contract',
  'generation_seq',
  'observation_cycle_id',
  'queue_job_id',
  'queue_name',
  'raw_object_id',
  'recorded_at',
  'snapshot_id',
  'source_id',
  'source_run_id',
  'timeframe',
] as const

export const RECORD_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL = `SELECT arena.record_tier_a_execution_window_receipt(
    p_claim_id => $1::uuid,
    p_generation_seq => $2::bigint,
    p_attempt_id => $3::uuid,
    p_snapshot_id => $4::bigint
  ) AS ${RECEIPT_RESULT_ALIAS}`

/**
 * Receipt for a window whose capture an earlier queue attempt of the same job
 * recorded but failed to publish (migration 20261127202748). Same receipt
 * shape and table as the ordinary receipt; the database proves the
 * cross-claim lineage and refuses a second republish of the attempt.
 */
export const RECORD_TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_SQL = `SELECT arena.record_tier_a_execution_window_republish_receipt(
    p_claim_id => $1::uuid,
    p_generation_seq => $2::bigint,
    p_attempt_id => $3::uuid,
    p_snapshot_id => $4::bigint
  ) AS ${RECEIPT_RESULT_ALIAS}`

/**
 * Read-only probe: whether the republish receipt RPC exists (migration
 * applied) AND the current database role may execute it. Existence alone is
 * not enough: a missing EXECUTE grant would only surface at the receipt,
 * after the snapshot was already published. The privilege check runs only
 * when the function exists (CASE), since has_function_privilege raises on an
 * unknown signature.
 */
export const TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL = `SELECT CASE
    WHEN pg_catalog.to_regprocedure(
      'arena.record_tier_a_execution_window_republish_receipt(uuid,bigint,uuid,bigint)'
    ) IS NULL THEN false
    ELSE pg_catalog.has_function_privilege(
      current_user,
      'arena.record_tier_a_execution_window_republish_receipt(uuid,bigint,uuid,bigint)',
      'EXECUTE'
    )
  END AS republish_receipt_present`

export const GET_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL = `SELECT arena.get_tier_a_execution_window_receipt(
    p_source_id => $1::integer,
    p_queue_name => $2::text,
    p_queue_job_id => $3::text,
    p_observation_cycle_id => $4::text,
    p_timeframe => $5::integer
  ) AS ${RECEIPT_RESULT_ALIAS}`

export type TierAExecutionWindowReceiptOperation =
  | 'get'
  | 'probe'
  | 'record'
  | 'republish'
  | 'writer'
export type TierAExecutionWindowReceiptErrorCode =
  | 'invalid_input'
  | 'rpc_contract_violation'
  | 'undefined_function'
  | 'unauthorized'
  | 'unavailable'

export class TierAExecutionWindowReceiptError extends Error {
  readonly code: TierAExecutionWindowReceiptErrorCode
  readonly operation: TierAExecutionWindowReceiptOperation

  constructor(
    operation: TierAExecutionWindowReceiptOperation,
    code: TierAExecutionWindowReceiptErrorCode
  ) {
    super(`[ingest-worker] Tier-A execution window receipt ${operation} failed (${code})`)
    this.name = 'TierAExecutionWindowReceiptError'
    this.operation = operation
    this.code = code
  }
}

export interface TierAExecutionWindowReceipt {
  readonly contract: typeof TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT
  readonly sourceId: number
  readonly queueName: string
  readonly queueJobId: string
  readonly observationCycleId: string
  readonly timeframe: 7 | 30 | 90
  readonly claimId: string
  readonly generationSeq: number
  readonly attemptId: string
  readonly attemptSeq: number
  readonly snapshotId: number
  readonly rawObjectId: number
  readonly sourceRunId: string
  readonly recordedAt: string
}

export interface TierAExecutionReceiptWriterBinding {
  readonly claimId: string
  readonly generationSeq: number
  readonly queueJobId: string
  readonly queueName: string
  readonly sourceId: number
}

export interface RecordTierAExecutionWindowReceiptInput {
  readonly attemptId: string
  readonly observationCycleId: string
  readonly rawObjectId: number
  readonly snapshotId: number
  readonly sourceRunId: string
  readonly timeframe: 7 | 30 | 90
}

export interface GetTierAExecutionWindowReceiptInput {
  readonly observationCycleId: string
  readonly queueJobId: string
  readonly queueName: string
  readonly sourceId: number
  readonly timeframe: 7 | 30 | 90
}

declare const TIER_A_EXECUTION_RECEIPT_WRITER_BRAND: unique symbol

/**
 * An opaque, callback-scoped authority for recording one execution receipt.
 * It intentionally exposes neither the transaction nor its execution binding.
 */
export interface TierAExecutionReceiptWriter {
  readonly [TIER_A_EXECUTION_RECEIPT_WRITER_BRAND]: true
}

interface ReceiptWriterState {
  readonly binding: Readonly<TierAExecutionReceiptWriterBinding>
  readonly transaction: TierAExecutionClaimedWrite
}

class ReceiptContractViolation extends Error {}

const RECEIPT_WRITERS = new WeakMap<object, ReceiptWriterState>()

function receiptError(
  operation: TierAExecutionWindowReceiptOperation,
  code: TierAExecutionWindowReceiptErrorCode
): TierAExecutionWindowReceiptError {
  return new TierAExecutionWindowReceiptError(operation, code)
}

function strictDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw new ReceiptContractViolation()
    }
    const names = Object.getOwnPropertyNames(value).sort()
    const expected = [...expectedKeys].sort()
    if (
      names.length !== expected.length ||
      !names.every((name, index) => name === expected[index])
    ) {
      throw new ReceiptContractViolation()
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const record: Record<string, unknown> = {}
    for (const key of expected) {
      const descriptor = descriptors[key]
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new ReceiptContractViolation()
      }
      record[key] = descriptor.value
    }
    return record
  } catch (error) {
    if (error instanceof ReceiptContractViolation) throw error
    throw new ReceiptContractViolation()
  }
}

function positiveSafeInteger(value: unknown, maximum = MAX_DATABASE_ID): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ReceiptContractViolation()
  }
  return value
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    throw new ReceiptContractViolation()
  }
  return value
}

function canonicalText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ReceiptContractViolation()
  }
  return value
}

function canonicalTimeframe(value: unknown): 7 | 30 | 90 {
  if (value !== 7 && value !== 30 && value !== 90) {
    throw new ReceiptContractViolation()
  }
  return value
}

function canonicalDigest(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_DIGEST.test(value) || value === '0'.repeat(64)) {
    throw new ReceiptContractViolation()
  }
  return value
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) {
    throw new ReceiptContractViolation()
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new ReceiptContractViolation()
  }
  return value
}

function normalizeBinding(value: unknown): Readonly<TierAExecutionReceiptWriterBinding> {
  const record = strictDataRecord(value, [
    'claimId',
    'generationSeq',
    'queueJobId',
    'queueName',
    'sourceId',
  ])
  return Object.freeze({
    claimId: canonicalUuid(record.claimId),
    generationSeq: positiveSafeInteger(record.generationSeq),
    queueJobId: canonicalText(record.queueJobId, MAX_QUEUE_JOB_ID_LENGTH),
    queueName: canonicalText(record.queueName, MAX_QUEUE_NAME_LENGTH),
    sourceId: positiveSafeInteger(record.sourceId, MAX_SOURCE_ID),
  })
}

function normalizeRecordInput(value: unknown): Readonly<RecordTierAExecutionWindowReceiptInput> {
  const record = strictDataRecord(value, [
    'attemptId',
    'observationCycleId',
    'rawObjectId',
    'snapshotId',
    'sourceRunId',
    'timeframe',
  ])
  return Object.freeze({
    attemptId: canonicalUuid(record.attemptId),
    observationCycleId: canonicalText(record.observationCycleId, MAX_OBSERVATION_CYCLE_ID_LENGTH),
    rawObjectId: positiveSafeInteger(record.rawObjectId),
    snapshotId: positiveSafeInteger(record.snapshotId),
    sourceRunId: canonicalDigest(record.sourceRunId),
    timeframe: canonicalTimeframe(record.timeframe),
  })
}

function normalizeGetInput(value: unknown): Readonly<GetTierAExecutionWindowReceiptInput> {
  const record = strictDataRecord(value, [
    'observationCycleId',
    'queueJobId',
    'queueName',
    'sourceId',
    'timeframe',
  ])
  return Object.freeze({
    observationCycleId: canonicalText(record.observationCycleId, MAX_OBSERVATION_CYCLE_ID_LENGTH),
    queueJobId: canonicalText(record.queueJobId, MAX_QUEUE_JOB_ID_LENGTH),
    queueName: canonicalText(record.queueName, MAX_QUEUE_NAME_LENGTH),
    sourceId: positiveSafeInteger(record.sourceId, MAX_SOURCE_ID),
    timeframe: canonicalTimeframe(record.timeframe),
  })
}

function queryExecutor(value: unknown): IngestQueryExecutor {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof Reflect.get(value, 'query') !== 'function'
    ) {
      throw new ReceiptContractViolation()
    }
    return value as IngestQueryExecutor
  } catch (error) {
    if (error instanceof ReceiptContractViolation) throw error
    throw new ReceiptContractViolation()
  }
}

function rpcPayload(
  result: QueryResult<QueryResultRow>,
  allowNull: boolean
): Record<string, unknown> | null {
  if (result.command !== 'SELECT' || result.rowCount !== 1 || result.rows.length !== 1) {
    throw new ReceiptContractViolation()
  }
  const row = strictDataRecord(result.rows[0], [RECEIPT_RESULT_ALIAS])
  const payload = row[RECEIPT_RESULT_ALIAS]
  if (payload === null && allowNull) return null
  return strictDataRecord(payload, RECEIPT_KEYS)
}

function parseReceipt(payload: Record<string, unknown>): TierAExecutionWindowReceipt {
  if (payload.contract !== TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT) {
    throw new ReceiptContractViolation()
  }
  return Object.freeze({
    contract: TIER_A_EXECUTION_WINDOW_RECEIPT_CONTRACT,
    sourceId: positiveSafeInteger(payload.source_id, MAX_SOURCE_ID),
    queueName: canonicalText(payload.queue_name, MAX_QUEUE_NAME_LENGTH),
    queueJobId: canonicalText(payload.queue_job_id, MAX_QUEUE_JOB_ID_LENGTH),
    observationCycleId: canonicalText(
      payload.observation_cycle_id,
      MAX_OBSERVATION_CYCLE_ID_LENGTH
    ),
    timeframe: canonicalTimeframe(payload.timeframe),
    claimId: canonicalUuid(payload.claim_id),
    generationSeq: positiveSafeInteger(payload.generation_seq),
    attemptId: canonicalUuid(payload.attempt_id),
    attemptSeq: positiveSafeInteger(payload.attempt_seq),
    snapshotId: positiveSafeInteger(payload.snapshot_id),
    rawObjectId: positiveSafeInteger(payload.raw_object_id),
    sourceRunId: canonicalDigest(payload.source_run_id),
    recordedAt: canonicalTimestamp(payload.recorded_at),
  })
}

function assertRecordIdentity(
  receipt: TierAExecutionWindowReceipt,
  binding: TierAExecutionReceiptWriterBinding,
  input: RecordTierAExecutionWindowReceiptInput
): void {
  if (
    receipt.sourceId !== binding.sourceId ||
    receipt.queueName !== binding.queueName ||
    receipt.queueJobId !== binding.queueJobId ||
    receipt.claimId !== binding.claimId ||
    receipt.generationSeq !== binding.generationSeq ||
    receipt.attemptId !== input.attemptId ||
    receipt.snapshotId !== input.snapshotId ||
    receipt.timeframe !== input.timeframe ||
    receipt.observationCycleId !== input.observationCycleId ||
    receipt.rawObjectId !== input.rawObjectId ||
    receipt.sourceRunId !== input.sourceRunId
  ) {
    throw new ReceiptContractViolation()
  }
}

function assertGetIdentity(
  receipt: TierAExecutionWindowReceipt,
  input: GetTierAExecutionWindowReceiptInput
): void {
  if (
    receipt.sourceId !== input.sourceId ||
    receipt.queueName !== input.queueName ||
    receipt.queueJobId !== input.queueJobId ||
    receipt.observationCycleId !== input.observationCycleId ||
    receipt.timeframe !== input.timeframe
  ) {
    throw new ReceiptContractViolation()
  }
}

function createTierAExecutionReceiptWriter(
  transaction: TierAExecutionClaimedWrite,
  binding: Readonly<TierAExecutionReceiptWriterBinding>
): TierAExecutionReceiptWriter {
  assertTierAExecutionClaimedWrite(transaction)
  const writer = Object.freeze({}) as TierAExecutionReceiptWriter
  RECEIPT_WRITERS.set(writer, Object.freeze({ binding, transaction }))
  return writer
}

/**
 * Adapts the runtime-branded executor supplied by
 * SourceJobExecutionAuthority.withClaimedWrite into a narrower receipt writer.
 * The writer is revoked as soon as this callback settles.
 */
export async function withTierAExecutionReceiptWriter<T>(
  transaction: TierAExecutionClaimedWrite,
  binding: TierAExecutionReceiptWriterBinding,
  callback: (writer: TierAExecutionReceiptWriter) => Promise<T>
): Promise<T> {
  try {
    assertTierAExecutionClaimedWrite(transaction)
  } catch {
    throw receiptError('writer', 'unauthorized')
  }
  let normalizedBinding: Readonly<TierAExecutionReceiptWriterBinding>
  try {
    normalizedBinding = normalizeBinding(binding)
    if (typeof callback !== 'function') throw new ReceiptContractViolation()
  } catch {
    throw receiptError('writer', 'invalid_input')
  }
  const writer = createTierAExecutionReceiptWriter(transaction, normalizedBinding)
  try {
    return await callback(writer)
  } finally {
    RECEIPT_WRITERS.delete(writer as object)
  }
}

function databaseErrorCode(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('code' in value)) return ''
  return String((value as { code: unknown }).code)
}

async function recordReceiptWithSql(
  operation: 'record' | 'republish',
  sql: string,
  writer: TierAExecutionReceiptWriter,
  input: RecordTierAExecutionWindowReceiptInput
): Promise<TierAExecutionWindowReceipt> {
  const state =
    writer !== null && typeof writer === 'object'
      ? RECEIPT_WRITERS.get(writer as object)
      : undefined
  if (state === undefined) throw receiptError(operation, 'unauthorized')

  try {
    assertTierAExecutionClaimedWrite(state.transaction)
  } catch {
    throw receiptError(operation, 'unauthorized')
  }
  let normalized: Readonly<RecordTierAExecutionWindowReceiptInput>
  try {
    normalized = normalizeRecordInput(input)
  } catch {
    throw receiptError(operation, 'invalid_input')
  }

  let result: QueryResult<QueryResultRow>
  try {
    result = await state.transaction.query(
      sql,
      Object.freeze([
        state.binding.claimId,
        state.binding.generationSeq,
        normalized.attemptId,
        normalized.snapshotId,
      ])
    )
  } catch (cause) {
    // 42883 undefined_function: the republish migration is not applied.
    if (operation === 'republish' && databaseErrorCode(cause) === '42883') {
      throw receiptError(operation, 'undefined_function')
    }
    throw receiptError(operation, 'unavailable')
  }

  try {
    assertTierAExecutionClaimedWrite(state.transaction)
  } catch {
    throw receiptError(operation, 'unauthorized')
  }
  try {
    const payload = rpcPayload(result, false)
    if (payload === null) throw new ReceiptContractViolation()
    const receipt = parseReceipt(payload)
    assertRecordIdentity(receipt, state.binding, normalized)
    return receipt
  } catch {
    throw receiptError(operation, 'rpc_contract_violation')
  }
}

/** Record one database-derived window receipt on the caller's claimed transaction. */
export async function recordTierAExecutionWindowReceipt(
  writer: TierAExecutionReceiptWriter,
  input: RecordTierAExecutionWindowReceiptInput
): Promise<TierAExecutionWindowReceipt> {
  return recordReceiptWithSql('record', RECORD_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL, writer, input)
}

/**
 * Record the window receipt for a re-published earlier-claim capture on the
 * caller's claimed transaction. The returned receipt is validated exactly
 * like an ordinary receipt: it names the calling claim, the re-published
 * attempt, the snapshot, the source payload RAW and the source run.
 */
export async function recordTierAExecutionWindowRepublishReceipt(
  writer: TierAExecutionReceiptWriter,
  input: RecordTierAExecutionWindowReceiptInput
): Promise<TierAExecutionWindowReceipt> {
  return recordReceiptWithSql(
    'republish',
    RECORD_TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_SQL,
    writer,
    input
  )
}

/**
 * Whether the republish receipt RPC exists. Probed before any republish
 * publication so a missing migration can never leave a published snapshot
 * without its receipt.
 */
export async function hasTierAExecutionWindowRepublishReceipt(
  executor: IngestQueryExecutor
): Promise<boolean> {
  let database: IngestQueryExecutor
  try {
    database = queryExecutor(executor)
  } catch {
    throw receiptError('probe', 'invalid_input')
  }
  let result: QueryResult<QueryResultRow>
  try {
    result = await database.query(TIER_A_EXECUTION_WINDOW_REPUBLISH_RECEIPT_PRESENT_SQL)
  } catch {
    throw receiptError('probe', 'unavailable')
  }
  try {
    if (result.rowCount !== 1 || result.rows.length !== 1) throw new ReceiptContractViolation()
    const row = strictDataRecord(result.rows[0], ['republish_receipt_present'])
    if (typeof row.republish_receipt_present !== 'boolean') throw new ReceiptContractViolation()
    return row.republish_receipt_present
  } catch {
    throw receiptError('probe', 'rpc_contract_violation')
  }
}

/** Read the durable receipt by its queue-scoped identity. */
export async function getTierAExecutionWindowReceipt(
  executor: IngestQueryExecutor,
  input: GetTierAExecutionWindowReceiptInput
): Promise<TierAExecutionWindowReceipt | null> {
  let normalized: Readonly<GetTierAExecutionWindowReceiptInput>
  let database: IngestQueryExecutor
  try {
    database = queryExecutor(executor)
    normalized = normalizeGetInput(input)
  } catch {
    throw receiptError('get', 'invalid_input')
  }

  let result: QueryResult<QueryResultRow>
  try {
    result = await database.query(
      GET_TIER_A_EXECUTION_WINDOW_RECEIPT_SQL,
      Object.freeze([
        normalized.sourceId,
        normalized.queueName,
        normalized.queueJobId,
        normalized.observationCycleId,
        normalized.timeframe,
      ])
    )
  } catch {
    throw receiptError('get', 'unavailable')
  }

  try {
    const payload = rpcPayload(result, true)
    if (payload === null) return null
    const receipt = parseReceipt(payload)
    assertGetIdentity(receipt, normalized)
    return receipt
  } catch {
    throw receiptError('get', 'rpc_contract_violation')
  }
}
