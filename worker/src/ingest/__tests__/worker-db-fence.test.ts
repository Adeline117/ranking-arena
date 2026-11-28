import type { PoolClient, QueryConfig, QueryResult } from 'pg'

import {
  acquireWorkerDbFenceAuthority,
  resolveWorkerDbFenceWriteCapMs,
  WORKER_DB_FENCE_CONTRACT,
  WORKER_DB_FENCE_WRITE_CAP_ENV,
  WORKER_DB_FENCE_WRITE_CAP_MAX_MS,
  WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS,
  WORKER_DB_FENCE_WRITE_QUERY_CAP_MS,
  WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS,
  WorkerDbFenceError,
  type WorkerDbFenceConnect,
} from '../worker-db-fence'
import {
  WORKER_OWNER_LEASE_TTL_MS,
  type WorkerOwnershipHeartbeatInput,
  type WorkerOwnershipRedis,
} from '../worker-instance-ownership'

const NODE = 'worker-db-fence-test'
const CONTROL_EPOCH = 7
const INITIAL_CONTROL_TIME = 2_000_000_000_000
const DATABASE_EPOCH = '41'
const SERVER_TIME_MS = Date.parse('2026-07-28T18:00:00.000Z')

function heartbeat(disk = 42): WorkerOwnershipHeartbeatInput {
  return {
    attempt_bound_capture: true,
    disk,
    node: NODE,
    pid: 4242,
    regions: ['local'],
    release_id: 'b'.repeat(64),
    sha: 'a'.repeat(40),
  }
}

function scriptResult(
  owned: 0 | 1,
  controlServerTimeMs: number,
  initialControlServerTimeMs = controlServerTimeMs,
  leaseRemainingMs = WORKER_OWNER_LEASE_TTL_MS
) {
  return [owned, CONTROL_EPOCH, controlServerTimeMs, initialControlServerTimeMs, leaseRemainingMs]
}

function redisHarness(results: Array<unknown | Error>, events: string[] = []) {
  const evalMock = jest.fn(async (script: string) => {
    const operation = script.includes('worker-ownership.acquire')
      ? 'acquire'
      : script.includes('worker-ownership.renew')
        ? 'renew'
        : 'release'
    events.push(`redis:${operation}`)
    const next = results.shift()
    if (next instanceof Error) throw next
    return next
  })
  return { eval: evalMock } as WorkerOwnershipRedis & { eval: jest.Mock }
}

type DatabaseOperation = 'activate' | 'release' | 'renew' | 'status' | 'write'
type TransactionPhase = 'asserted' | 'begun' | 'finished' | 'new' | 'selected'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

interface DatabaseBehavior {
  businessQueries?: BusinessQueryBehavior[]
  commitBarrier?: Promise<void>
  commitCommand?: string
  commitError?: Error
  commitStarted?: () => void
  connectError?: Error
  controlServerTimeMs?: unknown
  databaseEpoch?: string | number
  error?: Error
  errorFromParams?: (params: string[]) => Error
  leaseExpiresAtMs?: number
  leaseRemainingMs?: number
  mutatePayload?: (payload: Record<string, unknown>) => void
  mutateTimeoutConfiguration?: (payload: Record<string, unknown>) => void
  operation?: DatabaseOperation
  rollbackError?: Error
  rowCount?: number | null
  serverTimeMs?: number
  timeoutConfigurationError?: Error
  transactionId?: unknown
  xactStatus?: unknown
}

interface BusinessQueryBehavior {
  barrier?: Promise<void>
  error?: Error
  result?: QueryResult
  sql?: RegExp | string
  started?: () => void
}

interface ObservedQuery {
  queryMode?: unknown
  queryTimeout?: unknown
  raw: QueryConfig<unknown[]> | string
  text: string
  valuesAtCall?: unknown[]
  valuesReference?: readonly unknown[]
}

interface ClientRecord {
  behavior: DatabaseBehavior
  businessQueries: BusinessQueryBehavior[]
  observedQueries: ObservedQuery[]
  query: jest.Mock
  release: jest.Mock
  phase: TransactionPhase
  selectParams?: string[]
  selectSql?: string
}

function databaseOperation(sql: string): DatabaseOperation {
  if (sql.includes('activate_ingest_worker_authority')) return 'activate'
  if (sql.includes('begin_ingest_worker_fenced_write')) return 'write'
  if (sql.includes('renew_ingest_worker_authority')) return 'renew'
  if (sql.includes('release_ingest_worker_authority')) return 'release'
  if (sql.includes('pg_catalog.pg_xact_status')) return 'status'
  throw new Error(`unexpected database fence SQL: ${sql}`)
}

function observedQuery(
  input: QueryConfig<unknown[]> | string,
  positionalValues?: readonly unknown[]
): ObservedQuery {
  if (typeof input === 'string') {
    return {
      raw: input,
      text: input,
      valuesAtCall: positionalValues === undefined ? undefined : [...positionalValues],
      valuesReference: positionalValues,
    }
  }
  if (typeof input.text !== 'string') throw new Error('query config is missing SQL text')
  const values = input.values
  return {
    queryMode: (input as QueryConfig<unknown[]> & { queryMode?: unknown }).queryMode,
    queryTimeout: (input as QueryConfig<unknown[]> & { query_timeout?: unknown }).query_timeout,
    raw: input,
    text: input.text,
    valuesAtCall: values === undefined ? undefined : [...values],
    valuesReference: values,
  }
}

function commandResult(command: string): QueryResult {
  return { command, fields: [], oid: 0, rowCount: null, rows: [] }
}

function activePayload(
  params: string[],
  behavior: DatabaseBehavior,
  tick: number
): Record<string, unknown> {
  const serverTimeMs = behavior.serverTimeMs ?? SERVER_TIME_MS + tick * 1_000
  const leaseRemainingMs = behavior.leaseRemainingMs ?? WORKER_OWNER_LEASE_TTL_MS
  const leaseExpiresAtMs = behavior.leaseExpiresAtMs ?? serverTimeMs + leaseRemainingMs
  return {
    authority_scope: params[0],
    contract: WORKER_DB_FENCE_CONTRACT,
    control_epoch: params[5],
    control_server_time_ms: params[6],
    epoch: behavior.databaseEpoch ?? DATABASE_EPOCH,
    instance_id: params[3],
    lease_expires_at: new Date(leaseExpiresAtMs).toISOString(),
    node_id: params[2],
    region: params[1],
    server_time: new Date(serverTimeMs).toISOString(),
    status: 'active',
  }
}

function releasePayload(
  params: string[],
  behavior: DatabaseBehavior,
  tick: number
): Record<string, unknown> {
  return {
    authority_scope: params[0],
    contract: WORKER_DB_FENCE_CONTRACT,
    control_epoch: params[5],
    epoch: behavior.databaseEpoch ?? params[6],
    instance_id: params[3],
    node_id: params[2],
    region: params[1],
    released: true,
    server_time: new Date(SERVER_TIME_MS + tick * 1_000).toISOString(),
    status: 'released',
  }
}

function assertedWritePayload(
  params: string[],
  behavior: DatabaseBehavior,
  tick: number,
  currentControlServerTimeMs: string
): Record<string, unknown> {
  const serverTimeMs = behavior.serverTimeMs ?? SERVER_TIME_MS + tick * 1_000
  const leaseRemainingMs = behavior.leaseRemainingMs ?? WORKER_OWNER_LEASE_TTL_MS
  const leaseExpiresAtMs = behavior.leaseExpiresAtMs ?? serverTimeMs + leaseRemainingMs
  return {
    authority_scope: params[0],
    contract: WORKER_DB_FENCE_CONTRACT,
    control_epoch: params[5],
    control_server_time_ms: behavior.controlServerTimeMs ?? currentControlServerTimeMs,
    epoch: behavior.databaseEpoch ?? params[6],
    instance_id: params[3],
    lease_expires_at: new Date(leaseExpiresAtMs).toISOString(),
    node_id: params[2],
    region: params[1],
    server_time: new Date(serverTimeMs).toISOString(),
    status: 'asserted',
    transaction_id: behavior.transactionId ?? '9001',
  }
}

