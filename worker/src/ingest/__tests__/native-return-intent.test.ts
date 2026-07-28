import {
  NATIVE_RETURN_INTENT_CONTRACT,
  NATIVE_RETURN_INTENT_EXPIRY_KEY,
  NATIVE_RETURN_INTENT_HASH_KEY,
  NATIVE_RETURN_INTENT_PRUNE_LIMIT,
  NATIVE_RETURN_INTENT_READ_LIMIT,
  NATIVE_RETURN_INTENT_RENEW_INTERVAL_MS,
  NATIVE_RETURN_INTENT_RENEW_MS,
  NATIVE_RETURN_INTENT_TTL_MS,
  nativeReturnIntentField,
  publishNativeReturnIntent,
  readFreshNativeReturnIntents,
  removeNativeReturnIntent,
  type NativeReturnIntentIdentity,
  type NativeReturnIntentRedis,
} from '../native-return-intent'

const NOW = 2_000_000_000_000
const NODE = 'mac-mini.local'
const BOOT_A = '00000000-0000-4000-8000-000000000001'
const BOOT_B = '00000000-0000-4000-8000-000000000002'
const BOOT_C = '00000000-0000-4000-8000-000000000003'
const BOOT_D = '00000000-0000-4000-8000-000000000004'
const RELEASE_ID = 'b'.repeat(64)
const SHA = 'a'.repeat(40)

function identity(overrides: Partial<NativeReturnIntentIdentity> = {}): NativeReturnIntentIdentity {
  return {
    boot_id: BOOT_A,
    executionRegion: 'local',
    node: NODE,
    pid: 4242,
    region: 'local',
    release_id: RELEASE_ID,
    sha: SHA,
    ...overrides,
  }
}

function encodedIntent(
  value: NativeReturnIntentIdentity = identity(),
  serverTime = NOW,
  ttlMs = NATIVE_RETURN_INTENT_TTL_MS,
  overrides: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    boot_id: value.boot_id,
    contract: NATIVE_RETURN_INTENT_CONTRACT,
    executionRegion: value.executionRegion,
    expires: serverTime + ttlMs,
    node: value.node,
    pid: value.pid,
    region: value.region,
    release_id: value.release_id,
    server_time: serverTime,
    sha: value.sha,
    ...overrides,
  })
}

function publishResult(
  value: NativeReturnIntentIdentity = identity(),
  serverTime = NOW,
  ttlMs = NATIVE_RETURN_INTENT_TTL_MS,
  pruned = 0
): unknown[] {
  return [
    NATIVE_RETURN_INTENT_CONTRACT,
    'ok',
    serverTime,
    serverTime + ttlMs,
    nativeReturnIntentField(value.region, value.node, value.boot_id),
    encodedIntent(value, serverTime, ttlMs),
    pruned,
  ]
}

function redisResult(result: unknown): NativeReturnIntentRedis & { eval: jest.Mock } {
  return { eval: jest.fn(async () => result) }
}

function expectCode(code: string) {
  return expect.objectContaining({
    code,
    message: `[ingest-worker] native return intent rejected (${code})`,
  })
}

interface StoredIntent {
  expires: number
  raw: string
}

class InMemoryScriptRedis implements NativeReturnIntentRedis {
  now = NOW
  readonly records = new Map<string, StoredIntent>()

  private prune(limit: number): number {
    const expired = [...this.records.entries()]
      .filter(([, record]) => record.expires <= this.now)
      .sort((left, right) => left[1].expires - right[1].expires)
      .slice(0, limit)
    for (const [field] of expired) this.records.delete(field)
    return expired.length
  }

