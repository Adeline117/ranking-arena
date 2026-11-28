import { randomBytes, randomUUID } from 'node:crypto'

import type { PoolClient, QueryConfig, QueryResult, QueryResultRow } from 'pg'

import { ingestClientConnect } from '@/lib/ingest/db'
import { describeSafeCauseChain } from './safe-error-cause'
import {
  validateWorkerDbFencedWriteStatement,
  WorkerDbFenceError,
  type WorkerDbFenceErrorCode,
  type WorkerDbFenceOperation,
  type WorkerDbFenceRetryPolicy,
} from '@/lib/ingest/db-fenced-write-contract'

import {
  acquireWorkerOwnership,
  normalizeWorkerOwnershipHeartbeat,
  WORKER_OWNER_LEASE_TTL_MS,
  type WorkerAuthorityScope,
  type WorkerOwnershipHeartbeatInput,
  type WorkerOwnershipLease,
  type WorkerOwnershipRedis,
  type WorkerOwnershipRegion,
} from './worker-instance-ownership'

export const WORKER_DB_FENCE_CONTRACT = 'arena.worker-db-fence@1' as const
export const WORKER_DB_FENCE_SAFETY_MARGIN_MS = 30_000
export const WORKER_DB_FENCE_WRITE_FINALIZE_MARGIN_MS = 10_000
export const WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS = 5_000
export const WORKER_DB_FENCE_WRITE_QUERY_CAP_MS = 120_000
export const WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS = 120_000
/**
 * Operator margin for both write caps above (default unchanged). A Tier-A
 * board publication of ~33k rows takes 78-95 s and ran into the 120 s cap on
 * 2026-11-27 (bybit_mt5 7D). The cap can only be raised, and never past the
 * authority lease: a write's deadline is also bounded by the database
 * authority deadline minus the finalize margin, so more than
 * lease TTL - safety margin - finalize margin (140 s) could never be used.
 * Read at each write, so it does not depend on when the environment is loaded.
 */
export const WORKER_DB_FENCE_WRITE_CAP_ENV = 'INGEST_DB_FENCE_WRITE_CAP_MS' as const
export const WORKER_DB_FENCE_WRITE_CAP_MAX_MS =
  WORKER_OWNER_LEASE_TTL_MS -
  WORKER_DB_FENCE_SAFETY_MARGIN_MS -
  WORKER_DB_FENCE_WRITE_FINALIZE_MARGIN_MS

export function resolveWorkerDbFenceWriteCapMs(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[WORKER_DB_FENCE_WRITE_CAP_ENV]
  if (raw === undefined || raw === '') return WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS
  const value = /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : Number.NaN
  if (
    !Number.isSafeInteger(value) ||
    value < WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS ||
    value > WORKER_DB_FENCE_WRITE_CAP_MAX_MS
  ) {
    throw new TypeError(
      `[worker-db-fence] ${WORKER_DB_FENCE_WRITE_CAP_ENV} must be an integer from ` +
        `${WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS} to ${WORKER_DB_FENCE_WRITE_CAP_MAX_MS}`
    )
  }
  return value
}
export const WORKER_DB_FENCE_XACT_STATUS_TIMEOUT_MS = 5_000

const MAX_SAFE_DATABASE_INTEGER = 9_007_199_254_740_000
const DATABASE_RESULT_ALIAS = 'worker_db_fence'
const CANONICAL_DECIMAL = /^[1-9][0-9]*$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_XID8 = 18_446_744_073_709_551_615n

const ACTIVATE_SQL = `SELECT arena.activate_ingest_worker_authority(
    p_scope => $1::text,
    p_region => $2::text,
    p_node_id => $3::text,
    p_instance_id => $4::uuid,
    p_owner_token => $5::text,
    p_control_epoch => $6::bigint,
    p_control_server_time_ms => $7::bigint,
    p_release_id => $8::text,
    p_git_sha => $9::text
  ) AS ${DATABASE_RESULT_ALIAS}`

const RENEW_SQL = `SELECT arena.renew_ingest_worker_authority(
    p_scope => $1::text,
    p_region => $2::text,
    p_node_id => $3::text,
    p_instance_id => $4::uuid,
    p_owner_token => $5::text,
    p_control_epoch => $6::bigint,
    p_control_server_time_ms => $7::bigint,
    p_epoch => $8::bigint
  ) AS ${DATABASE_RESULT_ALIAS}`

const RELEASE_SQL = `SELECT arena.release_ingest_worker_authority(
    p_scope => $1::text,
    p_region => $2::text,
    p_node_id => $3::text,
    p_instance_id => $4::uuid,
    p_owner_token => $5::text,
    p_control_epoch => $6::bigint,
    p_epoch => $7::bigint
  ) AS ${DATABASE_RESULT_ALIAS}`

const BEGIN_WRITE_SQL = `SELECT arena.begin_ingest_worker_fenced_write(
    p_scope => $1::text,
    p_region => $2::text,
    p_node_id => $3::text,
    p_instance_id => $4::uuid,
    p_owner_token => $5::text,
    p_control_epoch => $6::bigint,
    p_epoch => $7::bigint
  ) AS ${DATABASE_RESULT_ALIAS}`

const XACT_STATUS_ALIAS = 'worker_db_fence_xact_status'
const XACT_STATUS_SQL = `SELECT pg_catalog.pg_xact_status($1::pg_catalog.xid8) AS ${XACT_STATUS_ALIAS}`

const LOCK_TIMEOUT_ALIAS = 'worker_db_fence_lock_timeout'
const STATEMENT_TIMEOUT_ALIAS = 'worker_db_fence_statement_timeout'
const TRANSACTION_TIMEOUT_ALIAS = 'worker_db_fence_transaction_timeout'
const CONFIGURE_WRITE_TIMEOUTS_SQL = `SELECT
    pg_catalog.set_config('statement_timeout', $1::text, true) AS ${STATEMENT_TIMEOUT_ALIAS},
    pg_catalog.set_config('transaction_timeout', $2::text, true) AS ${TRANSACTION_TIMEOUT_ALIAS},
    pg_catalog.set_config('lock_timeout', $3::text, true) AS ${LOCK_TIMEOUT_ALIAS}`

const BEGIN_READ_COMMITTED = 'BEGIN ISOLATION LEVEL READ COMMITTED'

export type WorkerDbFenceState = 'active' | 'releasing' | 'released' | 'fenced'

// The fenced-write SQL contract and error type live in lib/ (see
// lib/ingest/db-fenced-write-contract.ts); re-exported for existing callers.
export { validateWorkerDbFencedWriteStatement, WorkerDbFenceError }
export type { WorkerDbFenceErrorCode, WorkerDbFenceOperation, WorkerDbFenceRetryPolicy }
export interface WorkerDbFenceProof {
  readonly authorityScope: WorkerAuthorityScope
  readonly controlEpoch: number
  readonly controlServerTimeMs: number
  readonly databaseEpoch: number
  readonly databaseLeaseExpiresAt: string
  readonly databaseServerTime: string
  readonly initialControlServerTimeMs: number
  readonly instanceId: string
  readonly nodeId: string
  readonly region: WorkerOwnershipRegion
}

