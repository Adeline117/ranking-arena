/** @jest-environment node */

/**
 * The real redis-client, cache index, tiered layer and write fence against an
 * Upstash SDK whose every command fails — the 2026-11-27 production state.
 */

import { REDIS_CIRCUIT_COOLDOWN_MS } from '../redis-circuit'

type Loaded = {
  client: typeof import('../redis-client')
  cache: typeof import('../index')
  layer: typeof import('../redis-layer')
  fence: typeof import('../write-fence')
  circuit: typeof import('../redis-circuit')
}

const commandNames = ['get', 'set', 'del', 'smembers', 'eval', 'ping', 'mget'] as const
type CommandName = (typeof commandNames)[number]

function fakeSdk() {
  const calls: string[] = []
  let down = true
  const command = (name: string) =>
    jest.fn(async () => {
      calls.push(name)
      if (down) throw new Error('fetch failed')
      return name === 'ping' ? 'PONG' : null
    })
  const commands = Object.fromEntries(commandNames.map((n) => [n, command(n)])) as Record<
    CommandName,
    jest.Mock
  >
  const exec = command('exec')
  const instance = {
    ...commands,
    pipeline: jest.fn(() => {
      const pipeline = { set: jest.fn(), sadd: jest.fn(), expire: jest.fn(), exec }
      return pipeline
    }),
  }
  return {
    Redis: jest.fn(() => instance),
    calls,
    recover: () => {
      down = false
    },
  }
}

async function load(sdk: ReturnType<typeof fakeSdk>): Promise<Loaded> {
  let loaded!: Loaded
  await jest.isolateModulesAsync(async () => {
    jest.unmock('@/lib/cache/redis-client')
    jest.doMock('@upstash/redis', () => ({ Redis: sdk.Redis }))
    jest.doMock('@/lib/utils/logger', () => {
      const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      return {
        dataLogger: logger,
        createLogger: () => logger,
        fireAndForget: jest.fn(),
        getCorrelationId: () => undefined,
      }
    })
    jest.doMock('@/lib/alerts/send-alert', () => ({ sendRateLimitedAlert: jest.fn() }))
    // The real memory cache starts a cleanup interval that outlives the test.
    jest.doMock('@/lib/cache/memory-fallback', () => {
      const store = new Map<string, unknown>()
      const memory = {
        get: (key: string) => store.get(key) ?? null,
        set: (key: string, value: unknown) => void store.set(key, value),
        delete: (key: string) => store.delete(key),
        deleteByPrefix: () => 0,
        getStats: () => ({ size: store.size, maxSize: 0 }),
      }
      return { getMemoryCache: () => memory }
    })
    loaded = {
      circuit: await import('../redis-circuit'),
      client: await import('../redis-client'),
      cache: await import('../index'),
      layer: await import('../redis-layer'),
      fence: await import('../write-fence'),
    }
    // The SDK is imported lazily on first use; do it inside this registry so
    // each test talks to its own fake.
    await loaded.client.getSharedRedis()
  })
  return loaded
}

describe('shared Redis client behind the circuit breaker', () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN
  let now = 2_000_000

  beforeEach(() => {
    now = 2_000_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
  })

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken
  })

  it('pays for one failed Redis call, then serves the fenced board read without Redis', async () => {
    const sdk = fakeSdk()
    const { cache } = await load(sdk)
    const fetcher = jest.fn(async () => ['row'])
    const options = { ttl: 60, writeFenceKey: 'fence:traders' }

    await expect(cache.getOrSetWithLock('traders:90D', fetcher, options)).resolves.toEqual(['row'])
    // Before the breaker this request sent three: fence read, lock, fence re-read.
    expect(sdk.calls).toEqual(['set'])

    now += 10_000 // past the 5 s degraded-local window, still inside the cooldown
    await expect(cache.getOrSetWithLock('traders:90D', fetcher, options)).resolves.toEqual(['row'])
    expect(sdk.calls).toEqual(['set'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps required calls throwing while the circuit is open, as they do when Redis fails', async () => {
    const sdk = fakeSdk()
    const { layer, fence, client } = await load(sdk)
    const lease = { keys: ['lease:a'], ownerToken: 'owner' }

    // Redis reachable-but-failing (circuit still closed): the SDK error surfaces.
    await expect(layer.tieredGetRequired('marker')).rejects.toThrow('fetch failed')
    expect(sdk.calls).toEqual(['get'])
    expect(client.isRedisAvailable()).toBe(false)

    // Circuit open: no request is sent and every required call still throws.
    await expect(layer.tieredGetRequired('marker')).rejects.toThrow(
      'Required Redis cache read unavailable for marker'
    )
    await expect(layer.tieredSetRequired('marker', { v: 1 })).rejects.toThrow(
      'Required Redis cache write unavailable for marker'
    )
    await expect(layer.tieredSetRequired('marker', { v: 1 }, 'warm', ['t'])).rejects.toThrow(
      'Required Redis cache write unavailable for marker'
    )
    await expect(layer.tieredDelByTagStrict('rankings')).rejects.toThrow(
      'Required Redis tag invalidation unavailable for rankings'
    )
    await expect(
      fence.advanceSharedCacheWriteFenceAndDeleteTag('fence:traders', 'rankings', lease)
    ).rejects.toThrow('Required Redis cache write fence unavailable for fence:traders')
    expect(sdk.calls).toEqual(['get'])
  })

  it('stops a client reference captured before the failure from sending more requests', async () => {
    const sdk = fakeSdk()
    const { client, circuit } = await load(sdk)
    const held = await client.getSharedRedis()
    if (!held) throw new Error('expected a client')

    await expect(held.get('a')).rejects.toThrow('fetch failed')
    await expect(held.get('b')).rejects.toBeInstanceOf(circuit.RedisCircuitOpenError)
    await expect(held.pipeline().exec()).rejects.toBeInstanceOf(circuit.RedisCircuitOpenError)
    await expect(held.eval('return 1', [], [])).rejects.toBeInstanceOf(
      circuit.RedisCircuitOpenError
    )
    expect(sdk.calls).toEqual(['get'])
    await expect(client.getSharedRedis()).resolves.toBeNull()
  })

  it('sends one probe after the cooldown and resumes when Redis answers', async () => {
    const sdk = fakeSdk()
    const { client, circuit } = await load(sdk)
    const first = await client.getSharedRedis()
    await expect(first?.get('a')).rejects.toThrow('fetch failed')

    // Still down at the first probe: one request, cooldown restarts.
    now += REDIS_CIRCUIT_COOLDOWN_MS
    const probing = await client.getSharedRedis()
    if (!probing) throw new Error('expected a client for the probe')
    const [probe, bystander] = await Promise.allSettled([probing.get('a'), probing.get('b')])
    expect(probe).toMatchObject({ status: 'rejected', reason: new Error('fetch failed') })
    expect(bystander).toMatchObject({ status: 'rejected' })
    expect((bystander as PromiseRejectedResult).reason).toBeInstanceOf(
      circuit.RedisCircuitOpenError
    )
    expect(sdk.calls).toEqual(['get', 'get'])
    await expect(client.getSharedRedis()).resolves.toBeNull()

    // Recovered at the second probe: the circuit closes for everyone.
    sdk.recover()
    now += REDIS_CIRCUIT_COOLDOWN_MS
    const recovered = await client.getSharedRedis()
    await expect(recovered?.get('a')).resolves.toBeNull()
    await expect(recovered?.get('b')).resolves.toBeNull()
    expect(client.isRedisAvailable()).toBe(true)
    expect(sdk.calls).toEqual(['get', 'get', 'get', 'get'])
  })
})
