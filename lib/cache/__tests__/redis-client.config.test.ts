/** @jest-environment node */

describe('shared Redis client configuration', () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN

  beforeEach(() => {
    jest.resetModules()
    jest.unmock('@/lib/cache/redis-client')
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'
  })

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken
    jest.restoreAllMocks()
  })

  it('uses the supported cache option instead of an ignored custom fetch field', async () => {
    const Redis = jest.fn().mockImplementation(() => ({ ping: jest.fn() }))
    jest.doMock('@upstash/redis', () => ({ Redis }))
    jest.doMock('@/lib/utils/logger', () => ({
      dataLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      fireAndForget: jest.fn(),
    }))

    const { getSharedRedis } = await import('../redis-client')
    await getSharedRedis()

    expect(Redis).toHaveBeenCalledWith({
      url: 'https://redis.example.test',
      token: 'test-token',
      enableAutoPipelining: true,
      cache: 'default',
    })
    expect(Redis.mock.calls[0]?.[0]).not.toHaveProperty('fetch')
  })
})