export interface WorkerDbFence {
  readonly proof: WorkerDbFenceProof
  readonly signal: AbortSignal
  readonly state: WorkerDbFenceState
  isActive(): boolean
  release(): Promise<void>
  renewAndPublish(heartbeat: WorkerOwnershipHeartbeatInput): Promise<void>
  /**
   * Runs database-only work in one fenced transaction. The callback must not
   * perform external side effects that PostgreSQL cannot roll back. The SQL
   * filter prevents common mistakes; database-role privileges remain the
   * actual security boundary.
   */
  withFencedWrite<T>(callback: (transaction: WorkerDbFencedWrite) => Promise<T>): Promise<T>
}

export interface WorkerDbFencedWrite {
  readonly signal: AbortSignal
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<R>>
}

export type AcquireWorkerDbFenceResult =
  | {
      readonly authorityScope: WorkerAuthorityScope
      readonly observedControlEpoch: number
      readonly observedControlServerTimeMs: number
      readonly region: WorkerOwnershipRegion
      readonly status: 'contended'
    }
  | { readonly fence: WorkerDbFence; readonly status: 'active' }

type WorkerDbFenceClient = Pick<PoolClient, 'query' | 'release'>
export type WorkerDbFenceConnect = () => Promise<WorkerDbFenceClient>

export interface AcquireWorkerDbFenceOptions {
  heartbeat: WorkerOwnershipHeartbeatInput
  redis: WorkerOwnershipRedis
  connect?: WorkerDbFenceConnect
  monotonicNow?: () => number
}

interface PrivateIdentity {
  authorityScope: WorkerAuthorityScope
  instanceId: string
  ownerToken: string
}

interface RpcIdentity extends PrivateIdentity {
  controlEpoch: number
  nodeId: string
  region: WorkerOwnershipRegion
}

interface ActiveDatabaseProof {
  controlServerTimeMs: number
  databaseEpoch: number
  leaseExpiresAt: string
  leaseRemainingMs: number
  serverTime: string
}

interface ReleaseDatabaseProof {
  released: boolean
  serverTime: string
  status: 'fenced' | 'released'
}

interface AssertedWriteProof extends ActiveDatabaseProof {
  transactionId: string
}

class RpcContractViolation extends Error {}

class RpcAttemptFailure extends Error {
  readonly kind: 'contract' | 'database' | 'unavailable'
  readonly uncertain: boolean
  readonly sqlState: string | undefined

  constructor(
    uncertain: boolean,
    sqlState: string | undefined,
    kind: 'contract' | 'database' | 'unavailable'
  ) {
    super('worker database fence RPC attempt failed')
    this.kind = kind
    this.uncertain = uncertain
    this.sqlState = sqlState
  }
}

function dbFenceError(
  code: WorkerDbFenceErrorCode,
  operation: WorkerDbFenceOperation,
  retryPolicy: WorkerDbFenceRetryPolicy = 'never'
): WorkerDbFenceError {
  return new WorkerDbFenceError(code, operation, retryPolicy)
}

/**
 * The one line that says why the whole regional authority is being fenced.
 * Every in-flight write and heartbeat then aborts with the same code (its
 * operation rewritten to "write"), and the process restarts to reacquire, so
 * without this line a pool timeout, a database error and a Redis error all
 * look alike. Only fields that cannot carry SQL or connection details.
 */
function logFenceControlCause(
  operation: 'write' | 'renew',
  step: string,
  fenced: WorkerDbFenceError,
  cause: unknown
): void {
  console.error(
    `[ingest-worker] DB fence lost on ${operation} at ${step} (${fenced.code}) cause: ${describeSafeCauseChain(cause)}`
  )
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
    Object.prototype.hasOwnProperty.call(value, 'toJSON')
  ) {
    throw new RpcContractViolation()
  }
  return value as Record<string, unknown>
}

function canonicalInteger(value: unknown): number {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) {
    throw new RpcContractViolation()
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SAFE_DATABASE_INTEGER) {
    throw new RpcContractViolation()
  }
  return parsed
}

function canonicalTimestamp(value: unknown): { encoded: string; timeMs: number } {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) {
    throw new RpcContractViolation()
  }
  const timeMs = Date.parse(value)
  if (!Number.isFinite(timeMs) || new Date(timeMs).toISOString() !== value) {
    throw new RpcContractViolation()
  }
  return { encoded: value, timeMs }
}

function validateEnvelope(result: QueryResult<QueryResultRow>): Record<string, unknown> {
  const row = result.rows.length === 1 ? strictRecord(result.rows[0]) : undefined
  if (result.rowCount !== 1 || row === undefined || !exactKeys(row, [DATABASE_RESULT_ALIAS])) {
    throw new RpcContractViolation()
  }
  return strictRecord(row[DATABASE_RESULT_ALIAS])
}

const ACTIVE_KEYS = [
  'authority_scope',
  'contract',
  'control_epoch',
  'control_server_time_ms',
  'epoch',
  'instance_id',
  'lease_expires_at',
  'node_id',
  'region',
  'server_time',
  'status',
] as const

const RELEASE_KEYS = [
  'authority_scope',
  'contract',
  'control_epoch',
  'epoch',
  'instance_id',
  'node_id',
  'region',
  'released',
  'server_time',
  'status',
] as const

const ASSERTED_WRITE_KEYS = [
  'authority_scope',
  'contract',
  'control_epoch',
  'control_server_time_ms',
  'epoch',
  'instance_id',
  'lease_expires_at',
  'node_id',
  'region',
  'server_time',
  'status',
  'transaction_id',
] as const

function validateSharedIdentity(
  payload: Record<string, unknown>,
  identity: RpcIdentity,
  expectedKeys: readonly string[]
): void {
  if (
    !exactKeys(payload, expectedKeys) ||
    payload.contract !== WORKER_DB_FENCE_CONTRACT ||
    payload.authority_scope !== identity.authorityScope ||
    payload.region !== identity.region ||
    payload.node_id !== identity.nodeId ||
    payload.instance_id !== identity.instanceId ||
    !CANONICAL_UUID.test(identity.instanceId) ||
    canonicalInteger(payload.control_epoch) !== identity.controlEpoch
  ) {
    throw new RpcContractViolation()
  }
}

