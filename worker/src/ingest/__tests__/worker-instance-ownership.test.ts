import {
  acquireWorkerOwnership,
  WORKER_INSTANCE_INDEX_KEY,
  WORKER_INSTANCE_RECORD_LIMIT,
  WORKER_INSTANCE_RECORD_RETENTION_MS,
  WORKER_INSTANCE_RECORDS_KEY,
  WORKER_OWNER_LEASE_RENEW_MS,
  WORKER_OWNER_LEASE_TTL_MS,
  WORKER_OWNER_RECORDS_KEY,
  WORKER_OWNER_SAFETY_MARGIN_MS,
  WORKER_OWNER_SELF_FENCE_MS,
  WORKER_OWNERSHIP_CONTRACT,
  WORKER_ROSTER_V4_KEY,
  workerAuthorityScope,
  workerOwnershipKeys,
  type WorkerAuthorityScope,
  type WorkerOwnershipHeartbeatInput,
  type WorkerOwnershipRedis,
  type WorkerOwnershipRegion,
} from '../worker-instance-ownership'

const NODE = 'mac-mini.local'
const OTHER_NODE = 'worker-sg'
const INSTANCE = '01234567-89ab-4cde-8fab-0123456789ab'
const SECOND_INSTANCE = '12345678-9abc-4def-8abc-123456789abc'
const TOKEN = 'c'.repeat(64)
const SECOND_TOKEN = 'd'.repeat(64)
const NOW = 2_000_000_000_000

function heartbeat(
  region: WorkerOwnershipRegion = 'local',
  node = NODE
): WorkerOwnershipHeartbeatInput {
  return {
    attempt_bound_capture: true,
    disk: 42,
    node,
    pid: 4242,
    regions: [region],
    release_id: 'b'.repeat(64),
    sha: 'a'.repeat(40),
  }
}

function identity(
  authorityScope: WorkerAuthorityScope = 'region:local',
  instanceId = INSTANCE,
  ownerToken = TOKEN
) {
  return { authorityScope, instanceId, ownerToken }
}

function redisMock(results: unknown[]): WorkerOwnershipRedis & { eval: jest.Mock } {
  return { eval: jest.fn(async () => results.shift()) }
}

function scriptResult(
  status: 0 | 1,
  controlEpoch: number,
  controlServerTimeMs: number,
  initialControlServerTimeMs = controlServerTimeMs,
  leaseRemainingMs = WORKER_OWNER_LEASE_TTL_MS
) {
  return [status, controlEpoch, controlServerTimeMs, initialControlServerTimeMs, leaseRemainingMs]
}

