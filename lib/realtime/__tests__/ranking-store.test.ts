/**
 * Tests for ranking-store write buffer logic.
 * Redis is mocked to isolate buffer accumulation and flush behavior.
 */

// Use jest.fn() inside mock factory (no hoisting issue)
jest.mock('@/lib/cache/redis-client', () => {
  const zadd = jest.fn().mockResolvedValue(undefined)
  const expire = jest.fn().mockResolvedValue(undefined)
  const exec = jest.fn().mockResolvedValue(undefined)
  const pipeline = jest.fn(() => ({ zadd, expire, exec }))

  return {
    getSharedRedis: jest.fn().mockResolvedValue({
      pipeline,
      zadd,
      zrevrank: jest.fn().mockResolvedValue(null),
      zrange: jest.fn().mockResolvedValue([]),
      zcard: jest.fn().mockResolvedValue(0),
    }),
    __mocks: { pipeline, zadd, expire, exec },
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
  beforeEach(async () => {
    // Flush any leftover buffer from previous tests
    jest.useRealTimers()
    await flushBuffer()
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('updateTraderScore', () => {
    it('buffers writes and does not flush immediately for small counts', async () => {
      await updateTraderScore('90D', 'binance_futures', 'trader1', 85.5)
      // Should not have flushed yet (buffer size < 100)
      expect(__mocks.pipeline).not.toHaveBeenCalled()
    })

    it('flushes when buffer reaches max size (100)', async () => {
      for (let i = 0; i < 100; i++) {
        await updateTraderScore('90D', 'binance_futures', `trader${i}`, 50 + i)
      }
      // Should have triggered flush at 100 items
      expect(__mocks.pipeline).toHaveBeenCalled()
      expect(__mocks.exec).toHaveBeenCalled()
    })
  })

  describe('flushBuffer', () => {
    it('does nothing when buffer is empty', async () => {
      await flushBuffer()
      expect(__mocks.pipeline).not.toHaveBeenCalled()
    })

    it('flushes buffered items to redis pipeline', async () => {
      await updateTraderScore('90D', 'bybit', 'trader_a', 72.3)
      await updateTraderScore('90D', 'bybit', 'trader_b', 60.1)
      await flushBuffer()

      expect(__mocks.pipeline).toHaveBeenCalled()
      expect(__mocks.zadd).toHaveBeenCalledTimes(2)
      expect(__mocks.expire).toHaveBeenCalled()
      expect(__mocks.exec).toHaveBeenCalled()
    })
  })
})