function validateActiveResult(
  result: QueryResult<QueryResultRow>,
  identity: RpcIdentity,
  expectedControlServerTimeMs: number,
  expectedDatabaseEpoch?: number
): ActiveDatabaseProof {
  const payload = validateEnvelope(result)
  validateSharedIdentity(payload, identity, ACTIVE_KEYS)
  if (
    payload.status !== 'active' ||
    canonicalInteger(payload.control_server_time_ms) !== expectedControlServerTimeMs
  ) {
    throw new RpcContractViolation()
  }
  const databaseEpoch = canonicalInteger(payload.epoch)
  if (expectedDatabaseEpoch !== undefined && databaseEpoch !== expectedDatabaseEpoch) {
    throw new RpcContractViolation()
  }
  const serverTime = canonicalTimestamp(payload.server_time)
  const leaseExpiresAt = canonicalTimestamp(payload.lease_expires_at)
  const leaseRemainingMs = leaseExpiresAt.timeMs - serverTime.timeMs
  if (leaseRemainingMs <= 0 || leaseRemainingMs > WORKER_OWNER_LEASE_TTL_MS) {
    throw new RpcContractViolation()
  }
  return {
    controlServerTimeMs: expectedControlServerTimeMs,
    databaseEpoch,
    leaseExpiresAt: leaseExpiresAt.encoded,
    leaseRemainingMs,
    serverTime: serverTime.encoded,
  }
}

function validateReleaseResult(
  result: QueryResult<QueryResultRow>,
  identity: RpcIdentity,
  expectedDatabaseEpoch: number
): ReleaseDatabaseProof {
  const payload = validateEnvelope(result)
  validateSharedIdentity(payload, identity, RELEASE_KEYS)
  const status = payload.status
  if (
    canonicalInteger(payload.epoch) !== expectedDatabaseEpoch ||
    typeof payload.released !== 'boolean' ||
    (status !== 'released' && status !== 'fenced') ||
    (payload.released && status !== 'released') ||
    (!payload.released && status !== 'fenced')
  ) {
    throw new RpcContractViolation()
  }
  return {
    released: payload.released,
    serverTime: canonicalTimestamp(payload.server_time).encoded,
    status,
  }
}

function canonicalTransactionId(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) {
    throw new RpcContractViolation()
  }
  const parsed = BigInt(value)
  if (parsed < 1n || parsed > MAX_XID8) throw new RpcContractViolation()
  return value
}

function validateAssertedWriteResult(
  result: QueryResult<QueryResultRow>,
  identity: RpcIdentity,
  expectedDatabaseEpoch: number,
  minimumControlServerTimeMs: number,
  maximumControlServerTimeMs: number
): AssertedWriteProof {
  const payload = validateEnvelope(result)
  validateSharedIdentity(payload, identity, ASSERTED_WRITE_KEYS)
  if (payload.status !== 'asserted' || canonicalInteger(payload.epoch) !== expectedDatabaseEpoch) {
    throw new RpcContractViolation()
  }
  const controlServerTimeMs = canonicalInteger(payload.control_server_time_ms)
  if (
    controlServerTimeMs < minimumControlServerTimeMs ||
    controlServerTimeMs > maximumControlServerTimeMs
  ) {
    throw new RpcContractViolation()
  }
  const serverTime = canonicalTimestamp(payload.server_time)
  const leaseExpiresAt = canonicalTimestamp(payload.lease_expires_at)
  const leaseRemainingMs = leaseExpiresAt.timeMs - serverTime.timeMs
  if (leaseRemainingMs <= 0 || leaseRemainingMs > WORKER_OWNER_LEASE_TTL_MS) {
    throw new RpcContractViolation()
  }
  return {
    controlServerTimeMs,
    databaseEpoch: expectedDatabaseEpoch,
    leaseExpiresAt: leaseExpiresAt.encoded,
    leaseRemainingMs,
    serverTime: serverTime.encoded,
    transactionId: canonicalTransactionId(payload.transaction_id),
  }
}

function validateXactStatus(
  result: QueryResult<QueryResultRow>
): 'aborted' | 'committed' | 'in progress' | null {
  const row = result.rows.length === 1 ? strictRecord(result.rows[0]) : undefined
  if (
    result.command !== 'SELECT' ||
    result.rowCount !== 1 ||
    row === undefined ||
    !exactKeys(row, [XACT_STATUS_ALIAS])
  ) {
    throw new RpcContractViolation()
  }
  const status = row[XACT_STATUS_ALIAS]
  if (
    status === null ||
    status === 'aborted' ||
    status === 'committed' ||
    status === 'in progress'
  ) {
    return status
  }
  throw new RpcContractViolation()
}

function sqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function commitResponseMayBeUnknown(error: unknown): boolean {
  const code = sqlState(error)
  const severity =
    error !== null && typeof error === 'object'
      ? (error as { severity?: unknown }).severity
      : undefined
  if (severity === 'FATAL' || severity === 'PANIC') return true
  if (code === undefined || code.startsWith('E') || !/^[0-9A-Z]{5}$/.test(code)) return true
  return /^08/.test(code) || code === '25P04' || code === '40003' || /^57P0[123]$/.test(code)
}

function snapshotWriteValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw dbFenceError('invalid_input', 'write')
    return new Date(value.getTime())
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    try {
      return structuredClone(value)
    } catch {
      throw dbFenceError('invalid_input', 'write')
    }
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw dbFenceError('invalid_input', 'write')
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const snapshot: unknown[] = new Array(value.length)
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined) continue
        if (!('value' in descriptor)) throw dbFenceError('invalid_input', 'write')
        snapshot[index] = snapshotWriteValue(descriptor.value, ancestors)
      }
      return Object.freeze(snapshot)
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw dbFenceError('invalid_input', 'write')
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw dbFenceError('invalid_input', 'write')
    }
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) {
      throw dbFenceError('invalid_input', 'write')
    }
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) {
        throw dbFenceError('invalid_input', 'write')
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: snapshotWriteValue(descriptor.value, ancestors),
        writable: false,
      })
    }
    return Object.freeze(snapshot)
  } finally {
    ancestors.delete(value)
  }
}

function snapshotWriteValues(values: readonly unknown[]): unknown[] {
  const snapshot = values.map((value) => snapshotWriteValue(value, new Set<object>()))
  Object.freeze(snapshot)
  return snapshot
}

function validateTransactionCommand(
  result: QueryResult<QueryResultRow>,
  expected: 'BEGIN' | 'COMMIT' | 'ROLLBACK'
): void {
  if (result.command !== expected || result.rowCount !== null || result.rows.length !== 0) {
    throw new RpcContractViolation()
  }
}