function databaseHarness(
  behaviors: DatabaseBehavior[] = [],
  events: string[] = [],
  strict = false
) {
  const clients: ClientRecord[] = []
  let tick = 0
  let currentControlServerTimeMs = String(INITIAL_CONTROL_TIME)
  const connect = jest.fn(async () => {
    const nextBehavior = behaviors.shift()
    if (nextBehavior === undefined && strict) {
      throw new Error('unexpected PostgreSQL client connection')
    }
    const behavior = nextBehavior ?? {}
    if (behavior.connectError) throw behavior.connectError
    const release = jest.fn()
    const record: ClientRecord = {
      behavior,
      businessQueries: [...(behavior.businessQueries ?? [])],
      observedQueries: [],
      phase: 'new',
      query: jest.fn(),
      release,
    }
    record.query.mockImplementation(
      async (input: QueryConfig<unknown[]> | string, positionalParams?: readonly unknown[]) => {
        const observed = observedQuery(input, positionalParams)
        record.observedQueries.push(observed)
        const sql = observed.text
        const params = observed.valuesReference

        if (sql.includes('pg_catalog.pg_xact_status')) {
          if (record.phase !== 'new') throw new Error('transaction status queried in a transaction')
          if (behavior.operation !== undefined && behavior.operation !== 'status') {
            throw new Error(`expected ${behavior.operation}, received status`)
          }
          events.push('db:status')
          if (behavior.error) throw behavior.error
          const row: Record<string, unknown> = {
            worker_db_fence_xact_status: behavior.xactStatus,
          }
          behavior.mutatePayload?.(row)
          return {
            command: 'SELECT',
            rowCount: behavior.rowCount === undefined ? 1 : behavior.rowCount,
            rows: [row],
          } as QueryResult
        }

        if (sql.startsWith('BEGIN')) {
          if (record.phase !== 'new') throw new Error('transaction began more than once')
          record.phase = 'begun'
          return commandResult('BEGIN')
        }
        if (sql === 'ROLLBACK') {
          if (
            record.phase !== 'asserted' &&
            record.phase !== 'begun' &&
            record.phase !== 'selected'
          ) {
            throw new Error('transaction rolled back outside an active transaction')
          }
          record.phase = 'finished'
          if (behavior.operation === 'write') events.push('db:write:rollback')
          if (behavior.rollbackError) throw behavior.rollbackError
          return commandResult('ROLLBACK')
        }
        if (sql === 'COMMIT') {
          if (record.phase !== 'asserted' && record.phase !== 'selected') {
            throw new Error('transaction committed before its RPC')
          }
          behavior.commitStarted?.()
          if (behavior.commitBarrier) await behavior.commitBarrier
          record.phase = 'finished'
          if (behavior.operation === 'write') events.push('db:write:commit')
          if (behavior.commitError) throw behavior.commitError
          return commandResult(behavior.commitCommand ?? 'COMMIT')
        }

        if (record.phase !== 'begun') throw new Error('RPC executed outside its transaction')
        const operation = databaseOperation(sql)
        if (behavior.operation !== undefined && behavior.operation !== operation) {
          throw new Error(`expected ${behavior.operation}, received ${operation}`)
        }
        events.push(`db:${operation}`)
        record.selectSql = sql
        record.selectParams = params as string[] | undefined
        if (!params) throw new Error('database fence RPC is missing parameters')
        if (behavior.errorFromParams) throw behavior.errorFromParams(params as string[])
        if (behavior.error) throw behavior.error

        if (operation === 'write') {
          const payload = assertedWritePayload(
            params as string[],
            behavior,
            tick,
            currentControlServerTimeMs
          )
          tick += 1
          behavior.mutatePayload?.(payload)
          record.phase = 'asserted'
          return {
            command: 'SELECT',
            rowCount: behavior.rowCount === undefined ? 1 : behavior.rowCount,
            rows: [{ worker_db_fence: payload }],
          } as QueryResult
        }

        const payload =
          operation === 'release'
            ? releasePayload(params as string[], behavior, tick)
            : activePayload(params as string[], behavior, tick)
        tick += 1
        behavior.mutatePayload?.(payload)
        if (operation !== 'release' && typeof payload.control_server_time_ms === 'string') {
          currentControlServerTimeMs = payload.control_server_time_ms
        }
        record.phase = 'selected'
        return {
          rowCount: behavior.rowCount === undefined ? 1 : behavior.rowCount,
          rows: [{ worker_db_fence: payload }],
        } as QueryResult
      }
    )

    const originalImplementation = record.query.getMockImplementation()
    record.query.mockImplementation(
      async (input: QueryConfig<unknown[]> | string, positionalParams?: readonly unknown[]) => {
        const observed = observedQuery(input, positionalParams)
        if (
          behavior.operation === 'write' &&
          record.phase === 'begun' &&
          observed.text.includes("pg_catalog.set_config('statement_timeout'")
        ) {
          record.observedQueries.push(observed)
          const values = observed.valuesReference
          if (
            values === undefined ||
            values.length !== 3 ||
            typeof values[0] !== 'string' ||
            values[0] !== values[1] ||
            values[2] !== `${WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS}ms`
          ) {
            throw new Error('write timeout configuration is malformed')
          }
          if (behavior.timeoutConfigurationError) throw behavior.timeoutConfigurationError
          const payload: Record<string, unknown> = {
            worker_db_fence_lock_timeout: values[2],
            worker_db_fence_statement_timeout: values[0],
            worker_db_fence_transaction_timeout: values[1],
          }
          behavior.mutateTimeoutConfiguration?.(payload)
          return {
            command: 'SELECT',
            rowCount: 1,
            rows: [payload],
          } as QueryResult
        }

        if (behavior.operation === 'write' && record.phase === 'asserted') {
          if (observed.text === 'COMMIT' || observed.text === 'ROLLBACK') {
            return originalImplementation?.(input, positionalParams)
          }
          record.observedQueries.push(observed)
          const business = record.businessQueries.shift()
          if (business === undefined) throw new Error(`unexpected business SQL: ${observed.text}`)
          if (
            (typeof business.sql === 'string' && business.sql !== observed.text) ||
            (business.sql instanceof RegExp && !business.sql.test(observed.text))
          ) {
            throw new Error(`unexpected business SQL: ${observed.text}`)
          }
          events.push('db:business')
          business.started?.()
          if (business.barrier) await business.barrier
          if (business.error) throw business.error
          return (
            business.result ??
            ({ command: 'SELECT', fields: [], oid: 0, rowCount: 1, rows: [] } as QueryResult)
          )
        }

        return originalImplementation?.(input, positionalParams)
      }
    )
    clients.push(record)
    return { query: record.query, release } as Pick<PoolClient, 'query' | 'release'>
  }) as jest.MockedFunction<WorkerDbFenceConnect>
  return { clients, connect, remainingBehaviors: behaviors }
}

function connectionError(code = '08006', message = 'driver carried a secret value'): Error {
  return Object.assign(new Error(message), { code })
}

async function acquireActiveFence(
  database: ReturnType<typeof databaseHarness>,
  redis = redisHarness([
    scriptResult(1, INITIAL_CONTROL_TIME),
    scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
    scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
  ])
) {
  const result = await acquireWorkerDbFenceAuthority({
    connect: database.connect,
    heartbeat: heartbeat(),
    monotonicNow: () => 1_000,
    redis,
  })
  if (result.status !== 'active') throw new Error('expected active fence')
  return { fence: result.fence, redis }
}

