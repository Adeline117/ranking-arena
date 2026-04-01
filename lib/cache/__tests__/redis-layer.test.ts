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
  tieredSet,
  tieredGetOrSet,
  tieredDel,
  getLayerStats,
  resetLayerStats,
  CACHE_TIERS,
  CACHE_KEY_PATTERNS,
} from '../redis-layer'

describe('redis-layer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
      expect(CACHE_KEY_PATTERNS.traderDetail.keyBuilder('binance', '123')).toBe('trader:binance:123')
    })

    it('should build trader history key', () => {
      expect(CACHE_KEY_PATTERNS.traderHistory.keyBuilder('binance', '123', '30D')).toBe('trader:history:binance:123:30D')
    })
  })

  describe('tieredGet', () => {
    it('should return from memory cache on hit', async () => {
      const cached = { data: { foo: 'bar' }, tier: 'warm', cachedAt: Date.now(), expiresAt: Date.now() + 60000 }
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
      const cached = { data: 'value', tier: 'hot', cachedAt: Date.now(), expiresAt: Date.now() + 60000 }
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
  })

  describe('tieredSet', () => {
    it('should write to memory cache', async () => {
      const result = await tieredSet('key', { value: 1 }, 'hot')

      expect(result).toBe(true)
      expect(mockMemoryCache.set).toHaveBeenCalledWith(
        'key',
        expect.objectContaining({
          data: { value: 1 },
          tier: 'hot',
        }),
        CACHE_TIERS.hot.memoryTtlSeconds + CACHE_TIERS.hot.staleWhileRevalidate
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
      expect(entry.expiresAt).toBe(entry.cachedAt + (CACHE_TIERS.cold.redisTtlSeconds + CACHE_TIERS.cold.staleWhileRevalidate) * 1000)
    })
  })

  describe('tieredDel', () => {
    it('should delete from memory cache', async () => {
      await tieredDel('key-to-delete')
      expect(mockMemoryCache.delete).toHaveBeenCalledWith('key-to-delete')
    })
  })

  describe('tieredGetOrSet', () => {
    it('should return cached data without calling fetcher', async () => {
      const cached = { data: 'cached-value', tier: 'warm', cachedAt: Date.now(), expiresAt: Date.now() + 60000 }
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
      await new Promise(r => setTimeout(r, 10))
      expect(mockMemoryCache.set).toHaveBeenCalled()
    })

    it('should propagate fetcher errors', async () => {
      mockMemoryCache.get.mockReturnValue(undefined)

      const fetcher = jest.fn().mockRejectedValue(new Error('DB down'))
      await expect(tieredGetOrSet('key', fetcher)).rejects.toThrow('DB down')
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