function validateWriteTimeouts(
  result: QueryResult<QueryResultRow>,
  expectedTimeoutMs: number,
  expectedLockTimeoutMs: number
): void {
  const row = result.rows.length === 1 ? strictRecord(result.rows[0]) : undefined
  if (
    result.command !== 'SELECT' ||
    result.rowCount !== 1 ||
    row === undefined ||
    !exactKeys(row, [LOCK_TIMEOUT_ALIAS, STATEMENT_TIMEOUT_ALIAS, TRANSACTION_TIMEOUT_ALIAS]) ||
    parsePostgresDurationMs(row[STATEMENT_TIMEOUT_ALIAS]) !== expectedTimeoutMs ||
    parsePostgresDurationMs(row[TRANSACTION_TIMEOUT_ALIAS]) !== expectedTimeoutMs ||
    parsePostgresDurationMs(row[LOCK_TIMEOUT_ALIAS]) !== expectedLockTimeoutMs
  ) {
    throw new RpcContractViolation()
  }
}

function parsePostgresDurationMs(value: unknown): number {
  if (typeof value !== 'string') throw new RpcContractViolation()
  const match = /^(0|[1-9][0-9]*)(ms|s|min|h|d)$/.exec(value)
  if (match === null) throw new RpcContractViolation()
  const multiplier =
    match[2] === 'ms'
      ? 1
      : match[2] === 's'
        ? 1_000
        : match[2] === 'min'
          ? 60_000
          : match[2] === 'h'
            ? 3_600_000
            : 86_400_000
  const milliseconds = Number(match[1]) * multiplier
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new RpcContractViolation()
  }
  return milliseconds
}

function mapWriteControlError(error: unknown): WorkerDbFenceError {
  if (error instanceof WorkerDbFenceError) return error
  if (error instanceof RpcContractViolation) {
    return dbFenceError('rpc_contract_violation', 'write')
  }
  const code = sqlState(error)
  if (code === '55000' || code === '55P03') {
    return dbFenceError('fenced', 'write', 'reacquire')
  }
  if (code === '22023' || code === '25001') {
    return dbFenceError('rpc_contract_violation', 'write')
  }
  return dbFenceError('control_plane_unavailable', 'write', 'reacquire')
}

type ExtendedQueryConfig = QueryConfig<unknown[]> & {
  queryMode: 'extended'
  query_timeout: number
}

function extendedQuery(
  text: string,
  values: unknown[],
  queryTimeoutMs: number
): ExtendedQueryConfig {
  return {
    queryMode: 'extended',
    query_timeout: Math.max(1, Math.floor(queryTimeoutMs)),
    text,
    values,
  }
}

async function readXactStatusOnce(
  connect: WorkerDbFenceConnect,
  transactionId: string,
  timeoutMs: number
): Promise<'aborted' | 'committed' | 'in progress' | null | undefined> {
  let client: WorkerDbFenceClient | undefined
  let expired = false
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true
        if (client !== undefined) destroyClient(client, true)
        reject(new RpcContractViolation())
      }, timeoutMs)
      timer.unref?.()
    })
    const connected = connect().then((value) => {
      if (expired) {
        destroyClient(value, true)
        throw new RpcContractViolation()
      }
      client = value
      return value
    })
    const connectedClient = await Promise.race([connected, timeout])
    const values: unknown[] = [transactionId]
    Object.freeze(values)
    const result = await Promise.race([
      connectedClient.query(extendedQuery(XACT_STATUS_SQL, values, timeoutMs)),
      timeout,
    ])
    const status = validateXactStatus(result)
    destroyClient(connectedClient, false)
    client = undefined
    return status
  } catch {
    if (client !== undefined) destroyClient(client, true)
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function reconcileXactStatus(
  connect: WorkerDbFenceConnect,
  transactionId: string
): Promise<'aborted' | 'committed' | 'unknown'> {
  const deadlineAt = performance.now() + WORKER_DB_FENCE_XACT_STATUS_TIMEOUT_MS
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const remaining = Math.floor(deadlineAt - performance.now())
    if (remaining < 1) return 'unknown'
    const status = await readXactStatusOnce(connect, transactionId, remaining)
    if (status === 'aborted' || status === 'committed') return status
    if (status !== 'in progress') return 'unknown'
    if (attempt < 7) {
      const delayMs = Math.min(
        1_000,
        50 * 2 ** attempt,
        Math.max(0, Math.floor(deadlineAt - performance.now()))
      )
      if (delayMs < 1) return 'unknown'
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        timer.unref?.()
      })
    }
  }
  return 'unknown'
}

function destroyClient(client: WorkerDbFenceClient, destroy: boolean): void {
  try {
    client.release(destroy)
  } catch {
    // A broken client is already outside the pool's reusable set. Never let a
    // release error replace the fixed, secret-free control-plane error.
  }
}

async function executeRpcAttempt<T>({
  connect,
  monotonicNow,
  params,
  parse,
  sql,
}: {
  connect: WorkerDbFenceConnect
  monotonicNow: () => number
  params: string[]
  parse: (result: QueryResult<QueryResultRow>) => T
  sql: string
}): Promise<{ proof: T; startedAt: number }> {
  const startedAt = monotonicNow()
  let client: WorkerDbFenceClient
  try {
    client = await connect()
  } catch (error) {
    // No transaction or RPC was sent, so this is unavailable but never an
    // outcome-unknown control mutation.
    throw new RpcAttemptFailure(false, sqlState(error), 'unavailable')
  }

  let began = false
  let commitStarted = false
  try {
    await client.query(BEGIN_READ_COMMITTED)
    began = true
    const result = await client.query(sql, params)
    const proof = parse(result)
    commitStarted = true
    await client.query('COMMIT')
    destroyClient(client, false)
    return { proof, startedAt }
  } catch (error) {
    let rollbackFailed = false
    if (began && !commitStarted) {
      try {
        await client.query('ROLLBACK')
      } catch {
        rollbackFailed = true
      }
    }
    // The RPC runs inside an explicit transaction. Before COMMIT is sent, a
    // failed/destroyed connection cannot make its mutation durable. Only a
    // COMMIT response failure has an ambiguous durable outcome.
    const uncertain = commitStarted
    const code = sqlState(error)
    const kind =
      error instanceof RpcContractViolation
        ? 'contract'
        : code === undefined
          ? 'unavailable'
          : 'database'
    destroyClient(client, uncertain || rollbackFailed)
    throw new RpcAttemptFailure(uncertain, code, kind)
  }
}

