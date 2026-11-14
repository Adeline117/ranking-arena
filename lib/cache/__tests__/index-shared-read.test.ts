/**
 * @jest-environment node
 */

const mockMemoryGet = jest.fn()
const mockMemorySet = jest.fn()
const mockGetSharedRedis = jest.fn()

jest.mock('@/lib/cache/memory-fallback', () => ({
  getMemoryCache: () => ({
    get: (...args: unknown[]) => mockMemoryGet(...args),
    set: (...args: unknown[]) => mockMemorySet(...args),
  }),
}))

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
  recordRedisError: jest.fn(),
  isRedisAvailable: jest.fn(() => true),
  pingRedis: jest.fn(async () => true),
}))

jest.mock('@/lib/utils/logger', () => ({
  dataLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

import {
  get,
  getOrSetWithLock,
  readSharedCacheWriteFenceWithEntries,
  resetLocalLoadStateForTests,
} from '../index'

describe('shared cache reads', () => {
  beforeEach(() => {
    resetLocalLoadStateForTests()
    jest.clearAllMocks()
    mockMemoryGet.mockReturnValue('stale-process-value')
  })

  it('bypasses and does not backfill process memory when skipMemory is set', async () => {
    const redis = { get: jest.fn().mockResolvedValue('fresh-shared-value') }
    mockGetSharedRedis.mockResolvedValue(redis)

    await expect(get('rankings', { skipMemory: true })).resolves.toBe('fresh-shared-value')
    expect(mockMemoryGet).not.toHaveBeenCalled()
    expect(mockMemorySet).not.toHaveBeenCalled()
    expect(redis.get).toHaveBeenCalledWith('rankings')
  })

  it('keeps every locked double-check shared and fetches from source without Redis', async () => {
    mockGetSharedRedis.mockResolvedValue(null)
    const fetcher = jest.fn().mockResolvedValue('fresh-database-value')

    await expect(
      getOrSetWithLock('rankings', fetcher, {
        ttl: 300,
        skipMemory: true,
        ttlJitter: false,
      })
    ).resolves.toBe('fresh-database-value')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mockMemoryGet).not.toHaveBeenCalled()
    expect(mockMemorySet).not.toHaveBeenCalled()
  })

  it('does not let a local value win either locked Redis read', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    }
    mockGetSharedRedis.mockResolvedValue(redis)
    const fetcher = jest.fn().mockResolvedValue('fresh-database-value')

    await expect(
      getOrSetWithLock('rankings', fetcher, {
        ttl: 300,
        skipMemory: true,
        ttlJitter: false,
      })
    ).resolves.toBe('fresh-database-value')

    expect(redis.get).toHaveBeenCalledTimes(2)
    expect(mockMemoryGet).not.toHaveBeenCalled()
    expect(mockMemorySet).not.toHaveBeenCalled()

    const lockOwner = redis.set.mock.calls[0][1]
    expect(lockOwner).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      )
    )
    expect(redis.set.mock.calls[0][0]).toBe('lock:rankings')
    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(redis.eval.mock.calls[0][2][4]).toBe(lockOwner)
    expect(redis.eval.mock.calls[1][2]).toEqual([lockOwner])
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('does not read or write a shared payload when the publication fence is unavailable', async () => {
    const fenceKey = 'public-rankings:write-fence:v1'
    const redis = {
      get: jest.fn(),
      set: jest.fn(async (key: string) => {
        if (key === fenceKey) throw new Error('fence read unavailable')
        return 'OK'
      }),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    }
    mockGetSharedRedis.mockResolvedValue(redis)
    mockMemoryGet.mockReturnValue('stale-process-value')
    const fetcher = jest.fn().mockResolvedValue('fresh-database-value')

    await expect(
      getOrSetWithLock('rankings', fetcher, {
        ttl: 300,
        skipMemory: true,
        ttlJitter: false,
        writeFenceKey: fenceKey,
      })
    ).resolves.toBe('fresh-database-value')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.set.mock.calls.map(([key]) => key)).toEqual([
      fenceKey,
      'lock:rankings:fence:unavailable',
    ])
    // The only eval is owner-checked lock release. No fenced payload SET ran.
    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(redis.eval.mock.calls[0][0]).not.toContain("redis.call('SADD'")
    expect(redis.del).not.toHaveBeenCalled()
    expect(mockMemoryGet).not.toHaveBeenCalled()
    expect(mockMemorySet).not.toHaveBeenCalled()
  })

  it('propagates an application fetch error after one call and owner-checked lock release', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn(),
    }
    mockGetSharedRedis.mockResolvedValue(redis)
    const fetcher = jest.fn().mockRejectedValue(new Error('database query failed'))

    await expect(
      getOrSetWithLock('rankings', fetcher, {
        skipMemory: true,
        ttlJitter: false,
      })
    ).rejects.toThrow('database query failed')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(redis.eval).toHaveBeenCalledTimes(1)
    expect(redis.eval.mock.calls[0][0]).not.toContain("redis.call('SADD'")
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('recaptures once and refetches when publication advances during the source read', async () => {
    const fenceKey = 'public-rankings:write-fence:v1'
    const fenceTokens = ['generation-one', 'generation-two', 'generation-two']
    let guardedCommits = 0
    const redis = {
      get: jest.fn(async (key: string) =>
        key === fenceKey ? (fenceTokens.shift() ?? 'generation-two') : null
      ),
      set: jest.fn(async (key: string) => (key === fenceKey ? null : 'OK')),
      eval: jest.fn(async (script: string) => {
        if (script.includes("redis.call('SADD'")) {
          guardedCommits += 1
          return guardedCommits === 1 ? 0 : 1
        }
        return 1
      }),
      del: jest.fn(),
    }
    mockGetSharedRedis.mockResolvedValue(redis)
    const fetcher = jest
      .fn<Promise<string>, []>()
      .mockResolvedValueOnce('pre-publication-row')
      .mockResolvedValueOnce('sealed-row')

    await expect(
      getOrSetWithLock('rankings', fetcher, {
        skipMemory: true,
        ttlJitter: false,
        writeFenceKey: fenceKey,
      })
    ).resolves.toBe('sealed-row')

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(guardedCommits).toBe(2)
    expect(redis.set.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        'lock:rankings:fence:generation-one',
        'lock:rankings:fence:generation-two',
      ])
    )
    expect(redis.del).not.toHaveBeenCalled()
  })
})

