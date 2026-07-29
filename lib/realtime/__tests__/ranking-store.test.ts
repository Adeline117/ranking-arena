/** Incremental observations must never mutate the sealed public ranking cache. */

// Use jest.fn() inside mock factory (no hoisting issue)
jest.mock('@/lib/cache/redis-client', () => {
  const zadd = jest.fn().mockResolvedValue(undefined)
  const del = jest.fn().mockResolvedValue(undefined)
  const hset = jest.fn().mockResolvedValue(undefined)
  const expire = jest.fn().mockResolvedValue(undefined)
  const exec = jest.fn().mockResolvedValue(undefined)
  const pipeline = jest.fn(() => ({ zadd, del, hset, expire, exec }))
  const multi = jest.fn(() => ({ zadd, del, hset, expire, exec }))
  const redis = {
    pipeline,
    multi,
    zadd,
    zrevrank: jest.fn().mockResolvedValue(null),
    zrange: jest.fn().mockResolvedValue([]),
    zcard: jest.fn().mockResolvedValue(0),
  }
  const getSharedRedis = jest.fn().mockResolvedValue(redis)

  return {
    getSharedRedis,
    __mocks: { getSharedRedis, pipeline, multi, zadd, del, hset, expire, exec },
  }
})

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mocks } = require('@/lib/cache/redis-client')

import { updateTraderScore, flushBuffer } from '../ranking-store'

describe('ranking-store', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('updateTraderScore', () => {
    it('does not write an unsealed score from a public source', async () => {
      await updateTraderScore('90D', 'binance_futures', 'trader1', 85.5)
      await flushBuffer()
      expect(__mocks.pipeline).not.toHaveBeenCalled()
      expect(__mocks.zadd).not.toHaveBeenCalled()
    })

    it.each(['bitget_bots_futures', 'bitget_bots_spot'])(
      'does not write quarantined source %s',
      async (source) => {
        await updateTraderScore('30D', source, 'cumulative-bot', 99)
        await flushBuffer()
        expect(__mocks.pipeline).not.toHaveBeenCalled()
        expect(__mocks.zadd).not.toHaveBeenCalled()
      }
    )
  })

  describe('flushBuffer', () => {
    it('is a compatibility no-op', async () => {
      await flushBuffer()
      expect(__mocks.pipeline).not.toHaveBeenCalled()
      expect(__mocks.zadd).not.toHaveBeenCalled()
    })
  })
})
