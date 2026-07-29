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
    const release = await acquireCronLock('write-job', { ttlSeconds: 60 })

    expect(release).not.toBeNull()
    expect(mockRedisSet).toHaveBeenCalledWith('cron:lock:write-job', expect.any(String), {
      nx: true,
      ex: 90,
    })

    await release?.()
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      ['cron:lock:write-job'],
      [mockRedisSet.mock.calls[0][1]]
    )
  })

  it('returns null when another owner holds the lease', async () => {
    mockRedisSet.mockResolvedValue(null)

    await expect(acquireCronLock('write-job')).resolves.toBeNull()
    expect(mockRedisEval).not.toHaveBeenCalled()
  })

  it('fails closed when Redis is unavailable or throws', async () => {
    mockGetSharedRedis.mockResolvedValueOnce(null)
    await expect(acquireCronLock('missing-redis')).resolves.toBeNull()

    mockGetSharedRedis.mockRejectedValueOnce(new Error('redis timeout'))
    await expect(acquireCronLock('failed-redis')).resolves.toBeNull()
  })
})
