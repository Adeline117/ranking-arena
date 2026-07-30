/**
 * @jest-environment node
 */

const mockGetSharedRedis = jest.fn()
const mockRandomUUID = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

jest.mock('node:crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}))

import {
  acquireLeaderboardRunLease,
  LEADERBOARD_RUN_LEASE_LEGACY_KEY,
  LEADERBOARD_RUN_LEASE_SEASONS,
  LEADERBOARD_RUN_LEASE_TTL_SECONDS,
} from '../run-lease'

function redisHarness() {
  const values = new Map<string, string>()
  const del = jest.fn()
  const evalCommand = jest.fn(
    async (script: string, keys: string[], args: string[]): Promise<unknown> => {
      if (script.includes("redis.call('EXISTS'")) {
        if (keys.some((key) => values.has(key))) return 0
        for (const key of keys) values.set(key, args[0])
        return 1
      }

      if (script.includes("redis.call('GET'")) {
        let released = 0
        let conflicts = 0
        for (const key of keys) {
          const current = values.get(key)
          if (current === args[0]) {
            values.delete(key)
            released += 1
          } else if (current !== undefined) {
            conflicts += 1
          }
        }
        return [released, conflicts]
      }

      throw new Error('unexpected script')
    }
  )
  return { redis: { eval: evalCommand, del }, evalCommand, del, values }
}

const expectedLeaseKeys = [
  LEADERBOARD_RUN_LEASE_LEGACY_KEY,
  ...LEADERBOARD_RUN_LEASE_SEASONS.map((season) => `cron:compute-leaderboard:running:${season}`),
]

describe('compute-leaderboard Redis run lease', () => {
  let ownerSequence = 0

  beforeEach(() => {
    jest.clearAllMocks()
    ownerSequence = 0
    mockRandomUUID.mockImplementation(() => `owner-${++ownerSequence}`)
  })

  it('uses an owner token and a TTL longer than the route maxDuration', async () => {
    const harness = redisHarness()
    mockGetSharedRedis.mockResolvedValue(harness.redis)

    const result = await acquireLeaderboardRunLease(['30D'])

    expect(result.acquired).toBe(true)
    expect(LEADERBOARD_RUN_LEASE_TTL_SECONDS).toBeGreaterThan(300)
    expect(harness.evalCommand).toHaveBeenCalledTimes(1)
    expect(harness.evalCommand.mock.calls[0][1]).toEqual(expectedLeaseKeys)
    expect(harness.evalCommand.mock.calls[0][2]).toEqual([
      'owner-1',
      String(LEADERBOARD_RUN_LEASE_TTL_SECONDS),
    ])
    expect(harness.del).not.toHaveBeenCalled()
  })

  it('canonicalizes all-season targets and acquires every compatibility key atomically', async () => {
    const harness = redisHarness()
    mockGetSharedRedis.mockResolvedValue(harness.redis)

    const result = await acquireLeaderboardRunLease(['90D', '7D', '30D', '7D'])

    expect(result.acquired).toBe(true)
    expect(harness.evalCommand).toHaveBeenCalledTimes(1)
    expect(harness.evalCommand.mock.calls[0][1]).toEqual(expectedLeaseKeys)
    if (result.acquired) expect(result.lease.seasons).toEqual(['7D', '30D', '90D'])
  })

  it('makes an all-season lease contend with every single-season run', async () => {
    const harness = redisHarness()
    mockGetSharedRedis.mockResolvedValue(harness.redis)

    const allSeasons = await acquireLeaderboardRunLease(['7D', '30D', '90D'])
    expect(allSeasons.acquired).toBe(true)

    for (const season of LEADERBOARD_RUN_LEASE_SEASONS) {
      await expect(acquireLeaderboardRunLease([season])).resolves.toEqual({
        acquired: false,
        reason: 'contended',
      })
    }

    if (!allSeasons.acquired) throw new Error('expected lease')
    await expect(allSeasons.lease.release()).resolves.toEqual({
      released: true,
      releasedKeys: 4,
    })
    await expect(acquireLeaderboardRunLease(['30D'])).resolves.toMatchObject({ acquired: true })
  })

  it('makes a single-season lease block an overlapping all-season acquisition atomically', async () => {
    const harness = redisHarness()
    mockGetSharedRedis.mockResolvedValue(harness.redis)

    await expect(acquireLeaderboardRunLease(['30D'])).resolves.toMatchObject({ acquired: true })
    await expect(acquireLeaderboardRunLease(['7D', '30D', '90D'])).resolves.toEqual({
      acquired: false,
      reason: 'contended',
    })

    expect(harness.values.get('cron:compute-leaderboard:running:7D')).toBe('owner-1')
    expect(harness.values.get('cron:compute-leaderboard:running:30D')).toBe('owner-1')
    expect(harness.values.get('cron:compute-leaderboard:running:90D')).toBe('owner-1')
    expect(harness.values.get(LEADERBOARD_RUN_LEASE_LEGACY_KEY)).toBe('owner-1')
  })

  it('serializes disjoint single-season runs that share public cache surfaces', async () => {
    const harness = redisHarness()
    mockGetSharedRedis.mockResolvedValue(harness.redis)

    await expect(acquireLeaderboardRunLease(['7D'])).resolves.toMatchObject({ acquired: true })
    await expect(acquireLeaderboardRunLease(['30D'])).resolves.toEqual({
      acquired: false,
      reason: 'contended',
    })
  })

  it('contends with an old all-season handler during a rolling deployment', async () => {
    const harness = redisHarness()
    harness.values.set(LEADERBOARD_RUN_LEASE_LEGACY_KEY, 'legacy-instance')
    mockGetSharedRedis.mockResolvedValue(harness.redis)

    await expect(acquireLeaderboardRunLease(['90D'])).resolves.toEqual({
      acquired: false,
      reason: 'contended',
    })
    expect(harness.values).toEqual(new Map([[LEADERBOARD_RUN_LEASE_LEGACY_KEY, 'legacy-instance']]))
  })

  it('releases only keys still owned by its token and never calls ordinary DEL', async () => {
    const harness = redisHarness()
    mockGetSharedRedis.mockResolvedValue(harness.redis)
    const acquired = await acquireLeaderboardRunLease(['30D'])
    if (!acquired.acquired) throw new Error('expected lease')

    harness.values.set('cron:compute-leaderboard:running:30D', 'replacement-owner')

    await expect(acquired.lease.release()).resolves.toEqual({
      released: false,
      reason: 'owner_mismatch',
      releasedKeys: 3,
    })
    expect(harness.values.get('cron:compute-leaderboard:running:30D')).toBe('replacement-owner')
    expect(harness.del).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', []],
    ['runtime-invalid', ['7D', '180D']],
  ])('fails closed for an %s target before consulting Redis', async (_label, seasons) => {
    await expect(acquireLeaderboardRunLease(seasons as never)).resolves.toEqual({
      acquired: false,
      reason: 'invalid_target',
    })
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
  })

  it('fails closed without a Redis client and has no memory fallback', async () => {
    mockGetSharedRedis.mockResolvedValue(null)

    await expect(acquireLeaderboardRunLease(['7D'])).resolves.toEqual({
      acquired: false,
      reason: 'redis_unavailable',
    })
  })

  it('fails closed when Redis discovery or acquisition throws', async () => {
    mockGetSharedRedis.mockRejectedValueOnce(new Error('Redis discovery failed'))
    await expect(acquireLeaderboardRunLease(['7D'])).resolves.toEqual({
      acquired: false,
      reason: 'redis_error',
      error: 'Redis discovery failed',
    })

    const evalCommand = jest.fn().mockRejectedValue(new Error('EVAL unavailable'))
    mockGetSharedRedis.mockResolvedValueOnce({ eval: evalCommand })
    await expect(acquireLeaderboardRunLease(['7D'])).resolves.toEqual({
      acquired: false,
      reason: 'redis_error',
      error: 'EVAL unavailable',
    })
  })

  it('fails closed on an unexpected acquire response', async () => {
    mockGetSharedRedis.mockResolvedValue({ eval: jest.fn().mockResolvedValue('OK') })

    await expect(acquireLeaderboardRunLease(['90D'])).resolves.toEqual({
      acquired: false,
      reason: 'redis_response_invalid',
    })
  })

  it('surfaces release transport and response failures without unsafe fallback deletion', async () => {
    const evalCommand = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('release unavailable'))
    mockGetSharedRedis.mockResolvedValue({ eval: evalCommand, del: jest.fn() })
    const acquired = await acquireLeaderboardRunLease(['7D'])
    if (!acquired.acquired) throw new Error('expected lease')

    await expect(acquired.lease.release()).resolves.toEqual({
      released: false,
      reason: 'redis_error',
      releasedKeys: 0,
      error: 'release unavailable',
    })

    evalCommand.mockResolvedValueOnce(['bad-response'])
    await expect(acquired.lease.release()).resolves.toEqual({
      released: false,
      reason: 'redis_response_invalid',
      releasedKeys: 0,
    })
  })
})
