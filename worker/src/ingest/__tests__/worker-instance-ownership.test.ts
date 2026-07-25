import {
  acquireWorkerOwnership,
  WORKER_INSTANCE_INDEX_KEY,
  WORKER_INSTANCE_RECORD_LIMIT,
  WORKER_INSTANCE_RECORD_RETENTION_MS,
  WORKER_INSTANCE_RECORDS_KEY,
  WORKER_OWNER_LEASE_RENEW_MS,
  WORKER_OWNER_LEASE_TTL_MS,
  WORKER_OWNER_RECORDS_KEY,
  WORKER_OWNER_SELF_FENCE_MS,
  WORKER_OWNERSHIP_CONTRACT,
  WORKER_ROSTER_V3_KEY,
  workerOwnershipKeys,
  type WorkerOwnershipRedis,
} from '../worker-instance-ownership'

const NODE = 'mac-mini.local'
const INSTANCE = '01234567-89ab-4cde-8fab-0123456789ab'
const TOKEN = 'c'.repeat(64)
const NOW = 2_000_000_000_000

function heartbeat(node = NODE) {
  return {
    attempt_bound_capture: true,
    disk: 42,
    node,
    pid: 4242,
    regions: ['local'],
    release_id: 'b'.repeat(64),
    sha: 'a'.repeat(40),
  }
}

function redisMock(results: unknown[]): WorkerOwnershipRedis & { eval: jest.Mock } {
  return { eval: jest.fn(async () => results.shift()) }
}

