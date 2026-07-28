import type { PoolClient, QueryResult } from 'pg'

import {
  acquireWorkerDbFenceAuthority,
  WORKER_DB_FENCE_CONTRACT,
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

type DatabaseOperation = 'activate' | 'release' | 'renew'
type TransactionPhase = 'begun' | 'finished' | 'new' | 'selected'

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
  commitBarrier?: Promise<void>
  commitError?: Error
  commitStarted?: () => void
  connectError?: Error
  databaseEpoch?: string | number
  error?: Error
  errorFromParams?: (params: string[]) => Error
  leaseExpiresAtMs?: number
  leaseRemainingMs?: number
  mutatePayload?: (payload: Record<string, unknown>) => void
  operation?: DatabaseOperation
  rowCount?: number | null
  serverTimeMs?: number
}

interface ClientRecord {
  behavior: DatabaseBehavior
  query: jest.Mock
  release: jest.Mock
  phase: TransactionPhase
  selectParams?: string[]
  selectSql?: string
}

function databaseOperation(sql: string): DatabaseOperation {
  if (sql.includes('activate_ingest_worker_authority')) return 'activate'
  if (sql.includes('renew_ingest_worker_authority')) return 'renew'
  if (sql.includes('release_ingest_worker_authority')) return 'release'
  throw new Error(`unexpected database fence SQL: ${sql}`)
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

function databaseHarness(behaviors: DatabaseBehavior[] = [], events: string[] = []) {
  const clients: ClientRecord[] = []
  let tick = 0
  const connect = jest.fn(async () => {
    const behavior = behaviors.shift() ?? {}
    if (behavior.connectError) throw behavior.connectError
    const release = jest.fn()
    const record: ClientRecord = { behavior, phase: 'new', query: jest.fn(), release }
    record.query.mockImplementation(async (sql: string, params?: string[]) => {
      if (sql.startsWith('BEGIN')) {
        if (record.phase !== 'new') throw new Error('transaction began more than once')
        record.phase = 'begun'
        return { rowCount: null, rows: [] }
      }
      if (sql === 'ROLLBACK') {
        if (record.phase !== 'begun' && record.phase !== 'selected') {
          throw new Error('transaction rolled back outside an active transaction')
        }
        record.phase = 'finished'
        return { rowCount: null, rows: [] }
      }
      if (sql === 'COMMIT') {
        if (record.phase !== 'selected') throw new Error('transaction committed before its RPC')
        behavior.commitStarted?.()
        if (behavior.commitBarrier) await behavior.commitBarrier
        record.phase = 'finished'
        if (behavior.commitError) throw behavior.commitError
        return { rowCount: null, rows: [] }
      }

      if (record.phase !== 'begun') throw new Error('RPC executed outside its transaction')
      const operation = databaseOperation(sql)
      if (behavior.operation !== undefined && behavior.operation !== operation) {
        throw new Error(`expected ${behavior.operation}, received ${operation}`)
      }
      events.push(`db:${operation}`)
      record.selectSql = sql
      record.selectParams = params
      record.phase = 'selected'
      if (!params) throw new Error('database fence RPC is missing parameters')
      if (behavior.errorFromParams) throw behavior.errorFromParams(params)
      if (behavior.error) throw behavior.error

      const payload =
        operation === 'release'
          ? releasePayload(params, behavior, tick)
          : activePayload(params, behavior, tick)
      tick += 1
      behavior.mutatePayload?.(payload)
      return {
        rowCount: behavior.rowCount === undefined ? 1 : behavior.rowCount,
        rows: [{ worker_db_fence: payload }],
      } as QueryResult
    })
    clients.push(record)
    return { query: record.query, release } as Pick<PoolClient, 'query' | 'release'>
  }) as jest.MockedFunction<WorkerDbFenceConnect>
  return { clients, connect }
}

function connectionError(code = '08006', message = 'driver carried a secret value'): Error {
  return Object.assign(new Error(message), { code })
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
