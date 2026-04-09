/**
 * trader-response-cache tests
 *
 * Covers the core contract the helper promises to enrichment fetchers:
 * - Cache hits skip the fetcher
 * - Concurrent getOrFetch() calls share a single in-flight promise
 * - TTL expiration triggers re-fetch
 * - Failed fetches are NOT cached and propagate to callers
 * - FIFO eviction bounds the cache at maxEntries
 *
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { createTraderResponseCache } from '../trader-response-cache'

describe('createTraderResponseCache', () => {
  describe('getOrFetch', () => {
    it('returns fetcher result on cold cache', async () => {
      const cache = createTraderResponseCache<string>({ name: 'test' })
      const fetcher = jest.fn().mockResolvedValue('hello')
      const result = await cache.getOrFetch('key1', fetcher)
      expect(result).toBe('hello')
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('returns cached value on warm cache without invoking fetcher', async () => {
      const cache = createTraderResponseCache<number>({ name: 'test' })
      const fetcher = jest.fn().mockResolvedValue(42)
      await cache.getOrFetch('key1', fetcher)
      const result = await cache.getOrFetch('key1', fetcher)
      expect(result).toBe(42)
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('deduplicates concurrent callers to a single in-flight fetch', async () => {
      const cache = createTraderResponseCache<string>({ name: 'test' })
      let resolveFn: (v: string) => void = () => {}
      const fetcher = jest.fn().mockImplementation(
        () => new Promise<string>((resolve) => { resolveFn = resolve })
      )

      const p1 = cache.getOrFetch('key1', fetcher)
      const p2 = cache.getOrFetch('key1', fetcher)
      const p3 = cache.getOrFetch('key1', fetcher)

      resolveFn('shared-value')

      const [r1, r2, r3] = await Promise.all([p1, p2, p3])
      expect(r1).toBe('shared-value')
      expect(r2).toBe('shared-value')
      expect(r3).toBe('shared-value')
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('expires cached entries after ttlMs', async () => {
      const cache = createTraderResponseCache<number>({ name: 'test', ttlMs: 50 })
      const fetcher = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
      const first = await cache.getOrFetch('key1', fetcher)
      await new Promise((r) => setTimeout(r, 80))
      const second = await cache.getOrFetch('key1', fetcher)
      expect(first).toBe(1)
      expect(second).toBe(2)
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('does not cache failures — next caller retries', async () => {
      const cache = createTraderResponseCache<string>({ name: 'test' })
      const fetcher = jest.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce('ok')

      await expect(cache.getOrFetch('key1', fetcher)).rejects.toThrow('transient')
      const second = await cache.getOrFetch('key1', fetcher)
      expect(second).toBe('ok')
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('propagates errors to all concurrent callers', async () => {
      const cache = createTraderResponseCache<string>({ name: 'test' })
      const fetcher = jest.fn().mockRejectedValue(new Error('boom'))
      const p1 = cache.getOrFetch('key1', fetcher)
      const p2 = cache.getOrFetch('key1', fetcher)
      await expect(p1).rejects.toThrow('boom')
      await expect(p2).rejects.toThrow('boom')
      expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('uses independent keys for independent requests', async () => {
      const cache = createTraderResponseCache<string>({ name: 'test' })
      const fetcher = jest.fn().mockImplementation(async (k?: string) => `value-${k}`)
      const a = await cache.getOrFetch('a', () => fetcher('a'))
      const b = await cache.getOrFetch('b', () => fetcher('b'))
      expect(a).toBe('value-a')
      expect(b).toBe('value-b')
      expect(fetcher).toHaveBeenCalledTimes(2)
    })
  })

  describe('FIFO eviction', () => {
    it('bounds the cache at maxEntries with oldest-first eviction', async () => {
      const cache = createTraderResponseCache<number>({ name: 'test', maxEntries: 3 })
      const fetcher = jest.fn().mockImplementation(async (n: number) => n)

      await cache.getOrFetch('k1', () => fetcher(1))
      await cache.getOrFetch('k2', () => fetcher(2))
      await cache.getOrFetch('k3', () => fetcher(3))
      expect(cache.size()).toBe(3)

      // Inserting k4 evicts k1 (oldest)
      await cache.getOrFetch('k4', () => fetcher(4))
      expect(cache.size()).toBe(3)
      expect(cache.get('k1')).toBeUndefined()
      expect(cache.get('k2')).toBe(2)
      expect(cache.get('k3')).toBe(3)
      expect(cache.get('k4')).toBe(4)
    })
  })

  describe('clear', () => {
    it('drops all entries', async () => {
      const cache = createTraderResponseCache<number>({ name: 'test' })
      await cache.getOrFetch('k1', async () => 1)
      await cache.getOrFetch('k2', async () => 2)
      expect(cache.size()).toBe(2)
      cache.clear()
      expect(cache.size()).toBe(0)
      expect(cache.get('k1')).toBeUndefined()
    })
  })

  describe('get', () => {
    it('returns undefined for missing keys', () => {
      const cache = createTraderResponseCache<string>({ name: 'test' })
      expect(cache.get('missing')).toBeUndefined()
    })

    it('returns undefined after TTL expires and evicts the entry', async () => {
      const cache = createTraderResponseCache<string>({ name: 'test', ttlMs: 30 })
      await cache.getOrFetch('k1', async () => 'hit')
      expect(cache.get('k1')).toBe('hit')
      await new Promise((r) => setTimeout(r, 60))
      expect(cache.get('k1')).toBeUndefined()
    })
  })
})
