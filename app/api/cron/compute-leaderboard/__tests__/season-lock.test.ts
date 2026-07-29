import {
  acquireLeaderboardSeasonLocks,
  LEADERBOARD_SEASON_LOCK_TTL_SECONDS,
  type LeaderboardSeasonLockRedis,
} from '../season-lock'

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

const key = (season: string) => `cron:compute-leaderboard:running:${season}`

class FakeRedis implements LeaderboardSeasonLockRedis {
  readonly values = new Map<string, string>()
  readonly setCalls: Array<{ key: string; value: string; ex: number }> = []
  readonly evalCalls: Array<{ key: string; ownerToken: string }> = []
  throwOnSetCall: number | null = null
  throwOnEval = false

  async set(
    redisKey: string,
    value: string,
    options: { nx: true; ex: number }
  ): Promise<'OK' | null> {
    this.setCalls.push({ key: redisKey, value, ex: options.ex })
    if (this.throwOnSetCall === this.setCalls.length) {
      throw new Error('set transport failed')
    }
    if (this.values.has(redisKey)) return null
    this.values.set(redisKey, value)
    return 'OK'
  }

  async eval(_script: string, keys: string[], args: string[]): Promise<number> {
    const [redisKey] = keys
    const [ownerToken] = args
    this.evalCalls.push({ key: redisKey, ownerToken })
    if (this.throwOnEval) throw new Error('eval transport failed')
    if (this.values.get(redisKey) !== ownerToken) return 0
    this.values.delete(redisKey)
    return 1
  }
}

describe('leaderboard season lock fence', () => {
  it('uses canonical season order and makes full runs conflict with single-season runs', async () => {
    const redis = new FakeRedis()
    const full = await acquireLeaderboardSeasonLocks(redis, ['90D', '7D', '30D'], 'full-owner')
    expect(full.acquired).toBe(true)
    expect(redis.setCalls).toEqual([
      { key: key('7D'), value: 'full-owner', ex: LEADERBOARD_SEASON_LOCK_TTL_SECONDS },
      { key: key('30D'), value: 'full-owner', ex: LEADERBOARD_SEASON_LOCK_TTL_SECONDS },
      { key: key('90D'), value: 'full-owner', ex: LEADERBOARD_SEASON_LOCK_TTL_SECONDS },
    ])

    const single = await acquireLeaderboardSeasonLocks(redis, ['90D'], 'single-owner')
    expect(single).toEqual({
      acquired: false,
      reason: 'conflict',
      blockedSeason: '90D',
    })
    expect(redis.values.get(key('90D'))).toBe('full-owner')
  })

  it('compare-deletes partially acquired keys after a later conflict', async () => {
    const redis = new FakeRedis()
    redis.values.set(key('30D'), 'other-owner')

    const result = await acquireLeaderboardSeasonLocks(redis, ['7D', '30D', '90D'], 'partial-owner')

    expect(result).toEqual({
      acquired: false,
      reason: 'conflict',
      blockedSeason: '30D',
    })
    expect(redis.values.has(key('7D'))).toBe(false)
    expect(redis.values.get(key('30D'))).toBe('other-owner')
    expect(redis.values.has(key('90D'))).toBe(false)
    expect(redis.evalCalls).toEqual([{ key: key('7D'), ownerToken: 'partial-owner' }])
  })

  it('compare-deletes partially acquired keys after an acquisition exception', async () => {
    const redis = new FakeRedis()
    redis.throwOnSetCall = 2

    const result = await acquireLeaderboardSeasonLocks(redis, ['7D', '30D', '90D'], 'failed-owner')

    expect(result).toEqual({
      acquired: false,
      reason: 'redis_error',
      blockedSeason: '30D',
    })
    expect(redis.values.has(key('7D'))).toBe(false)
    expect(redis.evalCalls).toEqual([{ key: key('7D'), ownerToken: 'failed-owner' }])
  })

  it('never lets an expired old owner delete a replacement owner lease', async () => {
    const redis = new FakeRedis()
    const old = await acquireLeaderboardSeasonLocks(redis, ['90D'], 'old-owner')
    expect(old.acquired).toBe(true)
    if (!old.acquired) throw new Error('expected lock acquisition')

    // Simulate expiry followed by a new run acquiring the same key.
    redis.values.set(key('90D'), 'new-owner')
    await old.release()

    expect(redis.values.get(key('90D'))).toBe('new-owner')
    expect(redis.evalCalls).toEqual([{ key: key('90D'), ownerToken: 'old-owner' }])
  })

  it('leaves owned leases to expire when compare-and-delete itself fails', async () => {
    const redis = new FakeRedis()
    const result = await acquireLeaderboardSeasonLocks(redis, ['7D'], 'owner')
    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error('expected lock acquisition')

    redis.throwOnEval = true
    await expect(result.release()).resolves.toBeUndefined()
    expect(redis.values.get(key('7D'))).toBe('owner')
  })
})
