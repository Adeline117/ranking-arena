import IORedis from 'ioredis'

import {
  acquireWorkerOwnership,
  WORKER_INSTANCE_INDEX_KEY,
  WORKER_INSTANCE_RECORDS_KEY,
  WORKER_OWNER_LEASE_TTL_MS,
  WORKER_OWNER_RECORDS_KEY,
  WORKER_ROSTER_V4_KEY,
  workerOwnershipKeys,
  type WorkerAuthorityScope,
  type WorkerOwnershipHeartbeatInput,
  type WorkerOwnershipRedis,
  type WorkerOwnershipRegion,
} from '../worker-instance-ownership'

function disposableRedisUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('WORKER_OWNERSHIP_REDIS_TEST_URL must be a disposable loopback Redis URL')
  }
  const port = Number(parsed.port)
  if (
    parsed.protocol !== 'redis:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/15' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      'WORKER_OWNERSHIP_REDIS_TEST_URL must be redis://127.0.0.1:<port>/15 without credentials'
    )
  }
  return parsed.toString()
}

const REDIS_URL = disposableRedisUrl(process.env.WORKER_OWNERSHIP_REDIS_TEST_URL)
const describeRedis = REDIS_URL ? describe : describe.skip

const LOCAL_NODE = 'redis-test-local'
const OTHER_NODE = 'redis-test-other'
const RELEASE_ID = '1'.repeat(64)
const GIT_SHA = '2'.repeat(40)
const ACL_PASSWORD = '3'.repeat(64)

const IDENTITIES = {
  local: {
    authorityScope: 'region:local' as const,
    instanceId: '00000000-0000-4000-8000-000000000001',
    ownerToken: 'a'.repeat(64),
  },
  localOther: {
    authorityScope: 'region:local' as const,
    instanceId: '00000000-0000-4000-8000-000000000002',
    ownerToken: 'b'.repeat(64),
  },
  localThird: {
    authorityScope: 'region:local' as const,
    instanceId: '00000000-0000-4000-8000-000000000003',
    ownerToken: 'c'.repeat(64),
  },
  sg: {
    authorityScope: 'region:vps_sg' as const,
    instanceId: '00000000-0000-4000-8000-000000000004',
    ownerToken: 'd'.repeat(64),
  },
}

const DUPLICATE_EVIDENCE_CASES = [
  {
    instanceId: IDENTITIES.sg.instanceId,
    label: 'node generation',
    node: LOCAL_NODE,
  },
  {
    instanceId: IDENTITIES.local.instanceId,
    label: 'instance UUID',
    node: OTHER_NODE,
  },
] as const

function heartbeat(
  region: WorkerOwnershipRegion = 'local',
  node = LOCAL_NODE,
  disk = 42
): WorkerOwnershipHeartbeatInput {
  return {
    attempt_bound_capture: true,
    disk,
    node,
    pid: 4242,
    regions: [region],
    release_id: RELEASE_ID,
    sha: GIT_SHA,
  }
}

class ScriptLoadingRedis implements WorkerOwnershipRedis {
  readonly loadedShas = new Set<string>()

  constructor(private readonly client: IORedis) {}

  async eval(script: string, keyCount: number, ...args: string[]): Promise<unknown> {
    const loaded = await this.client.script('LOAD', script)
    if (typeof loaded !== 'string' || !/^[0-9a-f]{40}$/.test(loaded)) {
      throw new Error('Redis SCRIPT LOAD returned an invalid SHA')
    }
    this.loadedShas.add(loaded)
    return this.client.evalsha(loaded, keyCount, ...args)
  }
}

async function assertDisposableServer(redis: IORedis): Promise<void> {
  const users = await redis.call('ACL', 'USERS')
  const keyspace = await redis.info('keyspace')
  if (
    !Array.isArray(users) ||
    users.length !== 1 ||
    users[0] !== 'default' ||
    /^db\d+:/m.test(keyspace) ||
    (await redis.dbsize()) !== 0
  ) {
    throw new Error('worker ownership integration tests require a fresh disposable Redis server')
  }
}

