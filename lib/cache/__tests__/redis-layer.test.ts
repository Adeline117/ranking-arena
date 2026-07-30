/**
 * Redis 缓存分层模块测试
 *
 * 使用 mock 测试 tieredGet, tieredSet, tieredGetOrSet 的逻辑
 */

// Mock dependencies before imports
const mockMemoryCache = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
  deleteByPrefix: jest.fn(() => 0),
  getStats: jest.fn(() => ({ size: 0, maxSize: 1000 })),
}

jest.mock('@/lib/cache/memory-fallback', () => ({
  getMemoryCache: () => mockMemoryCache,
}))

jest.mock('@/lib/utils/logger', () => ({
  dataLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

// Mock redis-client to provide getSharedRedis and isRedisAvailable
jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: jest.fn().mockResolvedValue(null),
  isRedisAvailable: jest.fn().mockReturnValue(false),
  redis: null,
  getRedis: jest.fn(),
}))

// Mock Redis - not configured (no env vars)
const _originalEnv = process.env

import {
  tieredGet,
  tieredGetRequired,
  tieredSet,
  tieredSetRequired,
  tieredGetOrSet,
  tieredDel,
  tieredDelByTagStrict,
  getLayerStats,
  resetLayerStats,
  CACHE_TIERS,
  CACHE_KEY_PATTERNS,
} from '../redis-layer'
import { getSharedRedis } from '../redis-client'