  async eval(script: string, keyCount: number, ...args: string[]): Promise<unknown> {
    expect(keyCount).toBe(2)
    expect(args.slice(0, 2)).toEqual([
      NATIVE_RETURN_INTENT_HASH_KEY,
      NATIVE_RETURN_INTENT_EXPIRY_KEY,
    ])
    const values = args.slice(2)
    if (script.includes('arena.native-return-intent.publish-or-renew@1')) {
      const value = identity({
        region: values[1] as NativeReturnIntentIdentity['region'],
        executionRegion: values[2] as NativeReturnIntentIdentity['executionRegion'],
        node: values[3],
        pid: Number(values[4]),
        boot_id: values[5],
        release_id: values[6],
        sha: values[7],
      })
      const ttlMs = Number(values[8])
      const pruned = this.prune(Number(values[9]))
      const field = nativeReturnIntentField(value.region, value.node, value.boot_id)
      const previous = this.records.get(field)
      if (previous) {
        const parsed = JSON.parse(previous.raw) as NativeReturnIntentIdentity
        if (
          parsed.pid !== value.pid ||
          parsed.release_id !== value.release_id ||
          parsed.sha !== value.sha
        ) {
          return [NATIVE_RETURN_INTENT_CONTRACT, 'conflict', this.now, pruned]
        }
      }
      const raw = encodedIntent(value, this.now, ttlMs)
      this.records.set(field, { expires: this.now + ttlMs, raw })
      return [NATIVE_RETURN_INTENT_CONTRACT, 'ok', this.now, this.now + ttlMs, field, raw, pruned]
    }
    if (script.includes('arena.native-return-intent.read-fresh@1')) {
      const targetRegion = values[1]
      const pruned = this.prune(Number(values[2]))
      const matches = [...this.records.entries()]
        .filter(
          ([field, record]) =>
            field.startsWith(`region:${targetRegion}/`) && record.expires > this.now
        )
        .sort((left, right) => left[1].expires - right[1].expires)
      if (matches.length > Number(values[3])) {
        return [NATIVE_RETURN_INTENT_CONTRACT, 'overflow', this.now, pruned]
      }
      return [
        NATIVE_RETURN_INTENT_CONTRACT,
        'ok',
        this.now,
        pruned,
        ...matches.flatMap(([field, record]) => [field, record.expires, record.raw]),
      ]
    }
    if (script.includes('arena.native-return-intent.remove-exact-boot@1')) {
      const field = nativeReturnIntentField(
        values[1] as NativeReturnIntentIdentity['region'],
        values[2],
        values[3]
      )
      const removed = this.records.delete(field)
      return [NATIVE_RETURN_INTENT_CONTRACT, removed ? 'removed' : 'absent', this.now]
    }
    throw new Error('unknown script')
  }
}

