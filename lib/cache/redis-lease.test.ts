import { tryAcquireRedisLease } from './redis-lease'

class FakeRedis {
  readonly values = new Map<string, string>()

  async set(key: string, value: string, options: { nx: true; ex: number }): Promise<'OK' | null> {
    expect(options).toEqual({ nx: true, ex: expect.any(Number) })
    if (this.values.has(key)) return null
    this.values.set(key, value)
    return 'OK'
  }

  async eval(_script: string, keys: string[], args: string[]): Promise<number> {
    const [key] = keys
    const [ownerToken] = args
    if (this.values.get(key) !== ownerToken) return 0
    this.values.delete(key)
    return 1
  }
}

describe('owned Redis lease', () => {
  it('releases a lease only while its owner token still matches', async () => {
    const redis = new FakeRedis()
    const lease = await tryAcquireRedisLease(redis, 'cron:test', 60)

    expect(lease).not.toBeNull()
    expect(redis.values.get('cron:test')).toBe(lease?.token)
    await expect(lease?.release()).resolves.toBe(true)
    expect(redis.values.has('cron:test')).toBe(false)
  })

  it('does not let an expired old owner delete a newer lease', async () => {
    const redis = new FakeRedis()
    const oldLease = await tryAcquireRedisLease(redis, 'cron:test', 60)
    expect(oldLease).not.toBeNull()

    redis.values.set('cron:test', 'new-owner-token')

    await expect(oldLease?.release()).resolves.toBe(false)
    expect(redis.values.get('cron:test')).toBe('new-owner-token')
  })

  it('returns null without replacing an existing owner', async () => {
    const redis = new FakeRedis()
    redis.values.set('cron:test', 'existing-owner')

    await expect(tryAcquireRedisLease(redis, 'cron:test', 60)).resolves.toBeNull()
    expect(redis.values.get('cron:test')).toBe('existing-owner')
  })
})
