import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockRedisSet = jest.fn()
const mockRedisEval = jest.fn()
const mockGetSharedRedis = jest.fn()

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: () => mockGetSharedRedis(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { acquireCronLock } from './with-cron-lock'

beforeEach(() => {
  jest.clearAllMocks()
  mockRedisSet.mockResolvedValue('OK')
  mockRedisEval.mockResolvedValue(1)
  mockGetSharedRedis.mockResolvedValue({
    set: mockRedisSet,
    eval: mockRedisEval,
  })
})

describe('acquireCronLock', () => {
  it('uses an owned lease and compare-and-delete release', async () => {
    const acquisition = await acquireCronLock('write-job', { ttlSeconds: 60 })

    expect(acquisition.status).toBe('acquired')
    expect(mockRedisSet).toHaveBeenCalledWith('cron:lock:write-job', expect.any(String), {
      nx: true,
      ex: 90,
    })

    if (acquisition.status !== 'acquired') throw new Error('expected acquired lock')
    await acquisition.release()
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      ['cron:lock:write-job'],
      [mockRedisSet.mock.calls[0][1]]
    )
  })

  it('reports contention when another owner holds the lease', async () => {
    mockRedisSet.mockResolvedValue(null)

    await expect(acquireCronLock('write-job')).resolves.toEqual({ status: 'contended' })
    expect(mockRedisEval).not.toHaveBeenCalled()
  })

  it('fails closed when Redis is unavailable or throws', async () => {
    mockGetSharedRedis.mockResolvedValueOnce(null)
    await expect(acquireCronLock('missing-redis')).resolves.toEqual({ status: 'unavailable' })

    mockGetSharedRedis.mockRejectedValueOnce(new Error('redis timeout'))
    await expect(acquireCronLock('failed-redis')).resolves.toEqual({ status: 'unavailable' })
  })
})

describe('cron lock callers', () => {
  const mutatingRoutes = [
    'app/api/cron/cleanup-data/route.ts',
    'app/api/cron/check-data-freshness/route.ts',
    'app/api/cron/aggregate-daily-snapshots/route.ts',
    'app/api/cron/batch-5min/route.ts',
    'app/api/cron/sync-meilisearch/route.ts',
    'app/api/cron/broadcast-trader-events/route.ts',
    'app/api/cron/qualify-referrals/route.ts',
  ] as const

  it.each(mutatingRoutes)('%s distinguishes contention from lock unavailability', (routePath) => {
    const source = readFileSync(join(process.cwd(), routePath), 'utf8')

    expect(source).toContain("lock.status !== 'acquired'")
    expect(source).toContain("lock.status === 'contended'")
    expect(source).toContain("reason: 'lock_unavailable'")
    expect(source).toContain("lock.status === 'contended' ? 200 : 503")
    expect(source).toContain('const releaseLock = lock.release')
  })
})