describe('worker instance ownership protocol', () => {
  it('uses a global scope lease and a node-shared monotonic control counter', () => {
    const local = workerOwnershipKeys(NODE, 'local')
    const sg = workerOwnershipKeys(NODE, 'vps_sg')
    const sameScopeOtherNode = workerOwnershipKeys(OTHER_NODE, 'local')

    expect(local.lease).toBe(sameScopeOtherNode.lease)
    expect(local.lease).not.toContain(NODE)
    expect(local.epoch).toBe(sg.epoch)
    expect(local.epoch).not.toBe(sameScopeOtherNode.epoch)
    expect(local.lease).not.toBe(sg.lease)
    expect(local.lease).toContain('region:local')
    expect(sg.lease).toContain('region:vps_sg')

    for (const keys of [local, sg, sameScopeOtherNode]) {
      const tags = Object.values(keys).map((key) => key.match(/\{[^}]+\}/)?.[0])
      expect(new Set(tags)).toEqual(new Set(['{worker}']))
    }
  })

  it('claims one scope with a private token and an unambiguous public proof', async () => {
    const redis = redisMock([scriptResult(1, 7, NOW), scriptResult(1, 7, NOW, NOW, 0)])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis,
    })

    expect(result.status).toBe('owned')
    if (result.status !== 'owned') throw new Error('expected owner')
    expect(result.lease.proof).toEqual({
      authorityScope: 'region:local',
      controlEpoch: 7,
      controlServerTimeMs: NOW,
      initialControlServerTimeMs: NOW,
      instanceId: INSTANCE,
      nodeId: NODE,
      region: 'local',
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0] as [string, number, ...string[]]
    const keys = workerOwnershipKeys(NODE, 'local')
    expect(script).toContain('arena.worker-ownership.acquire@2')
    expect(script).toContain('local ownerEpoch = previousOwner.control_epoch')
    expect(script).toContain('redis.call("incr", KEYS[2])')
    expect(script).toContain('redis.call("psetex", KEYS[1], ttl, ARGV[1])')
    expect(script).toContain('currentToken == ARGV[1]')
    expect(script).toContain('previousOwner.control_server_time_ms')
    expect(script).toContain('previousOwner.initial_control_server_time_ms')
    expect(script).toContain('leaseTtl <= SAFETY_MARGIN')
    expect(script).toContain(
      'local protected, activeNodeHighWater, seenInstances = collect_protected(ARGV[2])'
    )
    expect(script).toContain('highWater < activeNodeHighWater')
    expect(script).toContain('redis.call("hset", KEYS[3], ARGV[3]')
    expect(script).toContain('history_field(scope, node, instanceId, epoch)')
    expect(keyCount).toBe(6)
    expect(args.slice(0, 6)).toEqual([
      keys.lease,
      keys.epoch,
      WORKER_OWNER_RECORDS_KEY,
      WORKER_INSTANCE_RECORDS_KEY,
      WORKER_ROSTER_V4_KEY,
      WORKER_INSTANCE_INDEX_KEY,
    ])
    expect(args.slice(6, 13)).toEqual([
      TOKEN,
      NODE,
      'region:local',
      'local',
      INSTANCE,
      String(WORKER_OWNER_LEASE_TTL_MS),
      '',
    ])
    expect(args.slice(14)).toEqual([
      WORKER_OWNERSHIP_CONTRACT,
      String(WORKER_INSTANCE_RECORD_RETENTION_MS),
      String(WORKER_INSTANCE_RECORD_LIMIT),
    ])
    const published = args[13]
    expect(JSON.parse(published ?? 'null')).toEqual(heartbeat())
    expect(published).not.toContain(TOKEN)
    const replayBranch = script.slice(
      script.indexOf('if currentToken == ARGV[1] then'),
      script.indexOf('local contender = make_instance')
    )
    expect(replayBranch).not.toContain('redis.call("pexpire"')
    expect(replayBranch).not.toContain('redis.call("hset"')
    expect(replayBranch).not.toContain('write_instance(')
    await expect(result.lease.release()).resolves.toBe(true)
  })

  it('recovers distinct immutable and current control times on exact acquire replay', async () => {
    const redis = redisMock([
      scriptResult(1, 7, NOW + 30_000, NOW),
      scriptResult(1, 7, NOW + 30_000, NOW, 0),
    ])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    expect(result.lease.proof.initialControlServerTimeMs).toBe(NOW)
    expect(result.lease.proof.controlServerTimeMs).toBe(NOW + 30_000)
    await expect(result.lease.release()).resolves.toBe(true)
  })

  it('publishes a scoped contender without mutating the active owner tuple', async () => {
    const redis = redisMock([scriptResult(0, 7, NOW)])

    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat('local', OTHER_NODE),
        identity: identity('region:local'),
        redis,
      })
    ).resolves.toEqual({
      authorityScope: 'region:local',
      instanceId: INSTANCE,
      observedControlEpoch: 7,
      observedControlServerTimeMs: NOW,
      region: 'local',
      status: 'contended',
    })

    const script = redis.eval.mock.calls[0][0] as string
    const contenderBranch = script.slice(
      script.indexOf('local contender = make_instance'),
      script.indexOf('if highWater >= MAX_SAFE')
    )
    expect(contenderBranch).toContain('write_instance(')
    expect(contenderBranch).not.toContain('hset", KEYS[3]')
    expect(contenderBranch).not.toContain('hset", KEYS[5]')
    expect(contenderBranch).not.toContain('psetex')
  })

  it('keeps scope A valid after the same node advances its high-water for scope B', async () => {
    const redis = redisMock([
      scriptResult(1, 7, NOW),
      scriptResult(1, 8, NOW + 1),
      scriptResult(1, 7, NOW + 2, NOW),
      scriptResult(1, 7, NOW + 2, NOW, 0),
      scriptResult(1, 8, NOW + 1, NOW + 1, 0),
    ])
    const local = await acquireWorkerOwnership({
      heartbeat: heartbeat('local'),
      identity: identity('region:local'),
      redis,
    })
    const sg = await acquireWorkerOwnership({
      heartbeat: heartbeat('vps_sg'),
      identity: identity('region:vps_sg', SECOND_INSTANCE, SECOND_TOKEN),
      redis,
    })
    if (local.status !== 'owned' || sg.status !== 'owned') throw new Error('expected owners')

    expect(local.lease.proof.controlEpoch).toBe(7)
    expect(sg.lease.proof.controlEpoch).toBe(8)
    expect(workerOwnershipKeys(NODE, 'local').epoch).toBe(workerOwnershipKeys(NODE, 'vps_sg').epoch)
    await expect(local.lease.renewAndPublish(heartbeat('local'))).resolves.toBe(true)
    await expect(local.lease.release()).resolves.toBe(true)
    await expect(sg.lease.release()).resolves.toBe(true)

    const renewScript = redis.eval.mock.calls[2][0] as string
    const releaseScript = redis.eval.mock.calls[3][0] as string
    for (const script of [renewScript, releaseScript]) {
      expect(script).toContain('highWater < expectedEpoch')
      expect(script).not.toContain('highWater ~= expectedEpoch')
      expect(script).not.toContain('highWater == expectedEpoch')
      expect(script).toContain('"/fenced/" .. tostring(now)')
    }
    expect(renewScript).toContain('if extended ~= 1 then')
    expect(releaseScript).toContain('if deleted ~= 1 then')
  })

  it('renews and releases only the original scope credential and tuple', async () => {
    const redis = redisMock([
      scriptResult(1, 7, NOW),
      scriptResult(1, 7, NOW + 30_000, NOW),
      scriptResult(1, 7, NOW + 30_000, NOW, 0),
    ])
    const mutableIdentity = identity()
    const initialHeartbeat = heartbeat()
    const result = await acquireWorkerOwnership({
      heartbeat: initialHeartbeat,
      identity: mutableIdentity,
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    mutableIdentity.ownerToken = SECOND_TOKEN
    initialHeartbeat.node = 'mutated-after-acquire'
    const exposedProof = result.lease.proof as { controlEpoch: number }
    exposedProof.controlEpoch = 999

    await expect(
      result.lease.renewAndPublish({ ...heartbeat(), disk: 43, attempt_bound_capture: false })
    ).resolves.toBe(true)
    expect(result.lease.proof.controlServerTimeMs).toBe(NOW + 30_000)
    expect(result.lease.proof.initialControlServerTimeMs).toBe(NOW)
    await expect(result.lease.release()).resolves.toBe(true)
    expect(result.lease.signal.aborted).toBe(true)
    expect(result.lease.isOwned()).toBe(false)

    const renew = redis.eval.mock.calls[1] as unknown[]
    const release = redis.eval.mock.calls[2] as unknown[]
    expect(renew[0]).toEqual(expect.stringContaining('arena.worker-ownership.renew@2'))
    expect(release[0]).toEqual(expect.stringContaining('arena.worker-ownership.release@2'))
    for (const call of [renew, release]) {
      expect(call).toContain(TOKEN)
      expect(call).toContain(INSTANCE)
      expect(call).toContain('region:local')
      expect(call).toContain('7')
    }
  })

  it.each([
    ['node', { node: OTHER_NODE }],
    ['region', { regions: ['vps_sg'] as WorkerOwnershipRegion[] }],
    ['pid', { pid: 5252 }],
    ['release', { release_id: 'e'.repeat(64) }],
    ['sha', { sha: 'f'.repeat(40) }],
  ])('self-fences before Redis when immutable %s evidence changes', async (_label, patch) => {
    const redis = redisMock([scriptResult(1, 7, NOW)])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    await expect(result.lease.renewAndPublish({ ...heartbeat(), ...patch })).rejects.toThrow(
      'identity evidence cannot change'
    )
    expect(result.lease.signal.aborted).toBe(true)
    expect(redis.eval).toHaveBeenCalledTimes(1)
  })

  it('binds injected retry credentials to exactly one authority scope', async () => {
    const redis = redisMock([])
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat('vps_sg'),
        identity: identity('region:local'),
        redis,
      })
    ).rejects.toThrow('identity scope cannot change')
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('rejects malformed or zero identity and deployment evidence before Redis', async () => {
    const cases: Array<Parameters<typeof acquireWorkerOwnership>[0]> = [
      {
        heartbeat: heartbeat('local', '../mac'),
        identity: identity(),
        redis: redisMock([]),
      },
      {
        heartbeat: heartbeat(),
        identity: identity('region:local', 'not-a-uuid'),
        redis: redisMock([]),
      },
      {
        heartbeat: heartbeat(),
        identity: identity('region:local', INSTANCE.toUpperCase()),
        redis: redisMock([]),
      },
      {
        heartbeat: heartbeat(),
        identity: identity('region:local', INSTANCE, '0'.repeat(64)),
        redis: redisMock([]),
      },
      {
        heartbeat: { ...heartbeat(), regions: [] },
        identity: identity(),
        redis: redisMock([]),
      },
      {
        heartbeat: { ...heartbeat(), regions: ['local', 'vps_sg'] },
        identity: identity(),
        redis: redisMock([]),
      },
      {
        heartbeat: { ...heartbeat(), sha: '0'.repeat(40) },
        identity: identity(),
        redis: redisMock([]),
      },
      {
        heartbeat: { ...heartbeat(), release_id: '0'.repeat(64) },
        identity: identity(),
        redis: redisMock([]),
      },
      {
        heartbeat: { ...heartbeat(), ownerToken: TOKEN } as never,
        identity: identity(),
        redis: redisMock([]),
      },
    ]

    for (const options of cases) {
      await expect(acquireWorkerOwnership(options)).rejects.toThrow()
      expect(options.redis.eval).not.toHaveBeenCalled()
    }
  })

  it('logs the class and code of a Redis client error, never its message', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const failure = Object.assign(new Error(`raw command ${TOKEN}`), {
        name: 'ReplyError',
        code: 'ECONNRESET',
      })
      await acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: identity(),
        redis: { eval: jest.fn().mockRejectedValue(failure) },
      }).catch(() => undefined)

      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        '[ingest-worker] worker ownership acquire Redis command failed cause: ReplyError code=ECONNRESET',
      ])
    } finally {
      errors.mockRestore()
    }
  })

  it('sanitizes Redis client errors before they can expose the private token', async () => {
    const acquireEval = jest.fn().mockRejectedValue(new Error(`raw command ${TOKEN}`))
    const acquireError = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis: { eval: acquireEval },
    }).catch((error: unknown) => error)
    expect(acquireError).toBeInstanceOf(Error)
    expect((acquireError as Error).message).toBe(
      '[ingest-worker] worker ownership acquire Redis command failed'
    )
    expect((acquireError as Error).message).not.toContain(TOKEN)

    const releaseEval = jest.fn()
    releaseEval.mockResolvedValueOnce(scriptResult(1, 7, NOW))
    releaseEval.mockRejectedValueOnce(new Error(`raw command ${TOKEN}`))
    const owned = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis: { eval: releaseEval },
    })
    if (owned.status !== 'owned') throw new Error('expected owner')
    const releaseError = await owned.lease.release().catch((error: unknown) => error)
    expect(releaseError).toBeInstanceOf(Error)
    expect((releaseError as Error).message).toBe(
      '[ingest-worker] worker ownership release Redis command failed'
    )
    expect((releaseError as Error).message).not.toContain(TOKEN)
  })

  it('validates and encodes every fallible value before the first authority write', async () => {
    const redis = redisMock([scriptResult(0, 7, NOW)])
    await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis,
    })
    const script = redis.eval.mock.calls[0][0] as string
    const acquire = script.slice(script.indexOf('-- arena.worker-ownership.acquire@2'))
    const firstWrite = acquire.indexOf('redis.call("incr", KEYS[2])')

    expect(firstWrite).toBeGreaterThan(0)
    expect(acquire.indexOf('if highWater >= MAX_SAFE')).toBeLessThan(firstWrite)
    expect(
      acquire.indexOf(
        'local protected, activeNodeHighWater, seenInstances = collect_protected(ARGV[2])'
      )
    ).toBeLessThan(firstWrite)
    expect(acquire.indexOf('local encodedOwner = encode_table(owner)')).toBeLessThan(firstWrite)
    expect(acquire.indexOf('local encodedExpired = nil')).toBeLessThan(firstWrite)
    expect(script).toContain('pcall(cjson.decode, raw)')
    expect(script).toContain('pcall(cjson.encode, value)')
    expect(script).toContain('owner.authority_scope ~= scope')
    expect(script).toContain('local owners = redis.call("hgetall", KEYS[3])')
    expect(script).toContain('local rosters = redis.call("hgetall", KEYS[5])')
    expect(script).toContain('generationScopes[generation] ~= scope')
    expect(script).toContain('if currentToken then return {-1, 0, 0, 0, 0} end')
    expect(script).toContain('ARGV[6] == tostring(LEASE_TTL)')
    expect(script).toContain('leaseTtl > ttl')
    expect(script).toContain('KEYS[1] == KEY_ROOT .. "owner:v4:" .. ARGV[3]')
    expect(script).toContain('KEYS[2] == KEY_ROOT .. "epoch:v4:" .. ARGV[2]')
    expect(script).toContain('if not allowed[key] then return false end')
    expect(script).toContain('safe_integer(record.initial_control_server_time_ms, 1)')
    expect(script).toContain('generationScopes[generation] ~= scope')
    expect(script).toContain('instanceScopes[canonicalInstance] ~= scope')
    expect(script).toContain(
      'protected[history_field(scope, record.node, record.instance_id, record.control_epoch)] = true'
    )
  })

  it('permanently fences a local handle after a rejected renewal', async () => {
    const redis = redisMock([scriptResult(1, 7, NOW), scriptResult(0, 7, NOW, NOW, 0)])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    await expect(result.lease.renewAndPublish(heartbeat())).resolves.toBe(false)
    await expect(result.lease.renewAndPublish(heartbeat())).resolves.toBe(false)
    await expect(result.lease.release()).resolves.toBe(false)
    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(result.lease.signal.aborted).toBe(true)
  })

  it('accepts a strictly newer takeover as a distinct scoped control proof', async () => {
    const redis = redisMock([
      scriptResult(1, 7, NOW),
      scriptResult(1, 7, NOW, NOW, 0),
      scriptResult(1, 8, NOW + 2),
      scriptResult(1, 8, NOW + 2, NOW + 2, 0),
    ])
    const first = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis,
    })
    if (first.status !== 'owned') throw new Error('expected first owner')
    await first.lease.release()

    const second = await acquireWorkerOwnership({
      heartbeat: { ...heartbeat(), pid: 5252 },
      identity: identity('region:local', SECOND_INSTANCE, SECOND_TOKEN),
      redis,
    })
    expect(second.status).toBe('owned')
    if (second.status === 'owned') {
      expect(second.lease.proof.controlEpoch).toBe(8)
      await expect(second.lease.release()).resolves.toBe(true)
    }
  })

  it('keeps a watchdog margin and self-fences rejected or hung renewal', async () => {
    expect(WORKER_OWNER_LEASE_RENEW_MS).toBeLessThan(WORKER_OWNER_SELF_FENCE_MS)
    expect(WORKER_OWNER_SELF_FENCE_MS).toBeLessThan(WORKER_OWNER_LEASE_TTL_MS)
    expect(WORKER_OWNER_LEASE_TTL_MS - WORKER_OWNER_SELF_FENCE_MS).toBeGreaterThanOrEqual(
      WORKER_OWNER_LEASE_RENEW_MS
    )
    expect(WORKER_OWNER_SAFETY_MARGIN_MS).toBe(
      WORKER_OWNER_LEASE_TTL_MS - WORKER_OWNER_SELF_FENCE_MS
    )
    expect(WORKER_INSTANCE_RECORD_RETENTION_MS).toBe(24 * 60 * 60_000)
    expect(WORKER_INSTANCE_RECORD_LIMIT).toBeGreaterThanOrEqual(128)

    const rejectedEval = jest.fn()
    rejectedEval.mockResolvedValueOnce(scriptResult(1, 7, NOW))
    rejectedEval.mockRejectedValueOnce(new Error(`raw command ${TOKEN}`))
    const rejectedResult = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis: { eval: rejectedEval },
    })
    if (rejectedResult.status !== 'owned') throw new Error('expected owner')
    await expect(rejectedResult.lease.renewAndPublish(heartbeat())).rejects.toThrow(
      'renew Redis command failed'
    )
    expect(rejectedResult.lease.signal.aborted).toBe(true)

    jest.useFakeTimers()
    try {
      const hungEval = jest.fn()
      hungEval.mockResolvedValueOnce(scriptResult(1, 7, NOW))
      hungEval.mockImplementationOnce(() => new Promise(() => undefined))
      const hung = await acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: identity(),
        redis: { eval: hungEval },
      })
      if (hung.status !== 'owned') throw new Error('expected owner')
      void hung.lease.renewAndPublish(heartbeat())
      await Promise.resolve()
      await jest.advanceTimersByTimeAsync(WORKER_OWNER_SELF_FENCE_MS)
      expect(hung.lease.signal.aborted).toBe(true)
      expect(hung.lease.isOwned()).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects an acquire response that consumed the local safety window', async () => {
    let monotonic = 0
    let resolveAcquire: ((value: unknown) => void) | undefined
    const evalMock = jest.fn(() => new Promise((resolve) => (resolveAcquire = resolve)))
    const acquisition = acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      monotonicNow: () => monotonic,
      redis: { eval: evalMock },
    })

    monotonic = WORKER_OWNER_SELF_FENCE_MS
    resolveAcquire?.(scriptResult(1, 7, NOW))
    await expect(acquisition).rejects.toThrow('outside its safe lease window')
  })

  it('derives a replay watchdog from remaining TTL while preserving the safety margin', async () => {
    let monotonic = 0
    const replayWindow = 1_234
    const redis = redisMock([
      scriptResult(1, 7, NOW + 1, NOW, WORKER_OWNER_SAFETY_MARGIN_MS + replayWindow),
    ])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      monotonicNow: () => monotonic,
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    monotonic = replayWindow - 1
    expect(result.lease.isOwned()).toBe(true)
    monotonic = replayWindow
    expect(result.lease.isOwned()).toBe(false)
    expect(result.lease.signal.aborted).toBe(true)
  })

  it('serializes an in-flight renewal with one memoized release', async () => {
    let resolveRenew: ((value: unknown) => void) | undefined
    const evalMock = jest.fn()
    evalMock.mockResolvedValueOnce(scriptResult(1, 7, NOW))
    evalMock.mockImplementationOnce(() => new Promise((resolve) => (resolveRenew = resolve)))
    evalMock.mockResolvedValueOnce(scriptResult(1, 7, NOW + 1, NOW, 0))
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis: { eval: evalMock },
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    const renewal = result.lease.renewAndPublish(heartbeat())
    await Promise.resolve()
    const release = result.lease.release()
    expect(result.lease.release()).toBe(release)
    resolveRenew?.(scriptResult(1, 7, NOW + 1, NOW))

    await expect(renewal).resolves.toBe(false)
    await expect(release).resolves.toBe(true)
    expect(evalMock).toHaveBeenCalledTimes(3)
  })

  it('fences when Redis changes the control epoch or regresses server time', async () => {
    const changedEpoch = redisMock([scriptResult(1, 7, NOW), scriptResult(1, 8, NOW + 1, NOW)])
    const epochLease = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis: changedEpoch,
    })
    if (epochLease.status !== 'owned') throw new Error('expected owner')
    await expect(epochLease.lease.renewAndPublish(heartbeat())).rejects.toThrow('epoch changed')
    expect(epochLease.lease.signal.aborted).toBe(true)

    const regressedTime = redisMock([scriptResult(1, 7, NOW), scriptResult(1, 7, NOW - 1)])
    const timeLease = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: identity(),
      redis: regressedTime,
    })
    if (timeLease.status !== 'owned') throw new Error('expected owner')
    await expect(timeLease.lease.renewAndPublish(heartbeat())).rejects.toThrow(
      'server time regressed'
    )
    expect(timeLease.lease.signal.aborted).toBe(true)
  })

  it('fails closed on malformed, out-of-range, or internal-error script results', async () => {
    for (const [response, message] of [
      ['OK', 'malformed result'],
      [[1, null, NOW, NOW, WORKER_OWNER_LEASE_TTL_MS], 'invalid result'],
      [[-1, 0, 0, 0, 0], 'invalid result'],
      [[1, 9_007_199_254_740_001, NOW, NOW, WORKER_OWNER_LEASE_TTL_MS], 'invalid result'],
      [[0, 0, NOW, NOW, WORKER_OWNER_LEASE_TTL_MS], 'invalid result'],
      [[1, 0, NOW, NOW, WORKER_OWNER_LEASE_TTL_MS], 'invalid result'],
      [[1, 7, NOW, NOW + 1, WORKER_OWNER_LEASE_TTL_MS], 'invalid result'],
      [[1, 7, NOW, NOW, WORKER_OWNER_LEASE_TTL_MS + 1], 'invalid result'],
    ] as const) {
      const redis = redisMock([response])
      await expect(
        acquireWorkerOwnership({
          heartbeat: heartbeat(),
          identity: identity(),
          redis,
        })
      ).rejects.toThrow(message)
    }
  })

  it('derives only registered database authority scopes', () => {
    expect(workerAuthorityScope('local')).toBe('region:local')
    expect(workerAuthorityScope('vps_sg')).toBe('region:vps_sg')
    expect(() => workerAuthorityScope('vps_jp' as never)).toThrow(
      'unsupported worker ownership region'
    )
    expect(() => workerOwnershipKeys(123 as never, 'local')).toThrow('unsafe worker node identity')
  })
})
