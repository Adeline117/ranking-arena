import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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

const root = process.cwd()

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFilesBelow(path)
    return path.endsWith('.ts') && !path.includes('/__tests__/') ? [path] : []
  })
}

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

    if (acquisition.status !== 'acquired') throw new Error('expected acquired lease')
    await acquisition.release()
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      ['cron:lock:write-job'],
      [mockRedisSet.mock.calls[0][1]]
    )
  })

  it('requires every standalone cron caller to return 503 on lock infrastructure failure', () => {
    const callers = sourceFilesBelow(join(root, 'app/api/cron'))
      .filter((path) => readFileSync(path, 'utf8').includes('await acquireCronLock('))
      .map((path) => relative(root, path))
      .sort()

    expect(callers).toEqual([
      'app/api/cron/aggregate-daily-snapshots/route.ts',
      'app/api/cron/aggregate-portfolio-snapshots/route.ts',
      'app/api/cron/batch-5min/route.ts',
      'app/api/cron/broadcast-trader-events/route.ts',
      'app/api/cron/check-data-freshness/route.ts',
      'app/api/cron/cleanup-data/route.ts',
      'app/api/cron/compute-derived-metrics/route.ts',
      'app/api/cron/precompute-composite/route.ts',
      'app/api/cron/qualify-referrals/route.ts',
      'app/api/cron/sync-meilisearch/route.ts',
    ])

    for (const caller of callers) {
      const source = readFileSync(join(root, caller), 'utf8')
      expect(source).toMatch(
        /if \(lock\.status === 'unavailable'\) \{[\s\S]*?\{ status: 503 \}[\s\S]*?\}/
      )
      expect(source).toContain("if (lock.status === 'held')")
      expect(source).toContain('const releaseLock = lock.release')
      expect(source).not.toContain('if (!releaseLock)')
      const protectedWork = source.slice(
        source.indexOf('const releaseLock = lock.release') +
          'const releaseLock = lock.release'.length
      )
      expect(protectedWork).toMatch(/^\s*try \{/)
      expect(source).toContain('await releaseLock()')
      expect(source).not.toMatch(/(?<!await )releaseLock\(\)/)
    }
  })

  it('reports a held lease without treating it as infrastructure failure', async () => {
    mockRedisSet.mockResolvedValue(null)

    await expect(acquireCronLock('write-job')).resolves.toEqual({ status: 'held' })
    expect(mockRedisEval).not.toHaveBeenCalled()
  })

  it('reports an unavailable backend separately so schedulers can retry', async () => {
    mockGetSharedRedis.mockResolvedValueOnce(null)
    await expect(acquireCronLock('missing-redis')).resolves.toEqual({ status: 'unavailable' })

    mockGetSharedRedis.mockRejectedValueOnce(new Error('redis timeout'))
    await expect(acquireCronLock('failed-redis')).resolves.toEqual({ status: 'unavailable' })
  })
})
