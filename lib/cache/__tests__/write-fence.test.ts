/**
 * @jest-environment node
 */

const mockGetSharedRedis = jest.fn()
const mockMemoryDelete = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

jest.mock('@/lib/cache/memory-fallback', () => ({
  getMemoryCache: () => ({
    delete: (...args: unknown[]) => mockMemoryDelete(...args),
  }),
}))

import {
  advanceSharedCacheWriteFenceAndDeleteTag,
  compareAndDeleteSharedCacheLock,
  readSharedCacheWriteFence,
  setSharedCacheEntryIfFenceMatches,
} from '../write-fence'
import { PUBLIC_RANKING_REDIS_TAG } from '@/lib/rankings/publication-policy'

const FENCE_KEY = 'public-rankings:write-fence:v1'

describe('shared cache write fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('readSharedCacheWriteFence', () => {
    it('bootstraps one opaque token and returns the value Redis actually owns', async () => {
      const values = new Map<string, string>()
      const redis = {
        set: jest.fn(async (key: string, value: string, options: { nx?: boolean }) => {
          if (options.nx && values.has(key)) return null
          values.set(key, value)
          return 'OK'
        }),
        get: jest.fn(async (key: string) => values.get(key) ?? null),
      }
      mockGetSharedRedis.mockResolvedValue(redis)

      const result = await readSharedCacheWriteFence(FENCE_KEY)
      const bootstrappedToken = redis.set.mock.calls[0][1]

      expect(redis.set).toHaveBeenCalledWith(FENCE_KEY, expect.any(String), { nx: true })
      expect(bootstrappedToken).not.toBe('')
      expect(result).toEqual({ key: FENCE_KEY, token: bootstrappedToken })
      expect(redis.get).toHaveBeenCalledWith(FENCE_KEY)
    })

    it('returns the existing owner token when another reader won bootstrap', async () => {
      const redis = {
        set: jest.fn().mockResolvedValue(null),
        get: jest.fn().mockResolvedValue('existing-generation-token'),
      }
      mockGetSharedRedis.mockResolvedValue(redis)

      await expect(readSharedCacheWriteFence(FENCE_KEY)).resolves.toEqual({
        key: FENCE_KEY,
        token: 'existing-generation-token',
      })
    })

    it('fails closed when Redis is unavailable, errors, or auto-deserializes a non-string', async () => {
      mockGetSharedRedis.mockResolvedValueOnce(null)
      await expect(readSharedCacheWriteFence(FENCE_KEY)).resolves.toBeNull()

      mockGetSharedRedis.mockResolvedValueOnce({
        set: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
      })
      await expect(readSharedCacheWriteFence(FENCE_KEY)).resolves.toBeNull()

      mockGetSharedRedis.mockResolvedValueOnce({
        set: jest.fn().mockResolvedValue(null),
        // Upstash automatically JSON-deserializes numeric-looking strings.
        get: jest.fn().mockResolvedValue(1),
      })
      await expect(readSharedCacheWriteFence(FENCE_KEY)).resolves.toBeNull()
    })
  })

  describe('advanceSharedCacheWriteFenceAndDeleteTag', () => {
    it('passes every lease owner check into one rotate-and-delete eval', async () => {
      const values = new Map<string, string>([
        ['lease:all', 'lease-owner'],
        ['lease:7D', 'lease-owner'],
        [FENCE_KEY, 'old-generation'],
        ['cache:7D', 'old-seven-day-payload'],
        ['cache:90D', 'old-ninety-day-payload'],
      ])
      const tagMembers = new Set(['cache:7D', 'cache:90D'])
      const evalCommand = jest.fn(
        async (script: string, keys: string[], args: string[]): Promise<[number, string[]]> => {
          expect(script.indexOf("redis.call('GET', KEYS[index])")).toBeLessThan(
            script.indexOf("redis.call('SMEMBERS', KEYS[2])")
          )
          expect(script.indexOf("redis.call('SMEMBERS', KEYS[2])")).toBeLessThan(
            script.indexOf("redis.call('SET', KEYS[1], ARGV[2])")
          )

          if (keys.slice(2).some((leaseKey) => values.get(leaseKey) !== args[0])) {
            return [-1, []]
          }

          const members = [...tagMembers]
          values.set(keys[0], args[1])
          for (const cacheKey of members) values.delete(cacheKey)
          tagMembers.clear()
          return [1, members]
        }
      )
      mockGetSharedRedis.mockResolvedValue({ eval: evalCommand })

      const result = await advanceSharedCacheWriteFenceAndDeleteTag(
        FENCE_KEY,
        PUBLIC_RANKING_REDIS_TAG,
        {
          keys: ['lease:all', 'lease:7D', 'lease:all'],
          ownerToken: 'lease-owner',
        }
      )
      const [, keys, args] = evalCommand.mock.calls[0]

      expect(keys).toEqual([FENCE_KEY, `tag:${PUBLIC_RANKING_REDIS_TAG}`, 'lease:all', 'lease:7D'])
      expect(args).toEqual(['lease-owner', expect.any(String)])
      expect(result).toEqual({
        fence: { key: FENCE_KEY, token: args[1] },
        deletedKeys: ['cache:7D', 'cache:90D'],
      })
      expect(values.get(FENCE_KEY)).toBe(args[1])
      expect(values.has('cache:7D')).toBe(false)
      expect(values.has('cache:90D')).toBe(false)
      expect(tagMembers.size).toBe(0)
      expect(mockMemoryDelete).toHaveBeenNthCalledWith(1, 'cache:7D')
      expect(mockMemoryDelete).toHaveBeenNthCalledWith(2, 'cache:90D')
    })

    it('rejects a replacement lease owner without rotating or deleting anything', async () => {
      const values = new Map<string, string>([
        ['lease:all', 'replacement-owner'],
        [FENCE_KEY, 'old-generation'],
        ['cache:90D', 'old-payload'],
      ])
      const tagMembers = new Set(['cache:90D'])
      const evalCommand = jest.fn(
        async (_script: string, keys: string[], args: string[]): Promise<[number, string[]]> => {
          if (keys.slice(2).some((leaseKey) => values.get(leaseKey) !== args[0])) {
            return [-1, []]
          }
          throw new Error('test harness unexpectedly authorized a stale owner')
        }
      )
      mockGetSharedRedis.mockResolvedValue({ eval: evalCommand })

      await expect(
        advanceSharedCacheWriteFenceAndDeleteTag(FENCE_KEY, PUBLIC_RANKING_REDIS_TAG, {
          keys: ['lease:all'],
          ownerToken: 'expired-owner',
        })
      ).rejects.toThrow('lease ownership was lost')

      expect(values.get(FENCE_KEY)).toBe('old-generation')
      expect(values.get('cache:90D')).toBe('old-payload')
      expect([...tagMembers]).toEqual(['cache:90D'])
      expect(mockMemoryDelete).not.toHaveBeenCalled()
    })

    it.each([
      ['string status', ['1', []]],
      ['missing member list', [1]],
      ['auto-deserialized non-string member', [1, ['cache:7D', 1]]],
      ['boolean', true],
      ['null', null],
    ])('rejects malformed Upstash eval response: %s', async (_label, response) => {
      mockGetSharedRedis.mockResolvedValue({
        eval: jest.fn().mockResolvedValue(response),
      })

      await expect(
        advanceSharedCacheWriteFenceAndDeleteTag(FENCE_KEY, PUBLIC_RANKING_REDIS_TAG, {
          keys: ['lease:all'],
          ownerToken: 'lease-owner',
        })
      ).rejects.toThrow('invalid invalidation')
      expect(mockMemoryDelete).not.toHaveBeenCalled()
    })
  })

  describe('setSharedCacheEntryIfFenceMatches', () => {
    it('passes raw tokens and a once-serialized payload to the guarded Lua commit', async () => {
      const evalCommand = jest.fn().mockResolvedValue(1)
      const redis = { eval: evalCommand }
      const serializedEntry = JSON.stringify({ data: { rank: 1 }, tier: 'warm' })

      await expect(
        setSharedCacheEntryIfFenceMatches(
          redis as never,
          'cache:90D',
          serializedEntry,
          120,
          [PUBLIC_RANKING_REDIS_TAG, 'season:90D', PUBLIC_RANKING_REDIS_TAG, '  '],
          { key: FENCE_KEY, token: 'generation-token' },
          { key: 'lock:cache:90D', ownerToken: 'lock-owner' }
        )
      ).resolves.toBe(true)

      const [script, keys, args] = evalCommand.mock.calls[0]
      expect(script).toContain("redis.call('GET', KEYS[1])")
      expect(script).toContain("redis.call('GET', KEYS[3])")
      expect(script).toContain("redis.call('TYPE', KEYS[index]).ok")
      expect(script).toContain("redis.call('SADD', KEYS[index], KEYS[2])")
      expect(script).toContain("redis.call('TTL', KEYS[index])")
      expect(script.indexOf("redis.call('TYPE', KEYS[index]).ok")).toBeLessThan(
        script.indexOf("redis.call('SET', KEYS[2]")
      )
      expect(keys).toEqual([
        FENCE_KEY,
        'cache:90D',
        'lock:cache:90D',
        `tag:${PUBLIC_RANKING_REDIS_TAG}`,
        'tag:season:90D',
      ])
      expect(args).toEqual(['generation-token', serializedEntry, '120', '240', 'lock-owner'])
      expect(args[1]).toBe(serializedEntry)
      expect(() => JSON.parse(args[1])).not.toThrow()
    })

    it.each([
      ['numeric zero', 0],
      ['corrupt tag sentinel', -3],
      ['numeric-looking string', '1'],
      ['boolean', true],
      ['array', [1]],
      ['object', { result: 1 }],
      ['null', null],
    ])('accepts only the numeric 1 eval result, not %s', async (_label, response) => {
      const redis = { eval: jest.fn().mockResolvedValue(response) }

      await expect(
        setSharedCacheEntryIfFenceMatches(
          redis as never,
          'cache:90D',
          '{"data":[]}',
          120,
          [PUBLIC_RANKING_REDIS_TAG],
          { key: FENCE_KEY, token: 'generation-token' }
        )
      ).resolves.toBe(false)
    })

    it('requires at least one shared owner guard', async () => {
      const redis = { eval: jest.fn() }

      await expect(
        setSharedCacheEntryIfFenceMatches(redis as never, 'cache:90D', '{"data":[]}', 120, [
          PUBLIC_RANKING_REDIS_TAG,
        ])
      ).rejects.toThrow('write guard is required')
      expect(redis.eval).not.toHaveBeenCalled()
    })
  })

  describe('compareAndDeleteSharedCacheLock', () => {
    it('preserves a successor lock and deletes only the exact current owner', async () => {
      let currentOwner: string | null = 'replacement-owner'
      const evalCommand = jest.fn(
        async (script: string, keys: string[], args: string[]): Promise<number> => {
          expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]")
          expect(keys).toEqual(['lock:cache:90D'])
          if (currentOwner !== args[0]) return 0
          currentOwner = null
          return 1
        }
      )
      const redis = { eval: evalCommand }

      await expect(
        compareAndDeleteSharedCacheLock(redis as never, 'lock:cache:90D', 'expired-owner')
      ).resolves.toBe(false)
      expect(currentOwner).toBe('replacement-owner')

      await expect(
        compareAndDeleteSharedCacheLock(redis as never, 'lock:cache:90D', 'replacement-owner')
      ).resolves.toBe(true)
      expect(currentOwner).toBeNull()
    })

    it.each([
      ['numeric-looking string', '1'],
      ['boolean', true],
      ['array', [1]],
      ['null', null],
    ])('rejects non-numeric-one delete result: %s', async (_label, response) => {
      const redis = { eval: jest.fn().mockResolvedValue(response) }

      await expect(
        compareAndDeleteSharedCacheLock(redis as never, 'lock:cache:90D', 'owner')
      ).resolves.toBe(false)
    })
  })
})