describe('worker instance ownership protocol', () => {
  it('atomically claims one node with a private token and monotonic epoch', async () => {
    const redis = redisMock([
      [1, 7, NOW],
      [1, 7, NOW + 1],
    ])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      redis,
    })

    expect(result.status).toBe('owned')
    if (result.status !== 'owned') throw new Error('expected owner')
    expect(result.lease.proof).toEqual({
      instanceId: INSTANCE,
      leaseEpoch: 7,
      node: NODE,
      serverTimeMs: NOW,
    })
    expect(JSON.stringify(result)).not.toContain(TOKEN)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0]
    expect(script).toContain('arena.worker-ownership.acquire@1')
    expect(script).toContain('redis.call("incr", KEYS[2])')
    expect(script).toContain('redis.call("psetex", KEYS[1], ARGV[4], ARGV[1])')
    expect(script).toContain('currentToken == ARGV[1]')
    expect(script).toContain('redis.call("pttl", KEYS[1])')
    expect(script).toContain('previousOwner.status = "expired"')
    expect(script).toContain('redis.call("zrangebyscore", KEYS[6]')
    expect(script).toContain('redis.call("zcard", KEYS[6])')
    expect(keyCount).toBe(6)
    expect(args.slice(0, 6)).toEqual([
      workerOwnershipKeys(NODE).lease,
      workerOwnershipKeys(NODE).epoch,
      WORKER_OWNER_RECORDS_KEY,
      WORKER_INSTANCE_RECORDS_KEY,
      WORKER_ROSTER_V3_KEY,
      WORKER_INSTANCE_INDEX_KEY,
    ])
    expect(args).toContain(TOKEN)
    expect(args).toContain(WORKER_OWNERSHIP_CONTRACT)
    const published = args.find((arg) => arg.startsWith('{'))
    expect(JSON.parse(published ?? 'null')).toEqual(heartbeat())
    expect(published).not.toContain(TOKEN)
    await expect(result.lease.release()).resolves.toBe(true)
  })

  it('registers a contender without returning an ownership handle', async () => {
    const redis = redisMock([[0, 7, NOW]])

    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis,
      })
    ).resolves.toEqual({
      instanceId: INSTANCE,
      observedEpoch: 7,
      serverTimeMs: NOW,
      status: 'contended',
    })

    const script = redis.eval.mock.calls[0][0] as string
    const contenderBranch = script.slice(
      script.indexOf('local activeOwnerField'),
      script.indexOf('if not rawEpoch')
    )
    expect(contenderBranch).toContain('record_instance(contenderField, encodedContender')
    expect(contenderBranch).not.toContain('KEYS[5]')
  })

  it('renews and releases only with the original token, instance, and epoch', async () => {
    const redis = redisMock([
      [1, 7, NOW],
      [1, 7, NOW + 30_000],
      [1, 7, NOW + 31_000],
    ])
    const identity = { instanceId: INSTANCE, ownerToken: TOKEN }
    const initialHeartbeat = heartbeat()
    const result = await acquireWorkerOwnership({
      heartbeat: initialHeartbeat,
      identity,
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    identity.ownerToken = 'd'.repeat(64)
    initialHeartbeat.node = 'mutated-after-acquire'
    const exposedProof = result.lease.proof as { leaseEpoch: number }
    exposedProof.leaseEpoch = 999

    await expect(result.lease.renewAndPublish(heartbeat())).resolves.toBe(true)
    expect(result.lease.proof.serverTimeMs).toBe(NOW + 30_000)
    await expect(result.lease.release()).resolves.toBe(true)
    expect(result.lease.signal.aborted).toBe(true)
    expect(result.lease.isOwned()).toBe(false)

    const renew = redis.eval.mock.calls[1]
    const release = redis.eval.mock.calls[2]
    expect(renew[0]).toContain('arena.worker-ownership.renew@1')
    expect(release[0]).toContain('arena.worker-ownership.release@1')
    for (const call of [renew, release]) {
      expect(call).toContain(TOKEN)
      expect(call).toContain(INSTANCE)
      expect(call).toContain('7')
    }
  })

  it('permanently fences a local handle after a rejected renewal', async () => {
    const redis = redisMock([
      [1, 7, NOW],
      [0, 7, NOW + 30_000],
    ])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    await expect(result.lease.renewAndPublish(heartbeat())).resolves.toBe(false)
    await expect(result.lease.renewAndPublish(heartbeat())).resolves.toBe(false)
    await expect(result.lease.release()).resolves.toBe(false)
    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(result.lease.signal.aborted).toBe(true)
  })

  it('accepts a strictly newer takeover epoch as a distinct owner proof', async () => {
    const redis = redisMock([
      [1, 7, NOW],
      [1, 7, NOW + 1],
      [1, 8, NOW + 2],
      [1, 8, NOW + 3],
    ])
    const first = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      redis,
    })
    if (first.status !== 'owned') throw new Error('expected first owner')
    await first.lease.release()

    const second = await acquireWorkerOwnership({
      heartbeat: { ...heartbeat(), pid: 5252 },
      identity: {
        instanceId: '12345678-9abc-4def-8abc-123456789abc',
        ownerToken: 'd'.repeat(64),
      },
      redis,
    })
    expect(second.status).toBe('owned')
    if (second.status === 'owned') {
      expect(second.lease.proof.leaseEpoch).toBe(8)
      await expect(second.lease.release()).resolves.toBe(true)
    }
  })

  it('rejects malformed identities and heartbeat evidence before Redis', async () => {
    const redis = redisMock([])

    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat('../mac'),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis,
      })
    ).rejects.toThrow('unsafe worker node identity')
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: 'not-a-uuid', ownerToken: TOKEN },
        redis,
      })
    ).rejects.toThrow('instance identity is malformed')
    await expect(
      acquireWorkerOwnership({
        heartbeat: { ...heartbeat(), regions: [] },
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis,
      })
    ).rejects.toThrow('ownership heartbeat is malformed')
    await expect(
      acquireWorkerOwnership({
        heartbeat: { ...heartbeat(), ownerToken: TOKEN } as never,
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis,
      })
    ).rejects.toThrow('ownership heartbeat is malformed')
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('uses one cluster hash slot and leaves a watchdog margin before TTL', () => {
    const tags = Object.values(workerOwnershipKeys(NODE)).map((key) => key.match(/\{[^}]+\}/)?.[0])
    expect(new Set(tags)).toEqual(new Set(['{worker}']))
    expect(WORKER_OWNER_LEASE_RENEW_MS).toBeLessThan(WORKER_OWNER_SELF_FENCE_MS)
    expect(WORKER_OWNER_SELF_FENCE_MS).toBeLessThan(WORKER_OWNER_LEASE_TTL_MS)
    expect(WORKER_OWNER_LEASE_TTL_MS - WORKER_OWNER_SELF_FENCE_MS).toBeGreaterThanOrEqual(
      WORKER_OWNER_LEASE_RENEW_MS
    )
    expect(WORKER_INSTANCE_RECORD_RETENTION_MS).toBe(24 * 60 * 60_000)
    expect(WORKER_INSTANCE_RECORD_LIMIT).toBeGreaterThanOrEqual(128)
  })

  it('self-fences a rejected or hung renewal before the Redis lease can expire', async () => {
    const rejectedEval = jest.fn()
    rejectedEval.mockResolvedValueOnce([1, 7, NOW])
    rejectedEval.mockRejectedValueOnce(new Error('redis unavailable'))
    const rejectedResult = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      redis: { eval: rejectedEval },
    })
    if (rejectedResult.status !== 'owned') throw new Error('expected owner')
    await expect(rejectedResult.lease.renewAndPublish(heartbeat())).rejects.toThrow(
      'redis unavailable'
    )
    expect(rejectedResult.lease.signal.aborted).toBe(true)

    jest.useFakeTimers()
    try {
      const hungEval = jest.fn()
      hungEval.mockResolvedValueOnce([1, 7, NOW])
      hungEval.mockImplementationOnce(() => new Promise(() => undefined))
      const hung = await acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
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
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      monotonicNow: () => monotonic,
      redis: { eval: evalMock },
    })

    monotonic = WORKER_OWNER_SELF_FENCE_MS
    resolveAcquire?.([1, 7, NOW])
    await expect(acquisition).rejects.toThrow('outside its safe lease window')
  })

  it('serializes an in-flight renewal with one memoized release', async () => {
    let resolveRenew: ((value: unknown) => void) | undefined
    const evalMock = jest.fn()
    evalMock.mockResolvedValueOnce([1, 7, NOW])
    evalMock.mockImplementationOnce(() => new Promise((resolve) => (resolveRenew = resolve)))
    evalMock.mockResolvedValueOnce([1, 7, NOW + 2])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      redis: { eval: evalMock },
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    const renewal = result.lease.renewAndPublish(heartbeat())
    await Promise.resolve()
    const release = result.lease.release()
    expect(result.lease.release()).toBe(release)
    resolveRenew?.([1, 7, NOW + 1])

    await expect(renewal).resolves.toBe(false)
    await expect(release).resolves.toBe(true)
    expect(evalMock).toHaveBeenCalledTimes(3)
  })

  it('fences when Redis changes the epoch behind an existing handle', async () => {
    const redis = redisMock([
      [1, 7, NOW],
      [1, 8, NOW + 1],
    ])
    const result = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: { instanceId: INSTANCE, ownerToken: TOKEN },
      redis,
    })
    if (result.status !== 'owned') throw new Error('expected owner')

    await expect(result.lease.renewAndPublish(heartbeat())).rejects.toThrow('epoch changed')
    expect(result.lease.signal.aborted).toBe(true)
  })

  it('fails closed on malformed or internal-error script results', async () => {
    const malformed = redisMock(['OK'])
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis: malformed,
      })
    ).rejects.toThrow('script returned a malformed result')

    const coercible = redisMock([[1, null, NOW]])
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis: coercible,
      })
    ).rejects.toThrow('script returned an invalid result')

    const internalError = redisMock([[-1, 0, NOW]])
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis: internalError,
      })
    ).rejects.toThrow('script returned an invalid result')

    const zeroEpochOwner = redisMock([[1, 0, NOW]])
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: { instanceId: INSTANCE, ownerToken: TOKEN },
        redis: zeroEpochOwner,
      })
    ).rejects.toThrow('invalid owned epoch')
  })
})