describe('readSharedCacheWriteFenceWithEntries', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetLocalLoadStateForTests()
  })

  function txRedis(execResult: unknown[] | Error) {
    const tx = {
      set: jest.fn(),
      mget: jest.fn(),
      exec: jest.fn(async () => {
        if (execResult instanceof Error) throw execResult
        return execResult
      }),
    }
    return { redis: { multi: jest.fn(() => tx) }, tx }
  }

  it('bootstraps the fence and reads it with the entries in one atomic MGET', async () => {
    const envelope = { data: { rows: 1 }, tier: 'warm', cachedAt: 1, expiresAt: 2 }
    const { redis, tx } = txRedis(['OK', ['fence-token', envelope, null]])
    mockGetSharedRedis.mockResolvedValue(redis)

    const result = await readSharedCacheWriteFenceWithEntries('fence:v1', ['primary', 'fallback'])

    expect(redis.multi).toHaveBeenCalledTimes(1)
    expect(tx.set).toHaveBeenCalledWith('fence:v1', expect.any(String), { nx: true })
    expect(tx.mget).toHaveBeenCalledWith('fence:v1', 'primary', 'fallback')
    expect(result).toEqual({
      fence: { key: 'fence:v1', token: 'fence-token' },
      entries: [{ rows: 1 }, null],
    })
    expect(mockMemorySet).not.toHaveBeenCalled()
  })

  it('returns no fence and no entries when Redis is unavailable, errors, or the fence is invalid', async () => {
    mockGetSharedRedis.mockResolvedValue(null)
    await expect(readSharedCacheWriteFenceWithEntries('fence:v1', ['a'])).resolves.toEqual({
      fence: null,
      entries: [null],
    })

    mockGetSharedRedis.mockResolvedValue(txRedis(new Error('down')).redis)
    await expect(readSharedCacheWriteFenceWithEntries('fence:v1', ['a'])).resolves.toEqual({
      fence: null,
      entries: [null],
    })

    mockGetSharedRedis.mockResolvedValue(txRedis(['OK', [42, 'cached']]).redis)
    await expect(readSharedCacheWriteFenceWithEntries('fence:v1', ['a'])).resolves.toEqual({
      fence: null,
      entries: [null],
    })
  })
})

describe('getOrSetWithLock degraded-Redis protection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetLocalLoadStateForTests()
    mockMemoryGet.mockReturnValue(null)
  })

  function lockFailingRedis() {
    return {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn(async () => {
        throw new Error('upstash unavailable')
      }),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    }
  }

  it('single-flights concurrent loads of the same key within one instance', async () => {
    mockGetSharedRedis.mockResolvedValue(lockFailingRedis())
    let release: (value: string) => void = () => undefined
    const fetcher = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        })
    )

    const loads = Promise.all([
      getOrSetWithLock('hot-key', fetcher, { ttl: 300, skipMemory: true }),
      getOrSetWithLock('hot-key', fetcher, { ttl: 300, skipMemory: true }),
      getOrSetWithLock('hot-key', fetcher, { ttl: 300, skipMemory: true }),
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    release('db-value')

    await expect(loads).resolves.toEqual(['db-value', 'db-value', 'db-value'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('serves a short-lived local copy while Redis lock calls keep failing', async () => {
    mockGetSharedRedis.mockResolvedValue(lockFailingRedis())
    const fetcher = jest.fn().mockResolvedValue('db-value')

    await getOrSetWithLock('degraded-key', fetcher, { ttl: 300, skipMemory: true })
    await getOrSetWithLock('degraded-key', fetcher, { ttl: 300, skipMemory: true })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not use the degraded local copy once it expires', async () => {
    mockGetSharedRedis.mockResolvedValue(lockFailingRedis())
    const fetcher = jest.fn().mockResolvedValue('db-value')
    const realNow = Date.now
    await getOrSetWithLock('expiring-key', fetcher, { ttl: 300, skipMemory: true })
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 6_000)
    await getOrSetWithLock('expiring-key', fetcher, { ttl: 300, skipMemory: true })
    jest.spyOn(Date, 'now').mockRestore()

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('reuses a lock-timeout fallback load instead of re-running the fetcher unlocked', async () => {
    // The lock is held elsewhere (slow query) and never released.
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(null),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    }
    mockGetSharedRedis.mockResolvedValue(redis)
    const fetcher = jest.fn().mockResolvedValue('db-value')
    const opts = { ttl: 300, skipMemory: true, maxWaitMs: 5, retryDelayMs: 1 }

    await expect(getOrSetWithLock('timeout-key', fetcher, opts)).resolves.toBe('db-value')
    await expect(getOrSetWithLock('timeout-key', fetcher, opts)).resolves.toBe('db-value')

    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