async function executeRpc<T>({
  connect,
  monotonicNow,
  operation,
  params,
  parse,
  sql,
}: {
  connect: WorkerDbFenceConnect
  monotonicNow: () => number
  operation: Exclude<WorkerDbFenceOperation, 'acquire'>
  params: string[]
  parse: (result: QueryResult<QueryResultRow>) => T
  sql: string
}): Promise<{ proof: T; startedAt: number }> {
  Object.freeze(params)
  let lastFailure: RpcAttemptFailure | undefined
  let sawUncertainCommit = false
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await executeRpcAttempt({ connect, monotonicNow, params, parse, sql })
    } catch (error) {
      const failure =
        error instanceof RpcAttemptFailure
          ? error
          : new RpcAttemptFailure(false, undefined, 'unavailable')
      lastFailure = failure
      sawUncertainCommit ||= failure.uncertain
      if (attempt === 0 && failure.uncertain) continue
      break
    }
  }

  // The fence error thrown below carries only a fixed code; the driver's
  // SQLSTATE / errno would otherwise be lost here.
  if (lastFailure !== undefined) {
    const driverCode =
      lastFailure.sqlState !== undefined && /^[A-Za-z0-9_]{2,40}$/.test(lastFailure.sqlState)
        ? lastFailure.sqlState
        : 'none'
    console.error(
      `[ingest-worker] DB fence control RPC ${operation} failed: kind=${lastFailure.kind} code=${driverCode} outcome_unknown=${sawUncertainCommit}`
    )
  }

  // A failed exact replay can never erase provenance from an earlier
  // outcome-unknown COMMIT. Only a successfully validated replay resolves it.
  if (sawUncertainCommit) {
    throw dbFenceError('db_control_outcome_unknown', operation, 'exact_control_only')
  }
  if (
    lastFailure?.kind === 'database' &&
    (lastFailure.sqlState === '55000' || lastFailure.sqlState === '55P03')
  ) {
    throw dbFenceError('fenced', operation, 'reacquire')
  }
  if (
    lastFailure?.kind === 'contract' ||
    (lastFailure?.kind === 'database' &&
      (lastFailure.sqlState === '22023' || lastFailure.sqlState === '25001'))
  ) {
    throw dbFenceError('rpc_contract_violation', operation)
  }
  throw dbFenceError(
    'control_plane_unavailable',
    operation,
    operation === 'release' ? 'exact_control_only' : 'reacquire'
  )
}

function authorityScopeFor(region: WorkerOwnershipRegion): WorkerAuthorityScope {
  return `region:${region}`
}

function createIdentity(region: WorkerOwnershipRegion): PrivateIdentity {
  return {
    authorityScope: authorityScopeFor(region),
    instanceId: randomUUID(),
    ownerToken: randomBytes(32).toString('hex'),
  }
}

function snapshotHeartbeat(
  heartbeat: WorkerOwnershipHeartbeatInput,
  operation: 'acquire' | 'renew'
): WorkerOwnershipHeartbeatInput {
  try {
    const normalized = normalizeWorkerOwnershipHeartbeat(heartbeat)
    const regions = [...normalized.regions]
    Object.freeze(regions)
    return Object.freeze({ ...normalized, regions })
  } catch {
    throw dbFenceError('invalid_input', operation)
  }
}

function rpcIdentity(identity: PrivateIdentity, lease: WorkerOwnershipLease): RpcIdentity {
  const proof = lease.proof
  return {
    ...identity,
    controlEpoch: proof.controlEpoch,
    nodeId: proof.nodeId,
    region: proof.region,
  }
}

function activateDatabase(
  connect: WorkerDbFenceConnect,
  monotonicNow: () => number,
  identity: RpcIdentity,
  heartbeat: WorkerOwnershipHeartbeatInput,
  initialControlServerTimeMs: number
): Promise<{ proof: ActiveDatabaseProof; startedAt: number }> {
  const params = [
    identity.authorityScope,
    identity.region,
    identity.nodeId,
    identity.instanceId,
    identity.ownerToken,
    String(identity.controlEpoch),
    String(initialControlServerTimeMs),
    heartbeat.release_id,
    heartbeat.sha,
  ]
  return executeRpc({
    connect,
    monotonicNow,
    operation: 'activate',
    params,
    parse: (result) => validateActiveResult(result, identity, initialControlServerTimeMs),
    sql: ACTIVATE_SQL,
  })
}

function renewDatabase(
  connect: WorkerDbFenceConnect,
  monotonicNow: () => number,
  identity: RpcIdentity,
  controlServerTimeMs: number,
  databaseEpoch: number
): Promise<{ proof: ActiveDatabaseProof; startedAt: number }> {
  const params = [
    identity.authorityScope,
    identity.region,
    identity.nodeId,
    identity.instanceId,
    identity.ownerToken,
    String(identity.controlEpoch),
    String(controlServerTimeMs),
    String(databaseEpoch),
  ]
  return executeRpc({
    connect,
    monotonicNow,
    operation: 'renew',
    params,
    parse: (result) => validateActiveResult(result, identity, controlServerTimeMs, databaseEpoch),
    sql: RENEW_SQL,
  })
}

async function releaseDatabase(
  connect: WorkerDbFenceConnect,
  monotonicNow: () => number,
  identity: RpcIdentity,
  databaseEpoch: number
): Promise<{ proof: ReleaseDatabaseProof; startedAt: number }> {
  const params = [
    identity.authorityScope,
    identity.region,
    identity.nodeId,
    identity.instanceId,
    identity.ownerToken,
    String(identity.controlEpoch),
    String(databaseEpoch),
  ]
  const released = await executeRpc({
    connect,
    monotonicNow,
    operation: 'release',
    params,
    parse: (result) => validateReleaseResult(result, identity, databaseEpoch),
    sql: RELEASE_SQL,
  })
  if (!released.proof.released) {
    throw dbFenceError('fenced', 'release', 'reacquire')
  }
  return released
}

function compositeProof(
  lease: WorkerOwnershipLease,
  databaseProof: ActiveDatabaseProof
): WorkerDbFenceProof {
  const redisProof = lease.proof
  return Object.freeze({
    authorityScope: redisProof.authorityScope,
    controlEpoch: redisProof.controlEpoch,
    controlServerTimeMs: redisProof.controlServerTimeMs,
    databaseEpoch: databaseProof.databaseEpoch,
    databaseLeaseExpiresAt: databaseProof.leaseExpiresAt,
    databaseServerTime: databaseProof.serverTime,
    initialControlServerTimeMs: redisProof.initialControlServerTimeMs,
    instanceId: redisProof.instanceId,
    nodeId: redisProof.nodeId,
    region: redisProof.region,
  })
}

async function bestEffortRedisRelease(lease: WorkerOwnershipLease): Promise<void> {
  try {
    if (lease.isOwned()) await lease.release()
  } catch {
    // Redis TTL remains the final cleanup bound. This path is deliberately
    // silent because the caller receives only the primary sanitized failure.
  }
}

