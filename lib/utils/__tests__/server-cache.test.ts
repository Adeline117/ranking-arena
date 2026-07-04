/**
 * server-cache — 服务端内存缓存(API 响应去重的实例级缓存)。
 * TTL 过期、前缀失效、withCache 包装器的命中/穿透语义。
 */
import {
  getServerCache,
  setServerCache,
  deleteServerCache,
  deleteServerCacheByPrefix,
  clearServerCache,
  getServerCacheStats,
  withCache,
  CacheTTL,
} from '../server-cache'

beforeEach(() => {
  clearServerCache()
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-07-03T00:00:00Z'))
})
afterEach(() => jest.useRealTimers())

describe('get/set + TTL', () => {
  it('set 后 get 命中', () => {
    setServerCache('k', { v: 1 })
    expect(getServerCache('k')).toEqual({ v: 1 })
  })

  it('TTL 过期 → null 且条目被删', () => {
    setServerCache('k', 'data', 1000)
    jest.advanceTimersByTime(1001)
    expect(getServerCache('k')).toBeNull()
    expect(getServerCacheStats().size).toBe(0) // 惰性删除
  })

  it('TTL 内不过期(边界:恰好 = ttl 仍有效)', () => {
    setServerCache('k', 'data', 1000)
    jest.advanceTimersByTime(1000)
    expect(getServerCache('k')).toBe('data') // > ttl 才过期
  })

  it('未知 key → null', () => {
    expect(getServerCache('ghost')).toBeNull()
  })
})

describe('删除操作', () => {
  it('deleteServerCache 精确删除', () => {
    setServerCache('a', 1)
    setServerCache('b', 2)
    deleteServerCache('a')
    expect(getServerCache('a')).toBeNull()
    expect(getServerCache('b')).toBe(2)
  })

  it('deleteServerCacheByPrefix 批量失效', () => {
    setServerCache('posts:1', 1)
    setServerCache('posts:2', 2)
    setServerCache('users:1', 3)
    deleteServerCacheByPrefix('posts:')
    expect(getServerCacheStats().keys).toEqual(['users:1'])
  })
})

describe('withCache 包装器', () => {
  it('未命中 → 执行 fn 并缓存;命中 → 不再执行 fn', async () => {
    const fn = jest.fn().mockResolvedValue('computed')
    expect(await withCache('k', fn)).toBe('computed')
    expect(await withCache('k', fn)).toBe('computed')
    expect(fn).toHaveBeenCalledTimes(1) // 第二次命中缓存
  })

  it('fn 抛错 → 不缓存错误,下次重试', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok')
    await expect(withCache('k', fn)).rejects.toThrow('boom')
    expect(await withCache('k', fn)).toBe('ok') // 错误没被缓存
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('自定义 ttl 生效', async () => {
    const fn = jest.fn().mockResolvedValue('v')
    await withCache('k', fn, 500)
    jest.advanceTimersByTime(501)
    await withCache('k', fn, 500)
    expect(fn).toHaveBeenCalledTimes(2) // 过期后重算
  })
})

describe('CacheTTL 预设', () => {
  it('档位数值锁定', () => {
    expect(CacheTTL.SHORT).toBe(60_000)
    expect(CacheTTL.MEDIUM).toBe(300_000)
    expect(CacheTTL.LONG).toBe(900_000)
    expect(CacheTTL.HOUR).toBe(3_600_000)
  })
})