describe('native return intent Redis contract', () => {
  it('pins one versioned hash-slot contract and conservative default timing', () => {
    expect(NATIVE_RETURN_INTENT_CONTRACT).toBe('arena.native-return-intent@1')
    expect(NATIVE_RETURN_INTENT_HASH_KEY).toBe('arena:{worker}:native-intents:v1')
    expect(NATIVE_RETURN_INTENT_EXPIRY_KEY).toBe('arena:{worker}:native-intents-expiry:v1')
    expect(NATIVE_RETURN_INTENT_RENEW_MS).toBe(10_000)
    expect(NATIVE_RETURN_INTENT_RENEW_INTERVAL_MS).toBe(10_000)
    expect(NATIVE_RETURN_INTENT_TTL_MS).toBe(45_000)
    expect(NATIVE_RETURN_INTENT_TTL_MS).toBeGreaterThan(NATIVE_RETURN_INTENT_RENEW_INTERVAL_MS * 3)
    expect(NATIVE_RETURN_INTENT_PRUNE_LIMIT).toBe(128)
    expect(NATIVE_RETURN_INTENT_READ_LIMIT).toBe(128)
    expect(NATIVE_RETURN_INTENT_HASH_KEY.match(/\{[^}]+\}/)?.[0]).toBe('{worker}')
    expect(NATIVE_RETURN_INTENT_EXPIRY_KEY.match(/\{[^}]+\}/)?.[0]).toBe('{worker}')
  })

  it('publishes an exact frozen payload using Redis TIME and no client timestamp argument', async () => {
    const redis = redisResult(publishResult())
    const result = await publishNativeReturnIntent({ identity: identity(), redis })

    expect(result).toEqual(JSON.parse(encodedIntent()))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.keys(result).sort()).toEqual(
      [
        'boot_id',
        'contract',
        'executionRegion',
        'expires',
        'node',
        'pid',
        'region',
        'release_id',
        'server_time',
        'sha',
      ].sort()
    )

    const [script, keyCount, ...args] = redis.eval.mock.calls[0] as [string, number, ...string[]]
    expect(keyCount).toBe(2)
    expect(args).toEqual([
      NATIVE_RETURN_INTENT_HASH_KEY,
      NATIVE_RETURN_INTENT_EXPIRY_KEY,
      NATIVE_RETURN_INTENT_CONTRACT,
      'local',
      'local',
      NODE,
      '4242',
      BOOT_A,
      RELEASE_ID,
      SHA,
      String(NATIVE_RETURN_INTENT_TTL_MS),
      String(NATIVE_RETURN_INTENT_PRUNE_LIMIT),
    ])
    expect(args).not.toContain(String(NOW))
    expect(script).toContain('redis.call("time")')
    expect(script).toContain('redis.call("hset", KEYS[1], field, encoded)')
    expect(script).toContain('redis.call("zadd", KEYS[2], expires, field)')
    expect(script).toContain('redis.call("zrangebyscore", KEYS[2], "-inf", now')
    expect(script).toContain('previous.boot_id ~= ARGV[6]')
  })

  it.each([
    ['unknown region', { region: 'us' }],
    ['wrong execution region', { executionRegion: 'vps_sg' }],
    ['unsafe node', { node: 'node/escape' }],
    ['zero pid', { pid: 0 }],
    ['fractional pid', { pid: 1.5 }],
    ['oversized pid', { pid: 2_147_483_648 }],
    ['noncanonical UUID', { boot_id: 'abcdefab-cdef-4abc-8abc-abcdefabcdef'.toUpperCase() }],
    ['invalid UUID version', { boot_id: '00000000-0000-0000-8000-000000000001' }],
    ['zero release', { release_id: '0'.repeat(64) }],
    ['short release', { release_id: 'b'.repeat(63) }],
    ['zero sha', { sha: '0'.repeat(40) }],
    ['uppercase sha', { sha: 'A'.repeat(40) }],
  ])('rejects malformed identity: %s', async (_label, override) => {
    const redis = redisResult(publishResult())
    const promise = publishNativeReturnIntent({
      identity: identity(override as Partial<NativeReturnIntentIdentity>),
      redis,
    })
    await expect(promise).rejects.toEqual(
      expectCode('executionRegion' in override ? 'region_mismatch' : 'identity_malformed')
    )
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('rejects extra identity/options properties and hostile accessors without echoing them', async () => {
    const redis = redisResult(publishResult())
    const extraIdentity = { ...identity(), private_token: 'do-not-leak' }
    await expect(
      publishNativeReturnIntent({ identity: extraIdentity, redis } as never)
    ).rejects.toEqual(expectCode('identity_malformed'))
    await expect(
      publishNativeReturnIntent({
        identity: identity(),
        private_token: 'do-not-leak',
        redis,
      } as never)
    ).rejects.toEqual(expectCode('parameters_malformed'))

    const hostile = Object.defineProperty({}, 'region', {
      enumerable: true,
      get: () => {
        throw new Error('do-not-leak')
      },
    })
    await expect(publishNativeReturnIntent({ identity: hostile, redis } as never)).rejects.toEqual(
      expectCode('identity_malformed')
    )

    const hostileOptions = Object.defineProperties(
      {},
      {
        identity: { enumerable: true, value: identity() },
        redis: {
          enumerable: true,
          get: () => {
            throw new Error('do-not-leak')
          },
        },
      }
    )
    await expect(publishNativeReturnIntent(hostileOptions as never)).rejects.toEqual(
      expectCode('parameters_malformed')
    )
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it.each([
    ['ttl below three renewals', { ttlMs: 29_999 }],
    ['ttl over five minutes', { ttlMs: 300_001 }],
    ['fractional ttl', { ttlMs: 45_000.5 }],
    ['zero prune', { pruneLimit: 0 }],
    ['oversized prune', { pruneLimit: 513 }],
  ])('strictly rejects publish parameters: %s', async (_label, overrides) => {
    const redis = redisResult(publishResult())
    await expect(
      publishNativeReturnIntent({ identity: identity(), redis, ...overrides })
    ).rejects.toEqual(expectCode('parameters_malformed'))
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('renews the same immutable boot while allowing rolling boot IDs to coexist', async () => {
    const redis = new InMemoryScriptRedis()
    const first = await publishNativeReturnIntent({ identity: identity(), redis })
    redis.now += NATIVE_RETURN_INTENT_RENEW_INTERVAL_MS
    const renewed = await publishNativeReturnIntent({ identity: identity(), redis })
    const replacement = await publishNativeReturnIntent({
      identity: identity({ boot_id: BOOT_B, pid: 4343 }),
      redis,
    })

    expect(renewed.server_time).toBe(first.server_time + NATIVE_RETURN_INTENT_RENEW_INTERVAL_MS)
    expect(replacement.boot_id).toBe(BOOT_B)
    expect(redis.records.size).toBe(2)
    const fresh = await readFreshNativeReturnIntents({ redis, targetRegion: 'local' })
    expect(fresh.map((record) => record.boot_id).sort()).toEqual([BOOT_A, BOOT_B])
  })

  it('does not let an old boot removal affect the rolling replacement boot', async () => {
    const redis = new InMemoryScriptRedis()
    await publishNativeReturnIntent({ identity: identity(), redis })
    await publishNativeReturnIntent({ identity: identity({ boot_id: BOOT_B, pid: 4343 }), redis })

    await expect(
      removeNativeReturnIntent({ boot_id: BOOT_A, node: NODE, redis, region: 'local' })
    ).resolves.toBe(true)
    await expect(
      removeNativeReturnIntent({ boot_id: BOOT_A, node: NODE, redis, region: 'local' })
    ).resolves.toBe(false)

    const fresh = await readFreshNativeReturnIntents({ redis, targetRegion: 'local' })
    expect(fresh.map((record) => record.boot_id)).toEqual([BOOT_B])
    expect(redis.records.has(nativeReturnIntentField('local', NODE, BOOT_B))).toBe(true)
  })

  it('uses bounded pruning and excludes stale records by Redis server time', async () => {
    const redis = new InMemoryScriptRedis()
    for (const boot_id of [BOOT_A, BOOT_B, BOOT_C]) {
      await publishNativeReturnIntent({ identity: identity({ boot_id }), redis })
    }
    redis.now += NATIVE_RETURN_INTENT_TTL_MS

    await publishNativeReturnIntent({
      identity: identity({ boot_id: BOOT_D }),
      pruneLimit: 1,
      redis,
    })
    expect(redis.records.size).toBe(3)

    const fresh = await readFreshNativeReturnIntents({
      pruneLimit: 2,
      redis,
      targetRegion: 'local',
    })
    expect(fresh.map((record) => record.boot_id)).toEqual([BOOT_D])
    expect(redis.records.size).toBe(1)
  })

  it('reads and cleans against one atomic Redis-TIME snapshot and freezes all results', async () => {
    const first = identity()
    const second = identity({ boot_id: BOOT_B, pid: 4343 })
    const redis = redisResult([
      NATIVE_RETURN_INTENT_CONTRACT,
      'ok',
      NOW,
      2,
      nativeReturnIntentField('local', NODE, BOOT_A),
      NOW + NATIVE_RETURN_INTENT_TTL_MS,
      encodedIntent(first),
      nativeReturnIntentField('local', NODE, BOOT_B),
      NOW + NATIVE_RETURN_INTENT_TTL_MS,
      encodedIntent(second),
    ])

    const result = await readFreshNativeReturnIntents({ redis, targetRegion: 'local' })
    expect(result).toHaveLength(2)
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.every(Object.isFrozen)).toBe(true)

    const script = redis.eval.mock.calls[0]?.[0] as string
    expect(script).toContain('redis.call("time")')
    expect(script).toContain('local pruned = prune_expired(now, pruneLimit)')
    expect(script).toContain('"zrangebyscore", KEYS[2], "(" .. string.format("%.0f", now)')
    expect(script.indexOf('local now = now_ms()')).toBeLessThan(
      script.indexOf('local pruned = prune_expired(now, pruneLimit)')
    )
    expect(script.indexOf('local pruned = prune_expired(now, pruneLimit)')).toBeLessThan(
      script.indexOf('local members = redis.call(')
    )
  })

  it.each([
    ['stale expiry', encodedIntent(identity(), NOW - NATIVE_RETURN_INTENT_TTL_MS), NOW],
    [
      'wrong execution region',
      encodedIntent(identity(), NOW, NATIVE_RETURN_INTENT_TTL_MS, {
        executionRegion: 'vps_sg',
      }),
      NOW + NATIVE_RETURN_INTENT_TTL_MS,
    ],
    [
      'wrong payload region',
      encodedIntent(identity(), NOW, NATIVE_RETURN_INTENT_TTL_MS, {
        region: 'vps_sg',
        executionRegion: 'vps_sg',
      }),
      NOW + NATIVE_RETURN_INTENT_TTL_MS,
    ],
    ['score mismatch', encodedIntent(), NOW + NATIVE_RETURN_INTENT_TTL_MS + 1],
    [
      'future server time',
      encodedIntent(identity(), NOW + 1),
      NOW + 1 + NATIVE_RETURN_INTENT_TTL_MS,
    ],
    [
      'extra payload property',
      encodedIntent(identity(), NOW, NATIVE_RETURN_INTENT_TTL_MS, { secret: 'do-not-leak' }),
      NOW + NATIVE_RETURN_INTENT_TTL_MS,
    ],
  ])('fails closed on malformed or non-fresh read record: %s', async (_label, raw, score) => {
    const redis = redisResult([
      NATIVE_RETURN_INTENT_CONTRACT,
      'ok',
      NOW,
      0,
      nativeReturnIntentField('local', NODE, BOOT_A),
      score,
      raw,
    ])
    await expect(readFreshNativeReturnIntents({ redis, targetRegion: 'local' })).rejects.toEqual(
      expectCode('read_result_malformed')
    )
  })

  it('fails closed on target read overflow and invalid read parameters', async () => {
    const overflow = redisResult([NATIVE_RETURN_INTENT_CONTRACT, 'overflow', NOW, 0])
    await expect(
      readFreshNativeReturnIntents({ redis: overflow, targetRegion: 'local' })
    ).rejects.toEqual(expectCode('read_result_malformed'))

    for (const options of [
      { readLimit: 0, redis: overflow, targetRegion: 'local' },
      { pruneLimit: 513, redis: overflow, targetRegion: 'local' },
      { redis: overflow, targetRegion: 'unknown' },
    ]) {
      await expect(readFreshNativeReturnIntents(options as never)).rejects.toEqual(
        expectCode('parameters_malformed')
      )
    }
  })

  it('rejects an immutable identity change for the same live boot', async () => {
    const redis = new InMemoryScriptRedis()
    await publishNativeReturnIntent({ identity: identity(), redis })
    await expect(
      publishNativeReturnIntent({ identity: identity({ pid: 9999 }), redis })
    ).rejects.toEqual(expectCode('publish_rejected'))
  })

  it('uses a Lua compare-exact boot removal over both hash and expiry index', async () => {
    const redis = redisResult([NATIVE_RETURN_INTENT_CONTRACT, 'removed', NOW])
    await expect(
      removeNativeReturnIntent({ boot_id: BOOT_A, node: NODE, redis, region: 'local' })
    ).resolves.toBe(true)

    const [script, keyCount, ...args] = redis.eval.mock.calls[0] as [string, number, ...string[]]
    expect(keyCount).toBe(2)
    expect(args).toEqual([
      NATIVE_RETURN_INTENT_HASH_KEY,
      NATIVE_RETURN_INTENT_EXPIRY_KEY,
      NATIVE_RETURN_INTENT_CONTRACT,
      'local',
      NODE,
      BOOT_A,
    ])
    expect(script).toContain('record.boot_id ~= ARGV[4]')
    expect(script).toContain('redis.call("hdel", KEYS[1], field)')
    expect(script).toContain('redis.call("zrem", KEYS[2], field)')
  })

  it.each([
    { boot_id: 'not-a-uuid', node: NODE, region: 'local' },
    { boot_id: BOOT_A, node: 'node/escape', region: 'local' },
    { boot_id: BOOT_A, node: NODE, region: 'unknown' },
    { boot_id: BOOT_A, extra: true, node: NODE, region: 'local' },
  ])('strictly rejects malformed exact-boot removal parameters', async (values) => {
    const redis = redisResult([NATIVE_RETURN_INTENT_CONTRACT, 'removed', NOW])
    await expect(removeNativeReturnIntent({ ...values, redis } as never)).rejects.toEqual(
      expectCode('parameters_malformed')
    )
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it.each([
    ['publish', () => publishNativeReturnIntent({ identity: identity(), redis: throwingRedis() })],
    ['read', () => readFreshNativeReturnIntents({ redis: throwingRedis(), targetRegion: 'local' })],
    [
      'remove',
      () =>
        removeNativeReturnIntent({
          boot_id: BOOT_A,
          node: NODE,
          redis: throwingRedis(),
          region: 'local',
        }),
    ],
  ])('sanitizes %s Redis failures without leaking command or payload', async (operation, run) => {
    await expect(run()).rejects.toEqual(expectCode(`${operation}_redis_failed`))
    await expect(run()).rejects.not.toThrow('do-not-leak')
  })

  it.each([
    ['publish', ['OK']],
    ['publish', [NATIVE_RETURN_INTENT_CONTRACT, 'invalid', NOW, 0]],
    ['publish', [...publishResult().slice(0, 6), 129]],
    ['read', ['OK']],
    ['read', [NATIVE_RETURN_INTENT_CONTRACT, 'invalid', NOW, 0]],
    ['read', [NATIVE_RETURN_INTENT_CONTRACT, 'ok', 'not-time', 0]],
    ['remove', ['OK']],
    ['remove', [NATIVE_RETURN_INTENT_CONTRACT, 'invalid', NOW]],
    ['remove', [NATIVE_RETURN_INTENT_CONTRACT, 'removed', 0]],
  ])('rejects malformed %s script results', async (operation, result) => {
    const redis = redisResult(result)
    const run =
      operation === 'publish'
        ? publishNativeReturnIntent({ identity: identity(), redis })
        : operation === 'read'
          ? readFreshNativeReturnIntents({ redis, targetRegion: 'local' })
          : removeNativeReturnIntent({ boot_id: BOOT_A, node: NODE, redis, region: 'local' })
    await expect(run).rejects.toEqual(expectCode(`${operation}_result_malformed`))
  })
})

function throwingRedis(): NativeReturnIntentRedis {
  return {
    eval: jest.fn(async () => {
      throw new Error(`do-not-leak:${RELEASE_ID}`)
    }),
  }
}