export async function acquireWorkerDbFenceAuthority({
  heartbeat,
  redis,
  connect = ingestClientConnect,
  monotonicNow = () => performance.now(),
}: AcquireWorkerDbFenceOptions): Promise<AcquireWorkerDbFenceResult> {
  // Validated before any ownership is taken: a malformed margin fails startup,
  // not the first write. Every write of this authority uses this value.
  const writeCapMs = resolveWorkerDbFenceWriteCapMs()
  const initialHeartbeat = snapshotHeartbeat(heartbeat, 'acquire')
  const region = initialHeartbeat.regions[0]
  const identity = createIdentity(region)
  let ownership
  try {
    ownership = await acquireWorkerOwnership({
      heartbeat: initialHeartbeat,
      identity,
      monotonicNow,
      redis,
    })
  } catch {
    throw dbFenceError('control_plane_unavailable', 'acquire', 'reacquire')
  }

  if (ownership.status === 'contended') {
    return Object.freeze({
      authorityScope: ownership.authorityScope,
      observedControlEpoch: ownership.observedControlEpoch,
      observedControlServerTimeMs: ownership.observedControlServerTimeMs,
      region: ownership.region,
      status: 'contended' as const,
    })
  }

  const lease = ownership.lease
  const privateIdentity = rpcIdentity(identity, lease)
  let activated: { proof: ActiveDatabaseProof; startedAt: number } | undefined
  try {
    activated = await activateDatabase(
      connect,
      monotonicNow,
      privateIdentity,
      initialHeartbeat,
      lease.proof.initialControlServerTimeMs
    )

    const renewed = await lease.renewAndPublish(initialHeartbeat)
    if (!renewed || !lease.isOwned()) {
      throw dbFenceError('fenced', 'renew', 'reacquire')
    }
    const redisProof = lease.proof
    const databaseRenewed = await renewDatabase(
      connect,
      monotonicNow,
      privateIdentity,
      redisProof.controlServerTimeMs,
      activated.proof.databaseEpoch
    )
    if (!lease.isOwned()) {
      throw dbFenceError('fenced', 'renew', 'reacquire')
    }
    activated = databaseRenewed
  } catch (error) {
    if (activated !== undefined) {
      try {
        await releaseDatabase(connect, monotonicNow, privateIdentity, activated.proof.databaseEpoch)
        await bestEffortRedisRelease(lease)
      } catch {
        // An unknown DB release must leave Redis intact so a new control owner
        // cannot race a possibly-live database authority.
      }
    } else if (
      !(error instanceof WorkerDbFenceError) ||
      error.code !== 'db_control_outcome_unknown'
    ) {
      await bestEffortRedisRelease(lease)
    }
    if (error instanceof WorkerDbFenceError) throw error
    throw dbFenceError('control_plane_unavailable', 'renew', 'reacquire')
  }

  let state: WorkerDbFenceState = 'active'
  let proof = compositeProof(lease, activated.proof)
  let databaseDeadlineAt = 0
  let watchdog: NodeJS.Timeout | undefined
  let operationTail: Promise<void> = Promise.resolve()
  let releasePromise: Promise<void> | undefined
  const inFlightWrites = new Set<Promise<void>>()
  const abortController = new AbortController()

  const clearWatchdog = () => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }
  const abort = (reason: WorkerDbFenceError) => {
    if (!abortController.signal.aborted) abortController.abort(reason)
  }
  const fence = (reason: WorkerDbFenceError) => {
    if (state === 'released' || state === 'fenced') return
    state = 'fenced'
    clearWatchdog()
    abort(reason)
  }
  const scheduleDatabaseWatchdog = (rpcStartedAt: number, databaseProof: ActiveDatabaseProof) => {
    databaseDeadlineAt =
      rpcStartedAt + databaseProof.leaseRemainingMs - WORKER_DB_FENCE_SAFETY_MARGIN_MS
    clearWatchdog()
    const remaining = databaseDeadlineAt - monotonicNow()
    if (remaining <= 0) {
      fence(dbFenceError('lease_deadline_exceeded', 'renew', 'reacquire'))
      return
    }
    watchdog = setTimeout(
      () => fence(dbFenceError('lease_deadline_exceeded', 'renew', 'reacquire')),
      remaining
    )
    watchdog.unref?.()
  }
  // One line per lost authority: whatever fails afterwards (a renewal that
  // finds the fence already gone, the writes it aborts) is that loss's
  // aftermath, not another cause.
  let lossLogged = false
  const logLossOnce = (
    operation: 'write' | 'renew',
    step: string,
    fenced: WorkerDbFenceError,
    cause: unknown
  ) => {
    if (lossLogged) return
    lossLogged = true
    logFenceControlCause(operation, step, fenced, cause)
  }
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationTail.then(operation)
    operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
  const isActive = () => {
    if (state !== 'active') return false
    if (!lease.isOwned()) {
      fence(dbFenceError('fenced', 'renew', 'reacquire'))
      return false
    }
    if (monotonicNow() >= databaseDeadlineAt) {
      fence(dbFenceError('lease_deadline_exceeded', 'renew', 'reacquire'))
      return false
    }
    return true
  }

  scheduleDatabaseWatchdog(activated.startedAt, activated.proof)
  if (!isActive()) {
    try {
      await releaseDatabase(connect, monotonicNow, privateIdentity, proof.databaseEpoch)
      await bestEffortRedisRelease(lease)
    } catch {
      // Preserve DB-first cleanup semantics on a late activation response.
    }
    throw dbFenceError('lease_deadline_exceeded', 'acquire', 'reacquire')
  }

  lease.signal.addEventListener(
    'abort',
    () => {
      if (state === 'active') fence(dbFenceError('fenced', 'renew', 'reacquire'))
    },
    { once: true }
  )

  const runFencedWrite = async <T>(
    callback: (transaction: WorkerDbFencedWrite) => Promise<T>
  ): Promise<T> => {
    const writeStartedAt = monotonicNow()
    // A write snapshots its authority deadline. A concurrent authority renewal
    // may serve new writes, but it cannot safely extend this transaction's
    // already-armed PostgreSQL transaction_timeout.
    const writeDeadlineAt = Math.min(
      writeStartedAt + writeCapMs,
      databaseDeadlineAt - WORKER_DB_FENCE_WRITE_FINALIZE_MARGIN_MS
    )
    const writeAbortController = new AbortController()
    const pendingQueries = new Set<Promise<void>>()
    let firstQueryFailure: unknown
    let hasQueryFailure = false
    let facadeOpen = false
    let client: WorkerDbFenceClient | undefined
    let clientReleased = false
    let began = false
    let commitStarted = false
    let controlPhase = true
    let controlStep: 'connect' | 'begin' | 'timeouts' | 'assert' = 'connect'
    let writeDeadlineTimer: NodeJS.Timeout | undefined

    const writeAbortError = (): WorkerDbFenceError => {
      const reason = writeAbortController.signal.reason
      if (reason instanceof WorkerDbFenceError) return reason
      return dbFenceError('invalid_state', 'write')
    }
    const releaseWriteClient = (destroy: boolean) => {
      if (client === undefined || clientReleased) return
      clientReleased = true
      destroyClient(client, destroy)
    }
    const clearWriteDeadline = () => {
      if (writeDeadlineTimer !== undefined) clearTimeout(writeDeadlineTimer)
      writeDeadlineTimer = undefined
    }
    const abortWrite = (reason: WorkerDbFenceError) => {
      facadeOpen = false
      clearWriteDeadline()
      if (!writeAbortController.signal.aborted) writeAbortController.abort(reason)
      if (!commitStarted) releaseWriteClient(true)
    }
    const abortFromOuterFence = () => {
      const outerReason = abortController.signal.reason
      const reason =
        outerReason instanceof WorkerDbFenceError
          ? dbFenceError(outerReason.code, 'write', outerReason.retryPolicy)
          : dbFenceError('invalid_state', 'write')
      abortWrite(reason)
    }
    const scheduleWriteDeadline = () => {
      clearWriteDeadline()
      const remaining = writeDeadlineAt - monotonicNow()
      if (remaining <= 0) {
        abortWrite(dbFenceError('write_deadline_exceeded', 'write'))
        return
      }
      writeDeadlineTimer = setTimeout(scheduleWriteDeadline, remaining)
      writeDeadlineTimer.unref?.()
    }
    const availableQueryTimeoutMs = (): number => {
      if (!isActive()) {
        throw writeAbortController.signal.aborted
          ? writeAbortError()
          : dbFenceError('invalid_state', 'write', 'reacquire')
      }
      const remaining = writeDeadlineAt - monotonicNow()
      const queryTimeoutMs = Math.floor(remaining)
      if (queryTimeoutMs < 1) {
        const reason = dbFenceError('write_deadline_exceeded', 'write')
        abortWrite(reason)
        throw reason
      }
      return Math.min(writeCapMs, queryTimeoutMs)
    }
    const aborted = new Promise<never>((_resolve, reject) => {
      writeAbortController.signal.addEventListener('abort', () => reject(writeAbortError()), {
        once: true,
      })
    })

    abortController.signal.addEventListener('abort', abortFromOuterFence, { once: true })
    if (abortController.signal.aborted) abortFromOuterFence()

    try {
      scheduleWriteDeadline()
      if (writeAbortController.signal.aborted) throw writeAbortError()
      const connecting = connect().then((connectedClient) => {
        if (writeAbortController.signal.aborted) {
          destroyClient(connectedClient, true)
          throw writeAbortError()
        }
        client = connectedClient
        return connectedClient
      })
      const connectedClient = await Promise.race([connecting, aborted])

      controlStep = 'begin'
      const beginResult = await connectedClient.query<QueryResultRow, unknown[]>(
        extendedQuery(BEGIN_READ_COMMITTED, [], availableQueryTimeoutMs())
      )
      began = true
      validateTransactionCommand(beginResult, 'BEGIN')
      controlStep = 'timeouts'

      const configuredTimeoutMs = availableQueryTimeoutMs()
      const configuredTimeout = `${configuredTimeoutMs}ms`
      const timeoutValues: unknown[] = [
        configuredTimeout,
        configuredTimeout,
        `${WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS}ms`,
      ]
      Object.freeze(timeoutValues)
      const timeoutResult = await connectedClient.query<QueryResultRow, unknown[]>(
        extendedQuery(CONFIGURE_WRITE_TIMEOUTS_SQL, timeoutValues, availableQueryTimeoutMs())
      )
      validateWriteTimeouts(
        timeoutResult,
        configuredTimeoutMs,
        WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS
      )

      const controlParams: unknown[] = [
        privateIdentity.authorityScope,
        privateIdentity.region,
        privateIdentity.nodeId,
        privateIdentity.instanceId,
        privateIdentity.ownerToken,
        String(privateIdentity.controlEpoch),
        String(proof.databaseEpoch),
      ]
      Object.freeze(controlParams)
      controlStep = 'assert'
      const assertedResult = await connectedClient.query<QueryResultRow, unknown[]>(
        extendedQuery(BEGIN_WRITE_SQL, controlParams, availableQueryTimeoutMs())
      )
      const asserted = validateAssertedWriteResult(
        assertedResult,
        privateIdentity,
        proof.databaseEpoch,
        proof.initialControlServerTimeMs,
        lease.proof.controlServerTimeMs
      )
      if (writeAbortController.signal.aborted || !isActive()) {
        throw writeAbortController.signal.aborted
          ? writeAbortError()
          : dbFenceError('invalid_state', 'write', 'reacquire')
      }
      controlPhase = false
      facadeOpen = true

      const trackQuery = <R extends QueryResultRow>(
        query: Promise<QueryResult<R>>
      ): Promise<QueryResult<R>> => {
        const settlement = query.then(
          () => undefined,
          (error: unknown) => {
            if (!hasQueryFailure) {
              hasQueryFailure = true
              firstQueryFailure = error
            }
          }
        )
        pendingQueries.add(settlement)
        void settlement.then(() => pendingQueries.delete(settlement))
        return query
      }

      const query = <R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[]
      ): Promise<QueryResult<R>> => {
        if (!facadeOpen || writeAbortController.signal.aborted) {
          return Promise.reject(
            writeAbortController.signal.aborted
              ? writeAbortError()
              : dbFenceError('invalid_state', 'write')
          )
        }

        let statement: string
        let valuesSnapshot: unknown[]
        let queryTimeoutMs: number
        try {
          if (typeof text !== 'string' || (values !== undefined && !Array.isArray(values))) {
            throw dbFenceError('invalid_input', 'write')
          }
          statement = validateWorkerDbFencedWriteStatement(text)
          valuesSnapshot = snapshotWriteValues(values ?? [])
          queryTimeoutMs = availableQueryTimeoutMs()
        } catch (error) {
          return trackQuery(Promise.reject(error))
        }

        let queryPromise: Promise<QueryResult<R>>
        try {
          queryPromise = connectedClient.query<R, unknown[]>(
            extendedQuery(statement, valuesSnapshot, queryTimeoutMs)
          )
        } catch (error) {
          queryPromise = Promise.reject(error)
        }
        return trackQuery(queryPromise)
      }
      Object.freeze(query)
      const transaction = Object.freeze({
        query,
        signal: writeAbortController.signal,
      })

      let callbackResult!: T
      let callbackFailure: unknown
      let callbackFailed = false
      const callbackPromise = Promise.resolve().then(() => {
        if (writeAbortController.signal.aborted || !isActive()) {
          throw writeAbortController.signal.aborted
            ? writeAbortError()
            : dbFenceError('invalid_state', 'write', 'reacquire')
        }
        return callback(transaction)
      })
      try {
        callbackResult = await Promise.race([callbackPromise, aborted])
      } catch (error) {
        callbackFailed = true
        callbackFailure = error
      } finally {
        facadeOpen = false
      }

      await Promise.all([...pendingQueries])
      if (writeAbortController.signal.aborted) throw writeAbortError()
      if (callbackFailed) throw callbackFailure
      if (hasQueryFailure) throw firstQueryFailure
      if (!isActive()) {
        throw writeAbortController.signal.aborted
          ? writeAbortError()
          : dbFenceError('invalid_state', 'write', 'reacquire')
      }

      const commitTimeoutMs = Math.min(
        WORKER_DB_FENCE_XACT_STATUS_TIMEOUT_MS,
        availableQueryTimeoutMs()
      )
      commitStarted = true
      try {
        const commitResult = await connectedClient.query<QueryResultRow, unknown[]>(
          extendedQuery('COMMIT', [], commitTimeoutMs)
        )
        validateTransactionCommand(commitResult, 'COMMIT')
        releaseWriteClient(false)
        return callbackResult
      } catch (error) {
        releaseWriteClient(true)
        if (!commitResponseMayBeUnknown(error)) {
          if (sqlState(error) === '55000') {
            const fencedError = dbFenceError('fenced', 'write', 'reacquire')
            fence(fencedError)
            throw fencedError
          }
          throw dbFenceError('commit_aborted', 'write')
        }

        const status = await reconcileXactStatus(connect, asserted.transactionId)
        if (status === 'committed') return callbackResult
        if (status === 'aborted') throw dbFenceError('commit_aborted', 'write')
        const unknown = dbFenceError('commit_outcome_unknown', 'write')
        fence(unknown)
        throw unknown
      }
    } catch (error) {
      if (commitStarted) throw error

      let rollbackFailed = false
      if (began && !clientReleased && client !== undefined) {
        try {
          const rollbackResult = await client.query<QueryResultRow, unknown[]>(
            extendedQuery('ROLLBACK', [], WORKER_DB_FENCE_XACT_STATUS_TIMEOUT_MS)
          )
          validateTransactionCommand(rollbackResult, 'ROLLBACK')
        } catch {
          rollbackFailed = true
        }
      }
      releaseWriteClient(rollbackFailed || !began || writeAbortController.signal.aborted)

      if (!controlPhase) throw error
      const sanitized = mapWriteControlError(error)
      if (state === 'active' && sanitized.code !== 'write_deadline_exceeded') {
        // This write is the one that fences the whole authority; every other
        // in-flight operation then aborts with the same code.
        logLossOnce('write', controlStep, sanitized, error)
        fence(sanitized)
      }
      throw sanitized
    } finally {
      facadeOpen = false
      clearWriteDeadline()
      abortController.signal.removeEventListener('abort', abortFromOuterFence)
    }
  }

  const releaseBothPlanes = async (): Promise<void> => {
    if (inFlightWrites.size > 0) {
      await Promise.all([...inFlightWrites])
    }
    try {
      await releaseDatabase(connect, monotonicNow, privateIdentity, proof.databaseEpoch)
    } catch (error) {
      state = 'fenced'
      throw error instanceof WorkerDbFenceError
        ? error
        : dbFenceError('control_plane_unavailable', 'release', 'exact_control_only')
    }

    let redisReleased: boolean
    try {
      redisReleased = await lease.release()
    } catch {
      state = 'fenced'
      throw dbFenceError('control_plane_unavailable', 'release', 'reacquire')
    }
    if (!redisReleased) {
      state = 'fenced'
      throw dbFenceError('fenced', 'release', 'reacquire')
    }
    state = 'released'
  }

  const handle: WorkerDbFence = {
    get proof() {
      return Object.freeze({ ...proof })
    },
    get signal() {
      return abortController.signal
    },
    get state() {
      return state
    },
    isActive,
    withFencedWrite: (callback) => {
      if (typeof callback !== 'function') {
        return Promise.reject(dbFenceError('invalid_input', 'write'))
      }
      if (!isActive()) {
        return Promise.reject(dbFenceError('invalid_state', 'write', 'reacquire'))
      }
      const write = runFencedWrite(callback)
      const settlement = write.then(
        () => undefined,
        () => undefined
      )
      inFlightWrites.add(settlement)
      void settlement.then(() => inFlightWrites.delete(settlement))
      return write
    },
    renewAndPublish: (nextHeartbeat) => {
      if (!isActive()) {
        return Promise.reject(dbFenceError('invalid_state', 'renew', 'reacquire'))
      }
      let heartbeatSnapshot: WorkerOwnershipHeartbeatInput
      try {
        heartbeatSnapshot = snapshotHeartbeat(nextHeartbeat, 'renew')
      } catch (error) {
        return Promise.reject(error)
      }
      return enqueue(async () => {
        if (!isActive()) throw dbFenceError('invalid_state', 'renew', 'reacquire')
        let renewStep: 'redis' | 'database' = 'redis'
        try {
          const redisRenewed = await lease.renewAndPublish(heartbeatSnapshot)
          if (!redisRenewed || !lease.isOwned()) {
            throw dbFenceError('fenced', 'renew', 'reacquire')
          }
          if (state !== 'active') {
            throw dbFenceError('invalid_state', 'renew', 'reacquire')
          }
          const redisProof = lease.proof
          renewStep = 'database'
          const databaseRenewed = await renewDatabase(
            connect,
            monotonicNow,
            privateIdentity,
            redisProof.controlServerTimeMs,
            proof.databaseEpoch
          )
          if (state !== 'active') {
            throw dbFenceError('invalid_state', 'renew', 'reacquire')
          }
          if (!lease.isOwned()) {
            throw dbFenceError('fenced', 'renew', 'reacquire')
          }
          proof = compositeProof(lease, databaseRenewed.proof)
          scheduleDatabaseWatchdog(databaseRenewed.startedAt, databaseRenewed.proof)
          if (!isActive()) throw dbFenceError('lease_deadline_exceeded', 'renew', 'reacquire')
        } catch (error) {
          const sanitized =
            error instanceof WorkerDbFenceError
              ? error
              : dbFenceError('control_plane_unavailable', 'renew', 'reacquire')
          if (state === 'releasing') throw sanitized
          logLossOnce('renew', renewStep, sanitized, error)
          state = 'releasing'
          clearWatchdog()
          const pendingRelease = releaseBothPlanes()
          releasePromise = pendingRelease
          fence(sanitized)
          try {
            await pendingRelease
          } catch {
            // Unknown DB release: deliberately retain the Redis token.
          }
          throw sanitized
        }
      })
    },
    release: () => {
      if (releasePromise) return releasePromise
      if (state === 'released') return Promise.resolve()
      state = 'releasing'
      clearWatchdog()
      const pendingRelease = enqueue(releaseBothPlanes)
      releasePromise = pendingRelease
      abort(dbFenceError('invalid_state', 'release'))
      return pendingRelease
    },
  }

  return Object.freeze({ fence: Object.freeze(handle), status: 'active' as const })
}