describe('redis-layer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.mocked(getSharedRedis).mockResolvedValue(null)
    resetLayerStats()
    mockMemoryCache.get.mockReturnValue(undefined)
  })

  describe('CACHE_TIERS config', () => {
    it('should have hot, warm, cold tiers', () => {
      expect(CACHE_TIERS.hot).toBeDefined()
      expect(CACHE_TIERS.warm).toBeDefined()
      expect(CACHE_TIERS.cold).toBeDefined()
    })

    it('hot tier should have shortest TTL', () => {
      expect(CACHE_TIERS.hot.redisTtlSeconds).toBeLessThan(CACHE_TIERS.warm.redisTtlSeconds)
      expect(CACHE_TIERS.warm.redisTtlSeconds).toBeLessThan(CACHE_TIERS.cold.redisTtlSeconds)
    })

    it('hot tier should have highest priority', () => {
      expect(CACHE_TIERS.hot.priority).toBe(1)
      expect(CACHE_TIERS.warm.priority).toBe(2)
      expect(CACHE_TIERS.cold.priority).toBe(3)
    })
  })

  describe('CACHE_KEY_PATTERNS', () => {
    it('should build rankings key', () => {
      expect(CACHE_KEY_PATTERNS.rankings.keyBuilder('90D')).toBe('rankings:90D')
      expect(CACHE_KEY_PATTERNS.rankings.keyBuilder('90D', 'roi')).toBe('rankings:90D:roi')
    })

    it('should build trader detail key', () => {
      expect(CACHE_KEY_PATTERNS.traderDetail.keyBuilder('binance', '123')).toBe(
        'trader:binance:123'
      )
    })

    it('should build trader history key', () => {
      expect(CACHE_KEY_PATTERNS.traderHistory.keyBuilder('binance', '123', '30D')).toBe(
        'trader:history-evidence:v1:binance:123:30D'
      )
      expect(CACHE_KEY_PATTERNS.traderHistory.pattern).toBe('trader:history-evidence:v1:*')
      expect(CACHE_KEY_PATTERNS.traderHistory.keyBuilder('binance:evil', '123:456', '30D')).toBe(
        'trader:history-evidence:v1:binance%3Aevil:123%3A456:30D'
      )
      // The retired builder always starts `trader:history:`. Even its former
      // arbitrary period slot cannot manufacture the new root namespace.
      const retiredCollision = 'trader:history:binance:123:v2:30D'
      const evidenceKey = CACHE_KEY_PATTERNS.traderHistory.keyBuilder('binance', '123', '30D')
      expect(evidenceKey).not.toBe(retiredCollision)
      expect(evidenceKey).not.toMatch(/^trader:history:/)
    })
  })

  describe('tieredGet', () => {
    it('should return from memory cache on hit', async () => {
      const cached = {
        data: { foo: 'bar' },
        tier: 'warm',
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      }
      mockMemoryCache.get.mockReturnValue(cached)

      const result = await tieredGet('test-key', 'warm')
      expect(result).toEqual({ data: { foo: 'bar' }, layer: 'memory' })
      expect(mockMemoryCache.get).toHaveBeenCalledWith('test-key')
    })

    it('should return null on cache miss (no Redis configured)', async () => {
      mockMemoryCache.get.mockReturnValue(undefined)

      const result = await tieredGet('missing-key', 'warm')
      expect(result).toEqual({ data: null, layer: null })
    })

    it('should track memory hits in stats', async () => {
      const cached = {
        data: 'value',
        tier: 'hot',
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      }
      mockMemoryCache.get.mockReturnValue(cached)

      await tieredGet('key1', 'hot')
      await tieredGet('key2', 'hot')

      const stats = getLayerStats()
      expect(stats.memory.hits).toBe(2)
    })

    it('should track memory misses in stats', async () => {
      mockMemoryCache.get.mockReturnValue(undefined)

      await tieredGet('miss1', 'warm')

      const stats = getLayerStats()
      expect(stats.memory.misses).toBe(1)
    })

    it('should default to warm tier', async () => {
      mockMemoryCache.get.mockReturnValue(undefined)
      const result = await tieredGet('key')
      expect(result).toEqual({ data: null, layer: null })
    })

    it('does not consult either cache layer when the shared fence is unavailable', async () => {
      const redis = { get: jest.fn() }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)
      mockMemoryCache.get.mockReturnValue({
        data: 'stale-process-value',
        tier: 'hot',
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })

      await expect(
        tieredGet('rankings', 'hot', { skipMemory: true, writeFence: null })
      ).resolves.toEqual({ data: null, layer: null })

      expect(mockMemoryCache.get).not.toHaveBeenCalled()
      expect(getSharedRedis).not.toHaveBeenCalled()
      expect(redis.get).not.toHaveBeenCalled()
    })
  })

  describe('tieredGetRequired', () => {
    it('rejects without Redis instead of trusting process-local state', async () => {
      mockMemoryCache.get.mockReturnValue({ data: { count: 99 } })

      await expect(tieredGetRequired('publication-checkpoint')).rejects.toThrow(
        'Required Redis cache read unavailable for publication-checkpoint'
      )
      expect(mockMemoryCache.get).not.toHaveBeenCalled()
    })

    it('reads the shared envelope directly without consulting process memory', async () => {
      const entry = {
        data: { count: 12 },
        tier: 'warm' as const,
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }
      const redis = { get: jest.fn().mockResolvedValue(entry) }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)

      await expect(tieredGetRequired('publication-checkpoint')).resolves.toEqual({ count: 12 })
      expect(redis.get).toHaveBeenCalledWith('publication-checkpoint')
      expect(mockMemoryCache.get).not.toHaveBeenCalled()
    })

    it('rejects an unversioned raw Redis value', async () => {
      const redis = { get: jest.fn().mockResolvedValue({ count: 12 }) }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)

      await expect(tieredGetRequired('publication-checkpoint')).rejects.toThrow(
        'Required Redis cache entry is invalid for publication-checkpoint'
      )
    })
  })

  describe('tieredSet', () => {
    it('should write to memory cache', async () => {
      const result = await tieredSet('key', { value: 1 }, 'hot')

      expect(result).toBe(true)
      // When Redis is unavailable (mock returns null), memory TTL is extended
      // to redisTtlSeconds to prevent thundering herd. When Redis is available,
      // it would be memoryTtlSeconds + staleWhileRevalidate.
      expect(mockMemoryCache.set).toHaveBeenCalledWith(
        'key',
        expect.objectContaining({
          data: { value: 1 },
          tier: 'hot',
        }),
        CACHE_TIERS.hot.redisTtlSeconds
      )
    })

    it('should include correct cache entry metadata', async () => {
      const before = Date.now()
      await tieredSet('key', 'data', 'cold')
      const after = Date.now()

      const entry = mockMemoryCache.set.mock.calls[0][1]
      expect(entry.cachedAt).toBeGreaterThanOrEqual(before)
      expect(entry.cachedAt).toBeLessThanOrEqual(after)
      // expiresAt includes SWR window: (redisTtlSeconds + staleWhileRevalidate) * 1000
      expect(entry.expiresAt).toBe(
        entry.cachedAt +
          (CACHE_TIERS.cold.redisTtlSeconds + CACHE_TIERS.cold.staleWhileRevalidate) * 1000
      )
    })
  })

  describe('tieredSetRequired', () => {
    it('rejects without Redis and does not publish only to process memory', async () => {
      await expect(
        tieredSetRequired('publication-marker', { complete: true }, 'hot')
      ).rejects.toThrow('Required Redis cache write unavailable for publication-marker')

      expect(mockMemoryCache.set).not.toHaveBeenCalled()
    })

    it('writes Redis before exposing the value through process memory', async () => {
      const order: string[] = []
      const redis = {
        set: jest.fn(async () => {
          order.push('redis')
          return 'OK'
        }),
      }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)
      mockMemoryCache.set.mockImplementation(() => {
        order.push('memory')
      })

      await tieredSetRequired('publication-marker', { complete: true }, 'hot')

      expect(redis.set).toHaveBeenCalledWith(
        'publication-marker',
        expect.objectContaining({ data: { complete: true }, tier: 'hot' }),
        { ex: CACHE_TIERS.hot.redisTtlSeconds }
      )
      expect(mockMemoryCache.set).toHaveBeenCalledWith(
        'publication-marker',
        expect.objectContaining({ data: { complete: true }, tier: 'hot' }),
        CACHE_TIERS.hot.memoryTtlSeconds + CACHE_TIERS.hot.staleWhileRevalidate
      )
      expect(order).toEqual(['redis', 'memory'])
    })

    it('does not expose a value through process memory when Redis rejects', async () => {
      const redis = {
        set: jest.fn().mockRejectedValue(new Error('redis write failed')),
      }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)

      await expect(tieredSetRequired('publication-marker', true, 'hot')).rejects.toThrow(
        'redis write failed'
      )
      expect(mockMemoryCache.set).not.toHaveBeenCalled()
    })
  })

  describe('tieredDel', () => {
    it('should delete from memory cache', async () => {
      await tieredDel('key-to-delete')
      expect(mockMemoryCache.delete).toHaveBeenCalledWith('key-to-delete')
    })
  })

  describe('tieredDelByTagStrict', () => {
    it('rejects without Redis so publication cannot claim global invalidation', async () => {
      mockMemoryCache.deleteByPrefix.mockReturnValue(2)

      await expect(tieredDelByTagStrict('rankings')).rejects.toThrow(
        'Required Redis tag invalidation unavailable for rankings'
      )
      expect(mockMemoryCache.deleteByPrefix).toHaveBeenCalledWith('tag:rankings')
    })

    it('deletes every tagged Redis and memory entry before succeeding', async () => {
      const redis = {
        smembers: jest.fn().mockResolvedValue(['rankings:7D', 'rankings:30D']),
        del: jest.fn().mockResolvedValue(3),
      }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)

      await expect(tieredDelByTagStrict('rankings')).resolves.toBe(2)

      expect(mockMemoryCache.delete).toHaveBeenNthCalledWith(1, 'rankings:7D')
      expect(mockMemoryCache.delete).toHaveBeenNthCalledWith(2, 'rankings:30D')
      expect(redis.del).toHaveBeenCalledWith('rankings:7D', 'rankings:30D', 'tag:rankings')
    })

    it('propagates Redis invalidation failures', async () => {
      const redis = {
        smembers: jest.fn().mockRejectedValue(new Error('redis read failed')),
      }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)

      await expect(tieredDelByTagStrict('rankings')).rejects.toThrow('redis read failed')
    })
  })

  describe('tieredGetOrSet', () => {
    it('should return cached data without calling fetcher', async () => {
      const cached = {
        data: 'cached-value',
        tier: 'warm',
        cachedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      }
      mockMemoryCache.get.mockReturnValue(cached)

      const fetcher = jest.fn().mockResolvedValue('fresh-value')
      const result = await tieredGetOrSet('key', fetcher, 'warm')

      expect(result).toBe('cached-value')
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('should call fetcher on cache miss and cache the result', async () => {
      mockMemoryCache.get.mockReturnValue(undefined)

      const fetcher = jest.fn().mockResolvedValue({ items: [1, 2, 3] })
      const result = await tieredGetOrSet('key', fetcher, 'hot', ['tag1'])

      expect(result).toEqual({ items: [1, 2, 3] })
      expect(fetcher).toHaveBeenCalledTimes(1)
      // tieredSet is called async, wait a tick
      await new Promise((r) => setTimeout(r, 10))
      expect(mockMemoryCache.set).toHaveBeenCalled()
    })

    it('should propagate fetcher errors', async () => {
      mockMemoryCache.get.mockReturnValue(undefined)

      const fetcher = jest.fn().mockRejectedValue(new Error('DB down'))
      await expect(tieredGetOrSet('key', fetcher)).rejects.toThrow('DB down')
    })

    it('fetches without reading or writing a payload when fence capture fails', async () => {
      const fenceKey = 'public-rankings:write-fence:v1'
      const redis = {
        get: jest.fn(),
        set: jest.fn(async (key: string) => {
          if (key === fenceKey) throw new Error('fence unavailable')
          return 'OK'
        }),
        eval: jest.fn().mockResolvedValue(1),
        del: jest.fn(),
      }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)
      const fetcher = jest.fn().mockResolvedValue('fresh-database-value')

      await expect(
        tieredGetOrSet('rankings', fetcher, 'hot', ['rankings'], {
          skipMemory: true,
          writeFenceKey: fenceKey,
        })
      ).resolves.toBe('fresh-database-value')

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(redis.get).not.toHaveBeenCalled()
      expect(redis.set.mock.calls.map(([key]) => key)).toEqual([
        fenceKey,
        'lock:rankings:fence:unavailable',
      ])
      // The only eval releases the acquired lock. The payload commit is rejected
      // before Lua because a null fence can never authorize a shared write.
      expect(redis.eval).toHaveBeenCalledTimes(1)
      expect(redis.eval.mock.calls[0][0]).not.toContain("redis.call('SADD'")
      expect(redis.del).not.toHaveBeenCalled()
      expect(mockMemoryCache.get).not.toHaveBeenCalled()
      expect(mockMemoryCache.set).not.toHaveBeenCalled()
    })

    it('awaits the owner-guarded payload commit before releasing its UUID lock', async () => {
      const fenceKey = 'public-rankings:write-fence:v1'
      const fenceToken = 'current-generation-token'
      const order: string[] = []
      let signalCommitStarted!: () => void
      const commitStarted = new Promise<void>((resolve) => {
        signalCommitStarted = resolve
      })
      let finishCommit!: (result: number) => void
      const commitGate = new Promise<number>((resolve) => {
        finishCommit = resolve
      })
      const redis = {
        get: jest.fn(async (key: string) => (key === fenceKey ? fenceToken : null)),
        set: jest.fn(async (key: string) => (key === fenceKey ? null : 'OK')),
        eval: jest.fn((script: string) => {
          if (script.includes("redis.call('SADD'")) {
            order.push('commit:start')
            signalCommitStarted()
            return commitGate.then((result) => {
              order.push('commit:end')
              return result
            })
          }
          order.push('release')
          return Promise.resolve(1)
        }),
        del: jest.fn(),
      }
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)
      const fetcher = jest.fn(async () => {
        order.push('fetch')
        return 'fresh-database-value'
      })
      let operationSettled = false

      const operation = tieredGetOrSet('rankings', fetcher, 'hot', ['rankings'], {
        skipMemory: true,
        writeFenceKey: fenceKey,
      }).then((value) => {
        operationSettled = true
        return value
      })

      await commitStarted
      expect(operationSettled).toBe(false)
      expect(order).toEqual(['fetch', 'commit:start'])
      expect(redis.eval).toHaveBeenCalledTimes(1)

      finishCommit(1)
      await expect(operation).resolves.toBe('fresh-database-value')

      const lockSet = redis.set.mock.calls.find(([key]) => key.startsWith('lock:'))
      expect(lockSet).toBeDefined()
      const lockOwner = lockSet?.[1]
      expect(lockOwner).toEqual(
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        )
      )
      expect(order).toEqual(['fetch', 'commit:start', 'commit:end', 'release'])
      expect(redis.eval).toHaveBeenCalledTimes(2)
      expect(redis.eval.mock.calls[0][2][0]).toBe(fenceToken)
      expect(redis.eval.mock.calls[0][2][4]).toBe(lockOwner)
      expect(redis.eval.mock.calls[1][2]).toEqual([lockOwner])
      expect(redis.del).not.toHaveBeenCalled()
      expect(mockMemoryCache.set).not.toHaveBeenCalled()
    })

    it('recaptures once and returns only the refetch from the sealed generation', async () => {
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
      jest.mocked(getSharedRedis).mockResolvedValue(redis as never)
      const fetcher = jest
        .fn<Promise<string>, []>()
        .mockResolvedValueOnce('pre-publication-row')
        .mockResolvedValueOnce('sealed-row')

      await expect(
        tieredGetOrSet('rankings', fetcher, 'hot', ['rankings'], {
          skipMemory: true,
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

  describe('resetLayerStats', () => {
    it('should reset all counters to zero', async () => {
      // Generate some stats
      const cached = { data: 'v', tier: 'hot', cachedAt: Date.now(), expiresAt: Date.now() + 60000 }
      mockMemoryCache.get.mockReturnValue(cached)
      await tieredGet('k', 'hot')

      resetLayerStats()
      const stats = getLayerStats()
      expect(stats.memory.hits).toBe(0)
      expect(stats.memory.misses).toBe(0)
      expect(stats.redis.hits).toBe(0)
      expect(stats.redis.misses).toBe(0)
    })
  })
})
