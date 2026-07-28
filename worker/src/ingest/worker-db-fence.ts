import { randomBytes, randomUUID } from 'node:crypto'

import type { PoolClient, QueryResult, QueryResultRow } from 'pg'

import { ingestClientConnect } from '@/lib/ingest/db'

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

const MAX_SAFE_DATABASE_INTEGER = 9_007_199_254_740_000
const DATABASE_RESULT_ALIAS = 'worker_db_fence'
const CANONICAL_DECIMAL = /^[1-9][0-9]*$/
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

const BEGIN_READ_COMMITTED = 'BEGIN ISOLATION LEVEL READ COMMITTED'

export type WorkerDbFenceState = 'active' | 'releasing' | 'released' | 'fenced'
export type WorkerDbFenceOperation = 'acquire' | 'activate' | 'renew' | 'release'
export type WorkerDbFenceErrorCode =
  | 'invalid_input'
  | 'invalid_state'
  | 'control_plane_unavailable'
  | 'db_control_outcome_unknown'
  | 'rpc_contract_violation'
  | 'fenced'
  | 'lease_deadline_exceeded'
export type WorkerDbFenceRetryPolicy = 'never' | 'exact_control_only' | 'reacquire'

export class WorkerDbFenceError extends Error {
  readonly code: WorkerDbFenceErrorCode
  readonly operation: WorkerDbFenceOperation
  readonly retryPolicy: WorkerDbFenceRetryPolicy

  constructor(
    code: WorkerDbFenceErrorCode,
    operation: WorkerDbFenceOperation,
    retryPolicy: WorkerDbFenceRetryPolicy
  ) {
    super(`[ingest-worker] worker database fence ${operation} failed (${code})`)
    this.name = 'WorkerDbFenceError'
    this.code = code
    this.operation = operation
    this.retryPolicy = retryPolicy
  }
}

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

function sqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
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

  const releaseBothPlanes = async (): Promise<void> => {
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
        try {
          const redisRenewed = await lease.renewAndPublish(heartbeatSnapshot)
          if (!redisRenewed || !lease.isOwned()) {
            throw dbFenceError('fenced', 'renew', 'reacquire')
          }
          if (state !== 'active') {
            throw dbFenceError('invalid_state', 'renew', 'reacquire')
          }
          const redisProof = lease.proof
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