describeRedis('worker instance ownership against disposable Redis', () => {
  jest.setTimeout(30_000)

  let admin: IORedis
  let disposableServerConfirmed = false
  const restrictedClients: IORedis[] = []
  const aclUsers = new Set<string>()

  async function createRestrictedRedis(
    suffix: string,
    deniedCommand: 'del' | 'hset' | 'pexpire' | 'psetex'
  ): Promise<ScriptLoadingRedis> {
    const username = `worker_${process.pid}_${suffix}`
    aclUsers.add(username)
    await admin.call(
      'ACL',
      'SETUSER',
      username,
      'reset',
      'on',
      `>${ACL_PASSWORD}`,
      '~arena:{worker}:*',
      '+@all',
      `-${deniedCommand}`
    )
    const client = new IORedis(REDIS_URL!, {
      connectionName: `worker-ownership-${suffix}`,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      password: ACL_PASSWORD,
      retryStrategy: () => null,
      username,
    })
    restrictedClients.push(client)
    await client.connect()
    await expect(client.ping()).resolves.toBe('PONG')
    return new ScriptLoadingRedis(client)
  }

  beforeAll(async () => {
    admin = new IORedis(REDIS_URL!, {
      connectionName: 'worker-ownership-admin',
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    })
    await admin.connect()
    await expect(admin.ping()).resolves.toBe('PONG')
    await assertDisposableServer(admin)
    disposableServerConfirmed = true
  })

  afterEach(async () => {
    for (const client of restrictedClients.splice(0)) {
      if (client.status === 'ready') {
        await client.quit().catch(() => client.disconnect())
      } else {
        client.disconnect()
      }
    }
    if (!disposableServerConfirmed) return
    await admin.flushdb()
    if (aclUsers.size > 0) {
      await admin.call('ACL', 'DELUSER', ...aclUsers)
      aclUsers.clear()
    }
  })

  afterAll(async () => {
    if (admin.status === 'ready') await admin.quit()
    else admin.disconnect()
  })

  it('loads and executes all scripts with scoped leases and a node-shared epoch', async () => {
    const redis = new ScriptLoadingRedis(admin)
    const localKeys = workerOwnershipKeys(LOCAL_NODE, 'local')
    const staleField = 'stale/unprotected/history'
    await admin.hset(WORKER_INSTANCE_RECORDS_KEY, staleField, '{}')
    await admin.zadd(WORKER_INSTANCE_INDEX_KEY, 0, staleField)

    const local = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.local,
      redis,
    })
    expect(local.status).toBe('owned')
    if (local.status !== 'owned') throw new Error('expected local owner')
    expect(local.lease.proof.controlEpoch).toBe(1)
    expect(await admin.pttl(localKeys.lease)).toBeGreaterThan(0)
    expect(await admin.pttl(localKeys.lease)).toBeLessThanOrEqual(WORKER_OWNER_LEASE_TTL_MS)
    expect(await admin.hget(WORKER_INSTANCE_RECORDS_KEY, staleField)).toBeNull()
    expect(await admin.zscore(WORKER_INSTANCE_INDEX_KEY, staleField)).toBeNull()

    const rawOwner = await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')
    const rawRoster = await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')
    expect(rawOwner).not.toBeNull()
    expect(rawRoster).not.toBeNull()
    expect(rawOwner).not.toContain(IDENTITIES.local.ownerToken)
    expect(rawRoster).not.toContain(IDENTITIES.local.ownerToken)
    expect(JSON.parse(rawOwner ?? '{}')).toMatchObject({
      authority_scope: 'region:local',
      control_epoch: 1,
      instance_id: IDENTITIES.local.instanceId,
      node: LOCAL_NODE,
      worker_region: 'local',
    })

    const replay = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.local,
      redis,
    })
    expect(replay.status).toBe('owned')
    if (replay.status !== 'owned') throw new Error('expected replayed local owner')
    expect(replay.lease.proof.initialControlServerTimeMs).toBe(
      local.lease.proof.initialControlServerTimeMs
    )

    const sg = await acquireWorkerOwnership({
      heartbeat: heartbeat('vps_sg'),
      identity: IDENTITIES.sg,
      redis,
    })
    expect(sg.status).toBe('owned')
    if (sg.status !== 'owned') throw new Error('expected SG owner')
    expect(sg.lease.proof.controlEpoch).toBe(2)
    expect(workerOwnershipKeys(LOCAL_NODE, 'local').epoch).toBe(
      workerOwnershipKeys(LOCAL_NODE, 'vps_sg').epoch
    )

    await expect(local.lease.renewAndPublish(heartbeat('local', LOCAL_NODE, 43))).resolves.toBe(
      true
    )
    expect(local.lease.proof.initialControlServerTimeMs).toBe(
      replay.lease.proof.initialControlServerTimeMs
    )

    const contender = await acquireWorkerOwnership({
      heartbeat: heartbeat('local', OTHER_NODE),
      identity: IDENTITIES.localOther,
      redis,
    })
    expect(contender).toMatchObject({
      observedControlEpoch: 1,
      status: 'contended',
    })

    await expect(local.lease.release()).resolves.toBe(true)
    await expect(replay.lease.renewAndPublish(heartbeat())).resolves.toBe(false)
    await expect(sg.lease.release()).resolves.toBe(true)
    expect(await admin.get(localKeys.lease)).toBeNull()
    expect(await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')).toBeNull()
    expect(await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')).toBeNull()
    expect(redis.loadedShas.size).toBe(3)

    const historyFields = await admin.zrange(WORKER_INSTANCE_INDEX_KEY, 0, -1)
    expect(historyFields.length).toBeGreaterThan(0)
    for (const field of historyFields) {
      expect(await admin.hexists(WORKER_INSTANCE_RECORDS_KEY, field)).toBe(1)
    }
  })

  it('fails before the epoch write when a key has the wrong Redis type', async () => {
    const redis = new ScriptLoadingRedis(admin)
    const keys = workerOwnershipKeys(LOCAL_NODE, 'local')
    await admin.hset(keys.lease, 'wrong', 'type')

    await expect(
      acquireWorkerOwnership({ heartbeat: heartbeat(), identity: IDENTITIES.local, redis })
    ).rejects.toThrow('invalid result')
    expect(await admin.get(keys.epoch)).toBeNull()
    expect(await admin.hlen(WORKER_OWNER_RECORDS_KEY)).toBe(0)
    expect(await admin.hlen(WORKER_ROSTER_V4_KEY)).toBe(0)
  })

  it('keeps an INCR gap safe when PSETEX is denied, then acquires the next epoch', async () => {
    const restricted = await createRestrictedRedis('deny_psetex', 'psetex')
    const keys = workerOwnershipKeys(LOCAL_NODE, 'local')

    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.local,
        redis: restricted,
      })
    ).rejects.toThrow('acquire Redis command failed')
    expect(await admin.get(keys.epoch)).toBe('1')
    expect(await admin.get(keys.lease)).toBeNull()
    expect(await admin.hlen(WORKER_OWNER_RECORDS_KEY)).toBe(0)

    const recovered = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.localOther,
      redis: new ScriptLoadingRedis(admin),
    })
    expect(recovered.status).toBe('owned')
    if (recovered.status !== 'owned') throw new Error('expected recovered owner')
    expect(recovered.lease.proof.controlEpoch).toBe(2)
    await expect(recovered.lease.release()).resolves.toBe(true)
  })

  it('fails closed behind the old TTL when HSET leaves only a live token', async () => {
    const restricted = await createRestrictedRedis('deny_hset', 'hset')
    const keys = workerOwnershipKeys(LOCAL_NODE, 'local')

    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.local,
        redis: restricted,
      })
    ).rejects.toThrow('acquire Redis command failed')
    expect(await admin.get(keys.epoch)).toBe('1')
    expect(await admin.get(keys.lease)).toBe(IDENTITIES.local.ownerToken)
    expect(await admin.pttl(keys.lease)).toBeGreaterThan(0)
    expect(await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')).toBeNull()
    expect(await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')).toBeNull()

    const normal = new ScriptLoadingRedis(admin)
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.localOther,
        redis: normal,
      })
    ).rejects.toThrow('invalid result')

    await admin.del(keys.lease)
    const recovered = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.localOther,
      redis: normal,
    })
    expect(recovered.status).toBe('owned')
    if (recovered.status !== 'owned') throw new Error('expected recovered owner')
    expect(recovered.lease.proof.controlEpoch).toBe(2)
    expect(await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')).not.toBeNull()
    expect(await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')).not.toBeNull()
    await expect(recovered.lease.release()).resolves.toBe(true)
  })

  it.each(['owner', 'roster'] as const)(
    'fails closed on a live %s-only mirror and self-heals after lease expiry',
    async (remainingMirror) => {
      const redis = new ScriptLoadingRedis(admin)
      const keys = workerOwnershipKeys(LOCAL_NODE, 'local')
      const owned = await acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.local,
        redis,
      })
      expect(owned.status).toBe('owned')
      if (owned.status !== 'owned') throw new Error('expected owner')

      const removedHash =
        remainingMirror === 'owner' ? WORKER_ROSTER_V4_KEY : WORKER_OWNER_RECORDS_KEY
      const retainedHash =
        remainingMirror === 'owner' ? WORKER_OWNER_RECORDS_KEY : WORKER_ROSTER_V4_KEY
      await admin.hdel(removedHash, 'region:local')
      expect(await admin.hget(retainedHash, 'region:local')).not.toBeNull()
      expect(await admin.hget(removedHash, 'region:local')).toBeNull()

      await expect(
        acquireWorkerOwnership({
          heartbeat: heartbeat(),
          identity: IDENTITIES.localOther,
          redis,
        })
      ).rejects.toThrow('invalid result')
      await expect(owned.lease.renewAndPublish(heartbeat())).rejects.toThrow('invalid result')
      expect(owned.lease.isOwned()).toBe(false)
      expect(await admin.get(keys.lease)).toBe(IDENTITIES.local.ownerToken)

      await admin.del(keys.lease)
      const recovered = await acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.localOther,
        redis,
      })
      expect(recovered.status).toBe('owned')
      if (recovered.status !== 'owned') throw new Error('expected recovered owner')
      expect(recovered.lease.proof.controlEpoch).toBe(2)
      expect(await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')).not.toBeNull()
      expect(await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')).not.toBeNull()
      await expect(recovered.lease.release()).resolves.toBe(true)
    }
  )

  it('self-fences failed PEXPIRE renewal and recovers after the old lease disappears', async () => {
    const restricted = await createRestrictedRedis('deny_pexpire', 'pexpire')
    const keys = workerOwnershipKeys(LOCAL_NODE, 'local')
    const owned = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.local,
      redis: restricted,
    })
    expect(owned.status).toBe('owned')
    if (owned.status !== 'owned') throw new Error('expected restricted owner')
    const ttlBefore = await admin.pttl(keys.lease)

    await expect(owned.lease.renewAndPublish(heartbeat('local', LOCAL_NODE, 44))).rejects.toThrow(
      'renew Redis command failed'
    )
    expect(owned.lease.isOwned()).toBe(false)
    expect(owned.lease.signal.aborted).toBe(true)
    expect(await admin.get(keys.lease)).toBe(IDENTITIES.local.ownerToken)
    expect(await admin.pttl(keys.lease)).toBeLessThanOrEqual(ttlBefore)

    const ownerRecord = JSON.parse(
      (await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')) ?? '{}'
    ) as Record<string, unknown>
    const rosterRecord = JSON.parse(
      (await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')) ?? '{}'
    ) as Record<string, unknown>
    const historyField = `region:local/${LOCAL_NODE}/${IDENTITIES.local.instanceId}/1`
    const historyRecord = JSON.parse(
      (await admin.hget(WORKER_INSTANCE_RECORDS_KEY, historyField)) ?? '{}'
    ) as Record<string, unknown>
    expect(ownerRecord.disk).toBe(44)
    expect(rosterRecord.disk).toBe(44)
    expect(historyRecord).toMatchObject({
      control_server_time_ms: ownerRecord.control_server_time_ms,
      disk: 44,
      status: 'owner',
    })
    expect(rosterRecord.control_server_time_ms).toBe(ownerRecord.control_server_time_ms)
    expect(rosterRecord).not.toHaveProperty('lease_expires_at')
    expect(
      (ownerRecord.lease_expires_at as number) - (ownerRecord.control_server_time_ms as number)
    ).toBe(WORKER_OWNER_LEASE_TTL_MS)

    const normal = new ScriptLoadingRedis(admin)
    const contender = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.localOther,
      redis: normal,
    })
    expect(contender.status).toBe('contended')

    await admin.del(keys.lease)
    const recovered = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.localThird,
      redis: normal,
    })
    expect(recovered.status).toBe('owned')
    if (recovered.status !== 'owned') throw new Error('expected recovered owner')
    expect(recovered.lease.proof.controlEpoch).toBe(2)
    await expect(recovered.lease.release()).resolves.toBe(true)
  })

  it('self-fences failed DEL release and repairs missing mirrors after lease expiry', async () => {
    const restricted = await createRestrictedRedis('deny_del', 'del')
    const keys = workerOwnershipKeys(LOCAL_NODE, 'local')
    const owned = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.local,
      redis: restricted,
    })
    expect(owned.status).toBe('owned')
    if (owned.status !== 'owned') throw new Error('expected restricted owner')

    await expect(owned.lease.release()).rejects.toThrow('release Redis command failed')
    expect(owned.lease.isOwned()).toBe(false)
    expect(await admin.get(keys.lease)).toBe(IDENTITIES.local.ownerToken)
    expect(await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')).toBeNull()
    expect(await admin.hget(WORKER_ROSTER_V4_KEY, 'region:local')).toBeNull()

    const normal = new ScriptLoadingRedis(admin)
    await expect(
      acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.localOther,
        redis: normal,
      })
    ).rejects.toThrow('invalid result')

    await admin.del(keys.lease)
    const recovered = await acquireWorkerOwnership({
      heartbeat: heartbeat(),
      identity: IDENTITIES.localOther,
      redis: normal,
    })
    expect(recovered.status).toBe('owned')
    if (recovered.status !== 'owned') throw new Error('expected recovered owner')
    expect(recovered.lease.proof.controlEpoch).toBe(2)
    await expect(recovered.lease.release()).resolves.toBe(true)
  })

  it.each(DUPLICATE_EVIDENCE_CASES)(
    'rejects a duplicate $label independently across authority scopes',
    async ({ instanceId, node }) => {
      const redis = new ScriptLoadingRedis(admin)
      const local = await acquireWorkerOwnership({
        heartbeat: heartbeat(),
        identity: IDENTITIES.local,
        redis,
      })
      expect(local.status).toBe('owned')
      if (local.status !== 'owned') throw new Error('expected local owner')

      const localOwner = JSON.parse(
        (await admin.hget(WORKER_OWNER_RECORDS_KEY, 'region:local')) ?? '{}'
      ) as Record<string, unknown>
      const duplicate = {
        ...localOwner,
        authority_scope: 'region:vps_sg' satisfies WorkerAuthorityScope,
        instance_id: instanceId,
        node,
        regions: ['vps_sg'],
        worker_region: 'vps_sg',
      }
      const duplicateRoster: Record<string, unknown> = { ...duplicate }
      delete duplicateRoster.lease_expires_at
      await admin.hset(WORKER_OWNER_RECORDS_KEY, 'region:vps_sg', JSON.stringify(duplicate))
      await admin.hset(WORKER_ROSTER_V4_KEY, 'region:vps_sg', JSON.stringify(duplicateRoster))

      await expect(local.lease.renewAndPublish(heartbeat())).rejects.toThrow('invalid result')
      expect(local.lease.isOwned()).toBe(false)
      expect(await admin.get(workerOwnershipKeys(LOCAL_NODE, 'local').lease)).toBe(
        IDENTITIES.local.ownerToken
      )
    }
  )
})