describe('worker database fence lifecycle', () => {
  it('uses one private credential across Redis and DB without exposing it publicly', async () => {
    const events: string[] = []
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME + 5_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 6_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 6_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness([], events)

    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      monotonicNow: () => 1_000,
      redis,
    })

    expect(result.status).toBe('active')
    if (result.status !== 'active') throw new Error('expected active fence')
    const [, , ...redisArgs] = redis.eval.mock.calls[0] as [string, number, ...string[]]
    const token = redisArgs[6]
    const activation = database.clients[0]
    const renewal = database.clients[1]
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(activation.selectParams?.[4]).toBe(token)
    expect(renewal.selectParams?.[4]).toBe(token)
    expect(activation.selectParams?.[6]).toBe(String(INITIAL_CONTROL_TIME))
    expect(renewal.selectParams?.[6]).toBe(String(INITIAL_CONTROL_TIME + 6_000))
    expect(activation.selectSql).toContain('p_owner_token => $5::text')
    expect(activation.selectSql).toContain('p_control_server_time_ms => $7::bigint')
    expect(result.fence.proof).toMatchObject({
      controlEpoch: CONTROL_EPOCH,
      controlServerTimeMs: INITIAL_CONTROL_TIME + 6_000,
      databaseEpoch: Number(DATABASE_EPOCH),
      initialControlServerTimeMs: INITIAL_CONTROL_TIME,
      nodeId: NODE,
    })
    expect(Object.isFrozen(result.fence)).toBe(true)
    expect(Object.isFrozen(result.fence.proof)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(token)
    expect(String(result.fence.signal.reason ?? '')).not.toContain(token)

    events.length = 0
    await result.fence.release()
    expect(events).toEqual(['db:release', 'redis:release'])
    expect(database.clients[2].selectParams?.[4]).toBe(token)
    expect(JSON.stringify(result)).not.toContain(token)
  })

  it('returns a token-free contender without touching PostgreSQL', async () => {
    const redis = redisHarness([scriptResult(0, INITIAL_CONTROL_TIME)])
    const database = databaseHarness()

    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })

    expect(result).toEqual({
      authorityScope: 'region:local',
      observedControlEpoch: CONTROL_EPOCH,
      observedControlServerTimeMs: INITIAL_CONTROL_TIME,
      region: 'local',
      status: 'contended',
    })
    expect(Object.keys(result)).not.toContain('instanceId')
    expect(database.connect).not.toHaveBeenCalled()
  })

  it('rejects malformed acquisition input before generating control-plane state', async () => {
    const malformedHeartbeat = Object.assign(heartbeat(), { unexpected: true })
    const redis = redisHarness([])
    const database = databaseHarness()

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: malformedHeartbeat,
        redis,
      })
    ).rejects.toMatchObject({ code: 'invalid_input', operation: 'acquire' })

    expect(redis.eval).not.toHaveBeenCalled()
    expect(database.connect).not.toHaveBeenCalled()
  })

  it('exactly replays an uncertain activation on a fresh client', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([
      { commitError: connectionError(), operation: 'activate' },
      { operation: 'activate' },
      { operation: 'renew' },
      { operation: 'release' },
    ])

    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')

    expect(database.clients[0].selectSql).toBe(database.clients[1].selectSql)
    expect(database.clients[0].selectParams).toBe(database.clients[1].selectParams)
    expect(Object.isFrozen(database.clients[0].selectParams)).toBe(true)
    expect(database.clients[0].release).toHaveBeenCalledWith(true)
    expect(database.clients[1].release).toHaveBeenCalledWith(false)
    await result.fence.release()
  })

  it('keeps an earlier unknown COMMIT sticky when exact replay is rejected', async () => {
    const redis = redisHarness([scriptResult(1, INITIAL_CONTROL_TIME)])
    const database = databaseHarness([
      { commitError: connectionError(), operation: 'activate' },
      { error: connectionError('22023'), operation: 'activate' },
    ])

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    ).rejects.toMatchObject({
      code: 'db_control_outcome_unknown',
      operation: 'activate',
      retryPolicy: 'exact_control_only',
    })

    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(database.clients[0].selectParams).toBe(database.clients[1].selectParams)
    expect(database.clients[0].release).toHaveBeenCalledWith(true)
    expect(database.clients[1].release).toHaveBeenCalledWith(false)
  })

  it('logs the driver code of a failed control RPC, never its message', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness([{ connectError: connectionError() }])

      await expect(
        acquireWorkerDbFenceAuthority({ connect: database.connect, heartbeat: heartbeat(), redis })
      ).rejects.toMatchObject({ code: 'control_plane_unavailable', operation: 'activate' })

      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        '[ingest-worker] DB fence control RPC activate failed: kind=unavailable code=08006 outcome_unknown=false',
      ])
    } finally {
      errors.mockRestore()
    }
  })

  it('classifies a connection failure before BEGIN as known-no-effect', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([{ connectError: connectionError() }])

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    ).rejects.toMatchObject({
      code: 'control_plane_unavailable',
      operation: 'activate',
      retryPolicy: 'reacquire',
    })

    expect(database.connect).toHaveBeenCalledTimes(1)
    expect(database.clients).toHaveLength(0)
    expect(redis.eval).toHaveBeenCalledTimes(2)
  })

  it('treats DB live-owner contention as deterministic and releases Redis', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([{ error: connectionError('55P03'), operation: 'activate' }])

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    ).rejects.toMatchObject({ code: 'fenced', operation: 'activate' })

    expect(database.connect).toHaveBeenCalledTimes(1)
    expect(database.clients[0].query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      expect.stringContaining('activate_ingest_worker_authority'),
      'ROLLBACK',
    ])
    expect(redis.eval).toHaveBeenCalledTimes(2)
  })

  it('does not retry a deterministic DB rejection and returns a sanitized error', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([
      {
        errorFromParams: (params) => connectionError('22023', `secret=${params[4]}`),
        operation: 'activate',
      },
    ])

    let thrown: unknown
    try {
      await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(WorkerDbFenceError)
    expect(thrown).toMatchObject({
      code: 'rpc_contract_violation',
      operation: 'activate',
      retryPolicy: 'never',
    })
    const [, , ...redisArgs] = redis.eval.mock.calls[0] as [string, number, ...string[]]
    const token = redisArgs[6]
    expect(String((thrown as Error).message)).not.toContain('secret=')
    expect(String((thrown as Error).stack)).not.toContain(token)
    expect('cause' in (thrown as object)).toBe(false)
    expect(database.connect).toHaveBeenCalledTimes(1)
    expect(redis.eval).toHaveBeenCalledTimes(2)
  })

  it('retains Redis when activation remains outcome-unknown after exact replay', async () => {
    const redis = redisHarness([scriptResult(1, INITIAL_CONTROL_TIME)])
    const database = databaseHarness([
      { commitError: connectionError(), operation: 'activate' },
      { commitError: connectionError(), operation: 'activate' },
    ])

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    ).rejects.toMatchObject({
      code: 'db_control_outcome_unknown',
      operation: 'activate',
      retryPolicy: 'exact_control_only',
    })
    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(database.clients).toHaveLength(2)
    expect(database.clients.every((client) => client.release.mock.calls[0]?.[0] === true)).toBe(
      true
    )
  })

  it.each([
    ['extra key', (payload: Record<string, unknown>) => (payload.extra = true)],
    ['numeric bigint', (payload: Record<string, unknown>) => (payload.epoch = 41)],
    [
      'non-canonical timestamp',
      (payload: Record<string, unknown>) => (payload.server_time = '2026-07-28T18:00:00Z'),
    ],
    [
      'lease beyond 180 seconds',
      (payload: Record<string, unknown>) => {
        payload.lease_expires_at = new Date(SERVER_TIME_MS + 180_001).toISOString()
      },
    ],
  ])('rejects an active RPC payload with %s', async (_label, mutatePayload) => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([{ mutatePayload, operation: 'activate' }])

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    ).rejects.toMatchObject({ code: 'rpc_contract_violation', operation: 'activate' })
    expect(redis.eval).toHaveBeenCalledTimes(2)
  })

  it('compensates DB first when the immediate two-plane renewal is fenced', async () => {
    const events: string[] = []
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { error: connectionError('55000'), operation: 'renew' },
        { operation: 'release' },
      ],
      events
    )

    await expect(
      acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        redis,
      })
    ).rejects.toMatchObject({ code: 'fenced', operation: 'renew' })
    expect(events).toEqual([
      'redis:acquire',
      'db:activate',
      'redis:renew',
      'db:renew',
      'db:release',
      'redis:release',
    ])
  })

  it('serializes complete Redis-to-DB renewals and advances one composite proof', async () => {
    const events: string[] = []
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 3_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 3_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness([], events)
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')
    events.length = 0

    await Promise.all([
      result.fence.renewAndPublish(heartbeat(43)),
      result.fence.renewAndPublish(heartbeat(44)),
    ])

    expect(events).toEqual(['redis:renew', 'db:renew', 'redis:renew', 'db:renew'])
    expect(result.fence.proof.controlServerTimeMs).toBe(INITIAL_CONTROL_TIME + 3_000)
    expect(database.clients[2].selectParams?.[6]).toBe(String(INITIAL_CONTROL_TIME + 2_000))
    expect(database.clients[3].selectParams?.[6]).toBe(String(INITIAL_CONTROL_TIME + 3_000))
    await result.fence.release()
  })

  it('rejects malformed renewal input without fencing a healthy handle', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([
      { operation: 'activate' },
      { operation: 'renew' },
      { operation: 'release' },
    ])
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')
    const malformedHeartbeat = Object.assign(heartbeat(43), { unexpected: true })

    await expect(result.fence.renewAndPublish(malformedHeartbeat)).rejects.toMatchObject({
      code: 'invalid_input',
      operation: 'renew',
    })
    expect(result.fence.isActive()).toBe(true)
    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(database.clients).toHaveLength(2)
    await result.fence.release()
  })

  it('snapshots a queued heartbeat before caller mutation', async () => {
    const firstRenewCommitBarrier = deferred()
    const firstRenewCommitStarted = deferred()
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 3_000, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 3_000, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([
      { operation: 'activate' },
      { operation: 'renew' },
      {
        commitBarrier: firstRenewCommitBarrier.promise,
        commitStarted: firstRenewCommitStarted.resolve,
        operation: 'renew',
      },
      { operation: 'renew' },
      { operation: 'release' },
    ])
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')

    const firstRenewal = result.fence.renewAndPublish(heartbeat(43))
    await firstRenewCommitStarted.promise
    const queuedHeartbeat = heartbeat(44)
    const secondRenewal = result.fence.renewAndPublish(queuedHeartbeat)
    queuedHeartbeat.disk = 99
    firstRenewCommitBarrier.resolve()
    await Promise.all([firstRenewal, secondRenewal])

    const encodedHeartbeat = redis.eval.mock.calls[3]?.[15]
    expect(typeof encodedHeartbeat).toBe('string')
    expect(JSON.parse(encodedHeartbeat as string)).toMatchObject({ disk: 44 })
    await result.fence.release()
  })

  it('lets one queued release own cleanup when renewal is already in flight', async () => {
    const events: string[] = []
    const renewCommitBarrier = deferred()
    const renewCommitStarted = deferred()
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          commitBarrier: renewCommitBarrier.promise,
          commitStarted: renewCommitStarted.resolve,
          operation: 'renew',
        },
        { operation: 'release' },
      ],
      events
    )
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')
    events.length = 0

    const renewal = result.fence.renewAndPublish(heartbeat(43))
    await renewCommitStarted.promise
    const release = result.fence.release()
    expect(result.fence.state).toBe('releasing')

    renewCommitBarrier.resolve()
    await expect(renewal).rejects.toMatchObject({ code: 'invalid_state', operation: 'renew' })
    await expect(release).resolves.toBeUndefined()

    expect(events).toEqual(['redis:renew', 'db:renew', 'db:release', 'redis:release'])
    expect(
      database.clients.filter((client) =>
        client.selectSql?.includes('release_ingest_worker_authority')
      )
    ).toHaveLength(1)
    expect(result.fence.state).toBe('released')
  })

  it('memoizes release and never deletes Redis before a confirmed DB release', async () => {
    const events: string[] = []
    const releaseCommitBarrier = deferred()
    const releaseCommitStarted = deferred()
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          commitBarrier: releaseCommitBarrier.promise,
          commitStarted: releaseCommitStarted.resolve,
          operation: 'release',
        },
      ],
      events
    )
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')
    events.length = 0

    let reentrant: Promise<void> | undefined
    result.fence.signal.addEventListener(
      'abort',
      () => {
        reentrant = result.fence.release()
      },
      { once: true }
    )
    const first = result.fence.release()
    const second = result.fence.release()
    expect(first).toBe(second)
    expect(reentrant).toBe(first)
    await releaseCommitStarted.promise
    expect(events).toEqual(['db:release'])
    expect(redis.eval).toHaveBeenCalledTimes(2)

    releaseCommitBarrier.resolve()
    await first

    expect(events).toEqual(['db:release', 'redis:release'])
    expect(result.fence.state).toBe('released')
    await expect(result.fence.release()).resolves.toBeUndefined()
    expect(events).toEqual(['db:release', 'redis:release'])
  })

  it('keeps the Redis token when DB release remains outcome-unknown', async () => {
    const events: string[] = []
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        { commitError: connectionError(), operation: 'release' },
        { commitError: connectionError(), operation: 'release' },
      ],
      events
    )
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')
    events.length = 0

    await expect(result.fence.release()).rejects.toMatchObject({
      code: 'db_control_outcome_unknown',
      operation: 'release',
    })
    expect(events).toEqual(['db:release', 'db:release'])
    expect(result.fence.state).toBe('fenced')
  })

  it('retains Redis when DB reports that this release identity was fenced', async () => {
    const events: string[] = []
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          mutatePayload: (payload) => {
            payload.released = false
            payload.status = 'fenced'
          },
          operation: 'release',
        },
      ],
      events
    )
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')
    events.length = 0

    await expect(result.fence.release()).rejects.toMatchObject({
      code: 'fenced',
      operation: 'release',
      retryPolicy: 'reacquire',
    })
    expect(events).toEqual(['db:release'])
    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(result.fence.state).toBe('fenced')
  })

  it('rejects an inconsistent DB release response before touching Redis', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
    ])
    const database = databaseHarness([
      { operation: 'activate' },
      { operation: 'renew' },
      {
        mutatePayload: (payload) => {
          payload.released = false
        },
        operation: 'release',
      },
    ])
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')

    await expect(result.fence.release()).rejects.toMatchObject({
      code: 'rpc_contract_violation',
      operation: 'release',
    })
    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(database.clients[2].query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      expect.stringContaining('release_ingest_worker_authority'),
      'ROLLBACK',
    ])
    expect(result.fence.state).toBe('fenced')
  })

  it('does not report released when the Redis CAS release returns false', async () => {
    const redis = redisHarness([
      scriptResult(1, INITIAL_CONTROL_TIME),
      scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
      scriptResult(0, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
    ])
    const database = databaseHarness([
      { operation: 'activate' },
      { operation: 'renew' },
      { operation: 'release' },
    ])
    const result = await acquireWorkerDbFenceAuthority({
      connect: database.connect,
      heartbeat: heartbeat(),
      redis,
    })
    if (result.status !== 'active') throw new Error('expected active fence')

    await expect(result.fence.release()).rejects.toMatchObject({
      code: 'fenced',
      operation: 'release',
    })
    expect(redis.eval).toHaveBeenCalledTimes(3)
    expect(result.fence.state).toBe('fenced')
  })

  it('keeps the original DB expiry when an equal Redis TIME proof cannot extend it', async () => {
    jest.useFakeTimers()
    try {
      let monotonicNow = 0
      const originalExpiryMs = SERVER_TIME_MS + WORKER_OWNER_LEASE_TTL_MS
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness([
        {
          leaseExpiresAtMs: originalExpiryMs,
          operation: 'activate',
          serverTimeMs: SERVER_TIME_MS,
        },
        {
          leaseExpiresAtMs: originalExpiryMs,
          operation: 'renew',
          serverTimeMs: SERVER_TIME_MS + 20_000,
        },
        { operation: 'release' },
      ])
      const result = await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        monotonicNow: () => monotonicNow,
        redis,
      })
      if (result.status !== 'active') throw new Error('expected active fence')

      expect(result.fence.proof.controlServerTimeMs).toBe(INITIAL_CONTROL_TIME)
      expect(result.fence.proof.databaseLeaseExpiresAt).toBe(
        new Date(originalExpiryMs).toISOString()
      )

      monotonicNow = 129_999
      jest.advanceTimersByTime(129_999)
      expect(result.fence.isActive()).toBe(true)

      monotonicNow = 130_000
      jest.advanceTimersByTime(1)
      expect(result.fence.state).toBe('fenced')
      await result.fence.release()
    } finally {
      jest.useRealTimers()
    }
  })

  it('self-fences at the DB safety margin before the Redis deadline', async () => {
    jest.useFakeTimers()
    try {
      let monotonicNow = 0
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness([
        { operation: 'activate' },
        { leaseRemainingMs: 120_000, operation: 'renew' },
        { operation: 'release' },
      ])
      const result = await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        monotonicNow: () => monotonicNow,
        redis,
      })
      if (result.status !== 'active') throw new Error('expected active fence')

      monotonicNow = 90_000
      jest.advanceTimersByTime(90_000)

      expect(result.fence.state).toBe('fenced')
      expect(result.fence.isActive()).toBe(false)
      expect(result.fence.signal.reason).toMatchObject({
        code: 'lease_deadline_exceeded',
        operation: 'renew',
      })
      await result.fence.release()
      expect(result.fence.state).toBe('released')
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('worker database fenced writes', () => {
  it('gives the business query and the PostgreSQL timeouts the raised cap', async () => {
    process.env[WORKER_DB_FENCE_WRITE_CAP_ENV] = '135000'
    try {
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          {
            businessQueries: [
              {
                result: {
                  command: 'INSERT',
                  rowCount: 1,
                  rows: [{ id: 'saved' }],
                } as QueryResult,
                sql: 'INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id',
              },
            ],
            operation: 'write',
          },
          { operation: 'release' },
        ],
        [],
        true
      )
      const { fence } = await acquireActiveFence(database)
      await expect(
        fence.withFencedWrite(async (transaction) => {
          const result = await transaction.query(
            'INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id',
            ['raised']
          )
          return result.rows[0]?.id
        })
      ).resolves.toBe('saved')

      const writeClient = database.clients[2]
      const [statementTimeout, transactionTimeout] = (
        writeClient.observedQueries[1].valuesAtCall as string[]
      ).map((value) => Number(value.replace(/ms$/, '')))
      const businessTimeout = Number(writeClient.observedQueries[3].queryTimeout)
      for (const timeout of [statementTimeout, transactionTimeout, businessTimeout]) {
        expect(timeout).toBeGreaterThan(WORKER_DB_FENCE_WRITE_QUERY_CAP_MS)
        expect(timeout).toBeLessThanOrEqual(135_000)
      }
      await fence.release()
    } finally {
      delete process.env[WORKER_DB_FENCE_WRITE_CAP_ENV]
    }
  })

  it('runs one frozen extended-protocol facade on the asserted transaction', async () => {
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: [
            {
              result: {
                command: 'INSERT',
                rowCount: 1,
                rows: [{ id: 'saved' }],
              } as QueryResult,
              sql: 'INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id',
            },
          ],
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)
    const callback = jest.fn()
    const values = ['before']
    let facade: unknown

    callback.mockImplementation(async (transaction) => {
      facade = transaction
      const pending = transaction.query(
        '  INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id  ',
        values
      )
      values[0] = 'after'
      const result = await pending
      return result.rows[0]?.id
    })

    await expect(fence.withFencedWrite(callback)).resolves.toBe('saved')

    const writeClient = database.clients[2]
    expect(writeClient.observedQueries.map(({ text }) => text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      expect.stringMatching(
        /set_config\('statement_timeout',[\s\S]+set_config\('transaction_timeout',[\s\S]+set_config\('lock_timeout'/
      ),
      expect.stringContaining('arena.begin_ingest_worker_fenced_write'),
      'INSERT INTO arena.test_rows(value) VALUES ($1) RETURNING id',
      'COMMIT',
    ])
    const timeoutConfiguration = writeClient.observedQueries[1]
    expect(timeoutConfiguration.text).toContain("set_config('lock_timeout', $3::text, true)")
    expect(timeoutConfiguration.text).not.toContain('5000ms')
    expect(timeoutConfiguration.valuesAtCall).toEqual([
      expect.stringMatching(/^[1-9][0-9]*ms$/),
      expect.stringMatching(/^[1-9][0-9]*ms$/),
      `${WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS}ms`,
    ])
    expect(timeoutConfiguration.valuesAtCall?.[0]).toBe(timeoutConfiguration.valuesAtCall?.[1])
    expect(Object.isFrozen(timeoutConfiguration.valuesReference)).toBe(true)
    expect(writeClient.observedQueries.some(({ text }) => /SET\s+CONSTRAINTS/i.test(text))).toBe(
      false
    )
    expect(
      writeClient.observedQueries.every(
        ({ queryMode, queryTimeout }) =>
          queryMode === 'extended' &&
          Number.isInteger(queryTimeout) &&
          Number(queryTimeout) > 0 &&
          Number(queryTimeout) <= WORKER_DB_FENCE_WRITE_QUERY_CAP_MS
      )
    ).toBe(true)
    const businessCall = writeClient.observedQueries[3]
    expect(businessCall.valuesAtCall).toEqual(['before'])
    expect(businessCall.valuesReference).not.toBe(values)
    expect(Object.isFrozen(businessCall.valuesReference)).toBe(true)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(facade)).toBe(true)
    expect(Object.keys(facade as object).sort()).toEqual(['query', 'signal'])
    expect('release' in (facade as object)).toBe(false)
    expect(writeClient.release).toHaveBeenCalledWith(false)

    await fence.release()
    expect(database.remainingBehaviors).toHaveLength(0)
  })

  it('logs the step and the safe cause when a write control failure fences the authority', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          {
            operation: 'write',
            timeoutConfigurationError: connectionError(
              '42501',
              'timeout configuration was denied with private database detail'
            ),
          },
          { operation: 'release' },
        ],
        [],
        true
      )
      const { fence } = await acquireActiveFence(database)

      await expect(fence.withFencedWrite(async () => 'must-not-run')).rejects.toMatchObject({
        code: 'control_plane_unavailable',
      })

      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        '[ingest-worker] DB fence lost on write at timeouts (control_plane_unavailable) cause: Error code=42501',
      ])
    } finally {
      errors.mockRestore()
    }
  })

  it('logs which plane failed when a renewal fences the authority', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const database = databaseHarness(
        [{ operation: 'activate' }, { operation: 'renew' }, { operation: 'release' }],
        [],
        true
      )
      const { fence } = await acquireActiveFence(database)
      // The Redis harness has no further scripted reply: the next renewal's
      // control-plane call rejects.
      await expect(fence.renewAndPublish(heartbeat(43))).rejects.toMatchObject({
        operation: 'renew',
      })

      const lines = errors.mock.calls.map(([line]) => String(line))
      expect(lines.filter((line) => line.includes('DB fence lost'))).toEqual([
        expect.stringMatching(
          /^\[ingest-worker\] DB fence lost on renew at redis \([a-z_]+\) cause: [A-Za-z]+/
        ),
      ])
      expect(fence.state).not.toBe('active')
    } finally {
      errors.mockRestore()
    }
  })

  it('rolls back and self-fences before authority assertion when timeout configuration fails', async () => {
    const callback = jest.fn(async () => 'must-not-run')
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          operation: 'write',
          timeoutConfigurationError: connectionError(
            '42501',
            'timeout configuration was denied with private database detail'
          ),
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(fence.withFencedWrite(callback)).rejects.toMatchObject({
      code: 'control_plane_unavailable',
      operation: 'write',
      retryPolicy: 'reacquire',
    })

    const writeClient = database.clients[2]
    expect(callback).not.toHaveBeenCalled()
    expect(writeClient.observedQueries.map(({ text }) => text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      expect.stringContaining("pg_catalog.set_config('lock_timeout'"),
      'ROLLBACK',
    ])
    expect(
      writeClient.observedQueries.some(({ text }) =>
        text.includes('arena.begin_ingest_worker_fenced_write')
      )
    ).toBe(false)
    expect(writeClient.release).toHaveBeenCalledWith(false)
    expect(fence.state).toBe('fenced')
    expect(fence.signal.reason).toMatchObject({
      code: 'control_plane_unavailable',
      operation: 'write',
      retryPolicy: 'reacquire',
    })

    await fence.release()
    expect(database.remainingBehaviors).toHaveLength(0)
  })

  it('rejects an unverified lock-timeout result and fails closed before invoking the callback', async () => {
    const callback = jest.fn(async () => 'must-not-run')
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          mutateTimeoutConfiguration: (payload) => {
            payload.worker_db_fence_lock_timeout = '1ms'
          },
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(fence.withFencedWrite(callback)).rejects.toMatchObject({
      code: 'rpc_contract_violation',
      operation: 'write',
      retryPolicy: 'never',
    })

    expect(callback).not.toHaveBeenCalled()
    expect(database.clients[2].observedQueries.at(-1)?.text).toBe('ROLLBACK')
    expect(database.clients[2].release).toHaveBeenCalledWith(false)
    expect(fence.state).toBe('fenced')

    await fence.release()
    expect(database.remainingBehaviors).toHaveLength(0)
  })

  it('allows the complete bounded statement prefix set', async () => {
    const statements = [
      'SELECT $1',
      'WITH selected AS (SELECT $1 AS value) SELECT value FROM selected',
      'VALUES ($1)',
      'INSERT INTO arena.test_rows(value) VALUES ($1)',
      'UPDATE arena.test_rows SET value = $1 WHERE id = $2',
      'DELETE FROM arena.test_rows WHERE id = $1',
      'MERGE INTO arena.test_rows AS target USING arena.test_updates AS source ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES',
    ]
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: statements.map((sql) => ({ sql })),
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(
      fence.withFencedWrite(async (transaction) => {
        for (const statement of statements) await transaction.query(statement, ['value', 'id'])
        return statements.length
      })
    ).resolves.toBe(statements.length)

    expect(database.clients[2].businessQueries).toHaveLength(0)
    await fence.release()
  })

  it('allows a data-modifying CTE whose nested SELECT precedes a later INSERT INTO', async () => {
    const statement = `WITH selected AS (
      SELECT id FROM arena.source_rows WHERE ready = true
    ), inserted AS (
      INSERT INTO arena.audit_rows(id)
      SELECT id FROM selected
      RETURNING id
    )
    DELETE FROM arena.source_rows
    WHERE id IN (SELECT id FROM inserted)`
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: [{ sql: statement }],
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(
      fence.withFencedWrite(async (transaction) => {
        await transaction.query(statement)
        return 'cte-committed'
      })
    ).resolves.toBe('cte-committed')
    expect(database.clients[2].observedQueries.at(-1)?.text).toBe('COMMIT')
    expect(database.clients[2].businessQueries).toHaveLength(0)

    await fence.release()
  })

  it.each([
    ['transaction begin', 'BEGIN'],
    ['transaction commit', 'COMMIT'],
    ['transaction rollback', 'ROLLBACK'],
    ['session control', "SET LOCAL lock_timeout = '0'"],
    ['multiple statements', 'SELECT 1; SELECT 2'],
    ['DDL', 'CREATE TABLE arena.forbidden(id bigint)'],
    [
      'fence RPC',
      "SELECT arena.begin_ingest_worker_fenced_write('region:local', 'local', 'node', '00000000-0000-4000-8000-000000000000', repeat('a', 64), 1, 1)",
    ],
    ['timeout bypass', "SELECT pg_catalog.set_config('statement_timeout', '0', true)"],
    ['lock-timeout bypass', "SELECT pg_catalog.set_config('lock_timeout', '0', true)"],
    ['fence substrate read', 'SELECT * FROM arena.ingest_worker_authorities'],
    ['quoted fence identifier', 'SELECT * FROM arena."ingest_worker_authorities"'],
    [
      'line-commented fence SQL',
      'SELECT 1 -- arena.activate_ingest_worker_authority is hidden here',
    ],
    [
      'block-commented fence SQL',
      'SELECT 1 /* arena.release_ingest_worker_authority is hidden here */',
    ],
    ['dollar-quoted fence SQL', 'SELECT $$arena.ingest_worker_write_guards$$'],
    ['single-quoted fence SQL', "SELECT 'arena.ingest_worker_authorities'"],
    ['SELECT INTO table creation', 'SELECT value INTO temp_table FROM arena.source_rows'],
  ])('rejects %s even when the callback catches the query rejection', async (_label, sql) => {
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        { operation: 'write' },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    const write = fence.withFencedWrite(async (transaction) => {
      await expect(transaction.query(sql)).rejects.toMatchObject({
        code: 'invalid_input',
        operation: 'write',
      })
      return 'caught'
    })

    await expect(write).rejects.toMatchObject({ code: 'invalid_input', operation: 'write' })
    expect(database.clients[2].observedQueries.map(({ text }) => text)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      expect.stringContaining("pg_catalog.set_config('statement_timeout'"),
      expect.stringContaining('arena.begin_ingest_worker_fenced_write'),
      'ROLLBACK',
    ])
    await fence.release()
  })

  it.each([
    ['an extra key', (payload: Record<string, unknown>) => (payload.extra = true)],
    ['the wrong status', (payload: Record<string, unknown>) => (payload.status = 'active')],
    ['a numeric xid8', (payload: Record<string, unknown>) => (payload.transaction_id = 9001)],
    ['a zero xid8', (payload: Record<string, unknown>) => (payload.transaction_id = '0')],
    [
      'a non-canonical xid8',
      (payload: Record<string, unknown>) => (payload.transaction_id = '09001'),
    ],
    ['the wrong epoch', (payload: Record<string, unknown>) => (payload.epoch = '42')],
    [
      'a control time before acquisition',
      (payload: Record<string, unknown>) =>
        (payload.control_server_time_ms = String(INITIAL_CONTROL_TIME - 1)),
    ],
    [
      'a control time from the future',
      (payload: Record<string, unknown>) =>
        (payload.control_server_time_ms = String(INITIAL_CONTROL_TIME + 1_001)),
    ],
    [
      'an expired lease',
      (payload: Record<string, unknown>) => (payload.lease_expires_at = payload.server_time),
    ],
  ])(
    'rejects an asserted-write payload with %s before invoking the callback',
    async (_label, mutatePayload) => {
      const callback = jest.fn(async () => 'should-not-run')
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          { mutatePayload, operation: 'write' },
          { operation: 'release' },
        ],
        [],
        true
      )
      const { fence } = await acquireActiveFence(database)

      await expect(fence.withFencedWrite(callback)).rejects.toMatchObject({
        code: 'rpc_contract_violation',
        operation: 'write',
        retryPolicy: 'never',
      })
      expect(callback).not.toHaveBeenCalled()
      expect(database.clients[2].observedQueries.at(-1)?.text).toBe('ROLLBACK')
      await fence.release()
    }
  )

  it('sanitizes a rejected begin-write RPC containing the private token', async () => {
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          errorFromParams: (params) => connectionError('22023', `secret=${params[4]}`),
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence, redis } = await acquireActiveFence(database)
    let thrown: unknown

    try {
      await fence.withFencedWrite(async () => 'never')
    } catch (error) {
      thrown = error
    }

    const [, , ...redisArgs] = redis.eval.mock.calls[0] as [string, number, ...string[]]
    const token = redisArgs[6]
    expect(thrown).toMatchObject({ code: 'rpc_contract_violation', operation: 'write' })
    expect(String((thrown as Error).message)).not.toContain(token)
    expect(String((thrown as Error).stack)).not.toContain(token)
    expect('cause' in (thrown as object)).toBe(false)
    await fence.release()
  })

  it('drains an unawaited successful query before COMMIT', async () => {
    const queryBarrier = deferred()
    const queryStarted = deferred()
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: [
            {
              barrier: queryBarrier.promise,
              sql: 'INSERT INTO arena.test_rows(value) VALUES ($1)',
              started: queryStarted.resolve,
            },
          ],
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)
    let settled = false

    const write = fence.withFencedWrite(async (transaction) => {
      void transaction.query('INSERT INTO arena.test_rows(value) VALUES ($1)', ['value'])
      return 'callback-finished'
    })
    void write.then(() => {
      settled = true
    })
    await queryStarted.promise
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(database.clients[2].observedQueries.some(({ text }) => text === 'COMMIT')).toBe(false)

    queryBarrier.resolve()
    await expect(write).resolves.toBe('callback-finished')
    expect(database.clients[2].observedQueries.at(-1)?.text).toBe('COMMIT')
    await fence.release()
  })

  it('deeply snapshots queued object, Date, Buffer, and array parameters', async () => {
    const queryBarrier = deferred()
    const queryStarted = deferred()
    const originalDateMs = Date.parse('2026-07-28T12:34:56.789Z')
    const objectValue = {
      items: [1, { enabled: true }],
      nested: { label: 'before' },
    }
    const dateValue = new Date(originalDateMs)
    const bufferValue = Buffer.from([1, 2, 3, 4])
    const arrayValue: Array<unknown> = ['before', { score: 7 }]
    const values: unknown[] = [objectValue, dateValue, bufferValue, arrayValue]
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: [
            {
              barrier: queryBarrier.promise,
              sql: 'INSERT INTO arena.test_rows(payload, captured_at, digest, tags) VALUES ($1, $2, $3, $4)',
              started: queryStarted.resolve,
            },
          ],
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    const write = fence.withFencedWrite(async (transaction) => {
      const pending = transaction.query(
        'INSERT INTO arena.test_rows(payload, captured_at, digest, tags) VALUES ($1, $2, $3, $4)',
        values
      )
      objectValue.nested.label = 'after'
      objectValue.items[1] = { enabled: false }
      objectValue.items.push(2)
      dateValue.setTime(originalDateMs + 86_400_000)
      bufferValue.fill(9)
      arrayValue[0] = 'after'
      arrayValue[1] = { score: 99 }
      arrayValue.push('late')
      await pending
      return 'snapshotted'
    })
    await queryStarted.promise

    const observedValues = database.clients[2].observedQueries[3].valuesReference
    if (observedValues === undefined) throw new Error('business query values were not observed')
    const observedObject = observedValues[0] as {
      items: Array<unknown>
      nested: { label: string }
    }
    const observedDate = observedValues[1] as Date
    const observedBuffer = observedValues[2] as Buffer
    const observedArray = observedValues[3] as Array<unknown>

    expect(observedValues).not.toBe(values)
    expect(Object.isFrozen(observedValues)).toBe(true)
    expect(observedObject).not.toBe(objectValue)
    expect(observedObject.nested).not.toBe(objectValue.nested)
    expect(observedObject).toMatchObject({
      items: [1, { enabled: true }],
      nested: { label: 'before' },
    })
    expect(Object.isFrozen(observedObject)).toBe(true)
    expect(Object.isFrozen(observedObject.items)).toBe(true)
    expect(Object.isFrozen(observedObject.nested)).toBe(true)
    expect(observedDate).not.toBe(dateValue)
    expect(observedDate.getTime()).toBe(originalDateMs)
    expect(observedBuffer).not.toBe(bufferValue)
    expect([...observedBuffer]).toEqual([1, 2, 3, 4])
    expect(observedArray).not.toBe(arrayValue)
    expect(observedArray).toEqual(['before', { score: 7 }])
    expect(Object.isFrozen(observedArray)).toBe(true)
    expect(Object.isFrozen(observedArray[1])).toBe(true)

    queryBarrier.resolve()
    await expect(write).resolves.toBe('snapshotted')
    await fence.release()
  })

  it('normalizes a blocked unawaited query failure when release aborts the write', async () => {
    const events: string[] = []
    const queryBarrier = deferred()
    const queryStarted = deferred()
    const rawConnectionError = connectionError(
      'ECONNRESET',
      'raw PostgreSQL socket failure with private transport detail'
    )
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: [
            {
              barrier: queryBarrier.promise,
              error: rawConnectionError,
              sql: 'INSERT INTO arena.test_rows(value) VALUES ($1)',
              started: queryStarted.resolve,
            },
          ],
          operation: 'write',
        },
        { operation: 'release' },
      ],
      events,
      true
    )
    const { fence } = await acquireActiveFence(database, redis)
    events.length = 0

    const write = fence.withFencedWrite(async (transaction) => {
      void transaction.query('INSERT INTO arena.test_rows(value) VALUES ($1)', ['value'])
      return 'callback-returned'
    })
    await queryStarted.promise
    const release = fence.release()
    await Promise.resolve()

    expect(events).toEqual(['db:write', 'db:business'])
    expect(database.connect).toHaveBeenCalledTimes(3)

    queryBarrier.resolve()
    const [writeOutcome, releaseOutcome] = await Promise.allSettled([write, release])

    expect(writeOutcome).toMatchObject({
      reason: { code: 'invalid_state', operation: 'write', retryPolicy: 'never' },
      status: 'rejected',
    })
    expect(writeOutcome.status).toBe('rejected')
    if (writeOutcome.status !== 'rejected') throw new Error('expected write rejection')
    expect(writeOutcome.reason).toBeInstanceOf(WorkerDbFenceError)
    expect(String((writeOutcome.reason as Error).message)).not.toContain(rawConnectionError.message)
    expect(String((writeOutcome.reason as Error).stack)).not.toContain(rawConnectionError.message)
    expect(releaseOutcome).toEqual({ status: 'fulfilled', value: undefined })
    expect(database.clients[2].release).toHaveBeenCalledWith(true)
    expect(events).toEqual(['db:write', 'db:business', 'db:release', 'redis:release'])
    expect(fence.state).toBe('released')
  })

  it('limits one transaction to 120 seconds without fencing subsequent renewals or writes', async () => {
    jest.useFakeTimers()
    try {
      let monotonicNow = 0
      const callbackBarrier = deferred()
      const callbackEntered = deferred()
      const callbackFinished = deferred()
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          { operation: 'write' },
          { operation: 'renew' },
          { operation: 'write' },
          { operation: 'release' },
        ],
        [],
        true
      )
      const acquired = await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        monotonicNow: () => monotonicNow,
        redis,
      })
      if (acquired.status !== 'active') throw new Error('expected active fence')
      const fence = acquired.fence
      let writeSettled = false

      const expiredWrite = fence.withFencedWrite(async () => {
        callbackEntered.resolve()
        try {
          await callbackBarrier.promise
          return 'late-result'
        } finally {
          callbackFinished.resolve()
        }
      })
      void expiredWrite.then(
        () => {
          writeSettled = true
        },
        () => {
          writeSettled = true
        }
      )
      await callbackEntered.promise

      monotonicNow = WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS - 1
      jest.advanceTimersByTime(WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS - 1)
      await Promise.resolve()
      expect(writeSettled).toBe(false)
      expect(database.clients[2].release).not.toHaveBeenCalled()
      expect(fence.state).toBe('active')

      monotonicNow = WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS
      jest.advanceTimersByTime(1)
      await expect(expiredWrite).rejects.toMatchObject({
        code: 'write_deadline_exceeded',
        operation: 'write',
        retryPolicy: 'never',
      })
      expect(database.clients[2].release).toHaveBeenCalledWith(true)
      expect(fence.state).toBe('active')
      expect(fence.signal.aborted).toBe(false)

      callbackBarrier.resolve()
      await callbackFinished.promise

      await expect(fence.renewAndPublish(heartbeat(43))).resolves.toBeUndefined()
      expect(fence.state).toBe('active')
      await expect(fence.withFencedWrite(async () => 'second-write')).resolves.toBe('second-write')
      expect(database.clients[4].release).toHaveBeenCalledWith(false)
      expect(fence.state).toBe('active')

      await fence.release()
      expect(fence.state).toBe('released')
      expect(database.remainingBehaviors).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('raises the transaction cap to INGEST_DB_FENCE_WRITE_CAP_MS when it is set', async () => {
    process.env[WORKER_DB_FENCE_WRITE_CAP_ENV] = '135000'
    jest.useFakeTimers()
    try {
      let monotonicNow = 0
      const callbackBarrier = deferred()
      const callbackEntered = deferred()
      const callbackFinished = deferred()
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          { operation: 'write' },
          { operation: 'renew' },
          { operation: 'write' },
          { operation: 'release' },
        ],
        [],
        true
      )
      const acquired = await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        monotonicNow: () => monotonicNow,
        redis,
      })
      if (acquired.status !== 'active') throw new Error('expected active fence')
      const fence = acquired.fence
      let writeSettled = false

      const expiredWrite = fence.withFencedWrite(async () => {
        callbackEntered.resolve()
        try {
          await callbackBarrier.promise
          return 'late-result'
        } finally {
          callbackFinished.resolve()
        }
      })
      void expiredWrite.then(
        () => {
          writeSettled = true
        },
        () => {
          writeSettled = true
        }
      )
      await callbackEntered.promise

      monotonicNow = 135_000 - 1
      jest.advanceTimersByTime(135_000 - 1)
      await Promise.resolve()
      expect(writeSettled).toBe(false)
      expect(database.clients[2].release).not.toHaveBeenCalled()
      expect(fence.state).toBe('active')

      monotonicNow = 135_000
      jest.advanceTimersByTime(1)
      await expect(expiredWrite).rejects.toMatchObject({
        code: 'write_deadline_exceeded',
        operation: 'write',
        retryPolicy: 'never',
      })
      expect(database.clients[2].release).toHaveBeenCalledWith(true)
      expect(fence.state).toBe('active')
      expect(fence.signal.aborted).toBe(false)

      callbackBarrier.resolve()
      await callbackFinished.promise

      await expect(fence.renewAndPublish(heartbeat(43))).resolves.toBeUndefined()
      expect(fence.state).toBe('active')
      await expect(fence.withFencedWrite(async () => 'second-write')).resolves.toBe('second-write')
      expect(database.clients[4].release).toHaveBeenCalledWith(false)
      expect(fence.state).toBe('active')

      await fence.release()
      expect(fence.state).toBe('released')
      expect(database.remainingBehaviors).toHaveLength(0)
    } finally {
      delete process.env[WORKER_DB_FENCE_WRITE_CAP_ENV]
      jest.useRealTimers()
    }
  })

  describe('resolveWorkerDbFenceWriteCapMs', () => {
    it('keeps 120 s when unset or empty', () => {
      expect(resolveWorkerDbFenceWriteCapMs({})).toBe(WORKER_DB_FENCE_WRITE_TRANSACTION_CAP_MS)
      expect(resolveWorkerDbFenceWriteCapMs({ [WORKER_DB_FENCE_WRITE_CAP_ENV]: '' })).toBe(120_000)
    })

    it('accepts a raise up to the lease bound (140 s)', () => {
      expect(WORKER_DB_FENCE_WRITE_CAP_MAX_MS).toBe(140_000)
      expect(resolveWorkerDbFenceWriteCapMs({ [WORKER_DB_FENCE_WRITE_CAP_ENV]: '135000' })).toBe(
        135_000
      )
      expect(resolveWorkerDbFenceWriteCapMs({ [WORKER_DB_FENCE_WRITE_CAP_ENV]: '140000' })).toBe(
        140_000
      )
    })

    it.each(['119999', '140001', '0', '-1', '135000.5', '1e5', ' 135000', '135000ms', 'abc'])(
      'refuses %p',
      (value) => {
        expect(() =>
          resolveWorkerDbFenceWriteCapMs({ [WORKER_DB_FENCE_WRITE_CAP_ENV]: value })
        ).toThrow('INGEST_DB_FENCE_WRITE_CAP_MS must be an integer from 120000 to 140000')
      }
    )

    it('refuses a malformed value before taking any ownership, and logs why', async () => {
      process.env[WORKER_DB_FENCE_WRITE_CAP_ENV] = '200000'
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        const redis = redisHarness([])
        const database = databaseHarness([], [], true)
        await expect(
          acquireWorkerDbFenceAuthority({
            connect: database.connect,
            heartbeat: heartbeat(),
            redis,
          })
        ).rejects.toThrow('INGEST_DB_FENCE_WRITE_CAP_MS')
        expect(database.connect).not.toHaveBeenCalled()
        expect(errors).toHaveBeenCalledWith(
          '[worker-db-fence] INGEST_DB_FENCE_WRITE_CAP_MS must be an integer from 120000 to 140000'
        )
      } finally {
        errors.mockRestore()
        delete process.env[WORKER_DB_FENCE_WRITE_CAP_ENV]
      }
    })
  })

  it('keeps an active write on its starting DB deadline after a concurrent renewal', async () => {
    jest.useFakeTimers()
    try {
      let monotonicNow = 0
      const callbackBarrier = deferred()
      const callbackEntered = deferred()
      const callbackFinished = deferred()
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 2_000, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { leaseRemainingMs: 120_000, operation: 'renew' },
          { operation: 'write' },
          { operation: 'renew' },
          { operation: 'write' },
          { operation: 'release' },
        ],
        [],
        true
      )
      const acquired = await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        monotonicNow: () => monotonicNow,
        redis,
      })
      if (acquired.status !== 'active') throw new Error('expected active fence')
      const fence = acquired.fence

      const oldWrite = fence.withFencedWrite(async () => {
        callbackEntered.resolve()
        try {
          await callbackBarrier.promise
          return 'late-old-result'
        } finally {
          callbackFinished.resolve()
        }
      })
      await callbackEntered.promise
      const oldTimeoutConfiguration = database.clients[2].observedQueries[1]
      expect(oldTimeoutConfiguration.valuesAtCall).toEqual([
        '80000ms',
        '80000ms',
        `${WORKER_DB_FENCE_WRITE_LOCK_TIMEOUT_MS}ms`,
      ])

      monotonicNow = 40_000
      jest.advanceTimersByTime(40_000)
      await expect(fence.renewAndPublish(heartbeat(43))).resolves.toBeUndefined()
      expect(fence.state).toBe('active')
      expect(database.clients[3].selectSql).toContain('renew_ingest_worker_authority')

      monotonicNow = 79_999
      jest.advanceTimersByTime(39_999)
      await Promise.resolve()
      expect(database.clients[2].release).not.toHaveBeenCalled()
      expect(fence.state).toBe('active')

      monotonicNow = 80_000
      jest.advanceTimersByTime(1)
      await expect(oldWrite).rejects.toMatchObject({
        code: 'write_deadline_exceeded',
        operation: 'write',
        retryPolicy: 'never',
      })
      expect(database.clients[2].release).toHaveBeenCalledWith(true)
      expect(fence.state).toBe('active')
      expect(fence.signal.aborted).toBe(false)

      callbackBarrier.resolve()
      await callbackFinished.promise

      await expect(fence.withFencedWrite(async () => 'new-write-result')).resolves.toBe(
        'new-write-result'
      )
      expect(database.clients[4].release).toHaveBeenCalledWith(false)
      expect(fence.state).toBe('active')

      await fence.release()
      expect(fence.state).toBe('released')
      expect(database.remainingBehaviors).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('aborts a write at the DB finalize margin before the global safety watchdog fences', async () => {
    jest.useFakeTimers()
    try {
      let monotonicNow = 0
      const callbackBarrier = deferred()
      const callbackEntered = deferred()
      const callbackFinished = deferred()
      const redis = redisHarness([
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
      ])
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { leaseRemainingMs: 120_000, operation: 'renew' },
          { operation: 'write' },
          { operation: 'release' },
        ],
        [],
        true
      )
      const acquired = await acquireWorkerDbFenceAuthority({
        connect: database.connect,
        heartbeat: heartbeat(),
        monotonicNow: () => monotonicNow,
        redis,
      })
      if (acquired.status !== 'active') throw new Error('expected active fence')
      const fence = acquired.fence

      const expiringWrite = fence.withFencedWrite(async () => {
        callbackEntered.resolve()
        try {
          await callbackBarrier.promise
          return 'late-result'
        } finally {
          callbackFinished.resolve()
        }
      })
      await callbackEntered.promise

      monotonicNow = 79_999
      jest.advanceTimersByTime(79_999)
      await Promise.resolve()
      expect(database.clients[2].release).not.toHaveBeenCalled()
      expect(fence.state).toBe('active')
      expect(fence.signal.aborted).toBe(false)

      monotonicNow = 80_000
      jest.advanceTimersByTime(1)
      await expect(expiringWrite).rejects.toMatchObject({
        code: 'write_deadline_exceeded',
        operation: 'write',
        retryPolicy: 'never',
      })
      expect(database.clients[2].release).toHaveBeenCalledWith(true)
      expect(fence.state).toBe('active')
      expect(fence.signal.aborted).toBe(false)

      callbackBarrier.resolve()
      await callbackFinished.promise

      monotonicNow = 89_999
      jest.advanceTimersByTime(9_999)
      expect(fence.state).toBe('active')
      expect(fence.signal.aborted).toBe(false)

      monotonicNow = 90_000
      jest.advanceTimersByTime(1)
      expect(fence.state).toBe('fenced')
      expect(fence.signal.reason).toMatchObject({
        code: 'lease_deadline_exceeded',
        operation: 'renew',
        retryPolicy: 'reacquire',
      })

      await fence.release()
      expect(fence.state).toBe('released')
      expect(database.remainingBehaviors).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rolls back when the callback catches a business-query rejection', async () => {
    const queryError = connectionError('23505', 'duplicate business row')
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        {
          businessQueries: [
            {
              error: queryError,
              sql: 'INSERT INTO arena.test_rows(value) VALUES ($1)',
            },
          ],
          operation: 'write',
        },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    const write = fence.withFencedWrite(async (transaction) => {
      try {
        await transaction.query('INSERT INTO arena.test_rows(value) VALUES ($1)', ['value'])
      } catch (error) {
        expect(error).toBe(queryError)
      }
      return 'caught'
    })

    await expect(write).rejects.toBe(queryError)
    expect(database.clients[2].observedQueries.at(-1)?.text).toBe('ROLLBACK')
    expect(database.clients[2].release).toHaveBeenCalledWith(false)
    await fence.release()
  })

  it('breaks a callback-to-release cycle and releases DB before Redis', async () => {
    const events: string[] = []
    const callbackEntered = deferred()
    const redis = redisHarness(
      [
        scriptResult(1, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME),
        scriptResult(1, INITIAL_CONTROL_TIME + 1_000, INITIAL_CONTROL_TIME, 0),
      ],
      events
    )
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        { operation: 'write' },
        { operation: 'release' },
      ],
      events,
      true
    )
    const { fence } = await acquireActiveFence(database, redis)
    events.length = 0
    let nestedRelease: Promise<void> | undefined

    const write = fence.withFencedWrite(async () => {
      nestedRelease = fence.release()
      callbackEntered.resolve()
      await nestedRelease
      return 'unreachable-write-result'
    })
    await callbackEntered.promise
    if (nestedRelease === undefined) throw new Error('callback did not start release')

    const [writeOutcome, releaseOutcome] = await Promise.allSettled([write, nestedRelease])

    expect(writeOutcome).toMatchObject({
      reason: { code: 'invalid_state', operation: 'write' },
      status: 'rejected',
    })
    expect(releaseOutcome).toEqual({ status: 'fulfilled', value: undefined })
    expect(database.clients[2].release).toHaveBeenCalledWith(true)
    expect(events).toEqual(['db:write', 'db:release', 'redis:release'])
    expect(fence.state).toBe('released')
  })

  it.each([
    ['a deferred fence rejection', '55000', 'fenced', 'fenced'],
    ['another PostgreSQL rejection', '23505', 'commit_aborted', 'active'],
  ])(
    'does not query xid status after COMMIT returns %s',
    async (_label, code, expectedCode, expectedState) => {
      const callback = jest.fn(async () => 'saved-result')
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          { commitError: connectionError(code), operation: 'write' },
          { operation: 'release' },
        ],
        [],
        true
      )
      const { fence } = await acquireActiveFence(database)

      await expect(fence.withFencedWrite(callback)).rejects.toMatchObject({
        code: expectedCode,
        operation: 'write',
      })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(database.connect).toHaveBeenCalledTimes(3)
      expect(database.clients).toHaveLength(3)
      expect(fence.state).toBe(expectedState)

      await fence.release()
    }
  )

  it('returns the saved result when a fresh xid lookup proves an uncertain COMMIT', async () => {
    const callback = jest.fn(async () => Object.freeze({ id: 'saved-once' }))
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        { commitError: connectionError('08006'), operation: 'write', transactionId: '9001' },
        { operation: 'status', xactStatus: 'committed' },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(fence.withFencedWrite(callback)).resolves.toEqual({ id: 'saved-once' })

    const writeClient = database.clients[2]
    const statusClient = database.clients[3]
    expect(callback).toHaveBeenCalledTimes(1)
    expect(writeClient.release).toHaveBeenCalledWith(true)
    expect(statusClient.release).toHaveBeenCalledWith(false)
    expect(statusClient.observedQueries).toHaveLength(1)
    expect(statusClient.observedQueries[0]).toMatchObject({
      queryMode: 'extended',
      valuesAtCall: ['9001'],
    })
    expect(Number(statusClient.observedQueries[0].queryTimeout)).toBeGreaterThan(0)
    expect(Number(statusClient.observedQueries[0].queryTimeout)).toBeLessThanOrEqual(5_000)
    expect(statusClient.observedQueries[0].text).toContain(
      'pg_catalog.pg_xact_status($1::pg_catalog.xid8)'
    )
    expect(Object.isFrozen(statusClient.observedQueries[0].valuesReference)).toBe(true)
    await fence.release()
  })

  it.each([
    ['aborted', 'commit_aborted', 'active'],
    [null, 'commit_outcome_unknown', 'fenced'],
  ])(
    'maps an uncertain COMMIT with xid status %s without replaying the callback',
    async (xactStatus, expectedCode, expectedState) => {
      const callback = jest.fn(async () => 'saved-result')
      const database = databaseHarness(
        [
          { operation: 'activate' },
          { operation: 'renew' },
          { commitError: connectionError('08006'), operation: 'write' },
          { operation: 'status', xactStatus },
          { operation: 'release' },
        ],
        [],
        true
      )
      const { fence } = await acquireActiveFence(database)

      await expect(fence.withFencedWrite(callback)).rejects.toMatchObject({
        code: expectedCode,
        operation: 'write',
      })
      expect(callback).toHaveBeenCalledTimes(1)
      expect(database.clients[3].observedQueries[0].valuesAtCall).toEqual(['9001'])
      expect(fence.state).toBe(expectedState)
      await fence.release()
    }
  )

  it('polls an in-progress xid once more on a fresh client', async () => {
    const callback = jest.fn(async () => 'saved-result')
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        { commitError: connectionError('08006'), operation: 'write' },
        { operation: 'status', xactStatus: 'in progress' },
        { operation: 'status', xactStatus: 'committed' },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(fence.withFencedWrite(callback)).resolves.toBe('saved-result')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(database.clients[3].observedQueries[0].valuesAtCall).toEqual(['9001'])
    expect(database.clients[4].observedQueries[0].valuesAtCall).toEqual(['9001'])
    expect(database.clients[3].release).toHaveBeenCalledWith(false)
    expect(database.clients[4].release).toHaveBeenCalledWith(false)
    await fence.release()
  })

  it('reconciles a malformed COMMIT response instead of replaying the callback', async () => {
    const callback = jest.fn(async () => 'saved-result')
    const database = databaseHarness(
      [
        { operation: 'activate' },
        { operation: 'renew' },
        { commitCommand: 'UPDATE', operation: 'write' },
        { operation: 'status', xactStatus: 'committed' },
        { operation: 'release' },
      ],
      [],
      true
    )
    const { fence } = await acquireActiveFence(database)

    await expect(fence.withFencedWrite(callback)).resolves.toBe('saved-result')
    expect(callback).toHaveBeenCalledTimes(1)
    expect(database.clients[2].release).toHaveBeenCalledWith(true)
    expect(database.clients[3].observedQueries[0].valuesAtCall).toEqual(['9001'])
    await fence.release()
  })
})
