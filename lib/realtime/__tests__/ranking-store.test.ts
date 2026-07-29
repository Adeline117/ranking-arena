/**
 * Tests for ranking-store write buffer logic.
 * Redis is mocked to isolate buffer accumulation and flush behavior.
 */

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

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { PUBLIC_RANKING_CACHE_EPOCH } from '@/lib/rankings/publication-policy'
import { updateTraderScore, flushBuffer, syncSortedSetFromLeaderboard } from '../ranking-store'

interface QueryPage {
  data: Array<Record<string, unknown>> | null
  error: { message: string } | null
}

function trader(index: number, source = 'binance_futures'): Record<string, unknown> {
  return {
    source,
    source_trader_id: `trader-${index}`,
    arena_score: 100 - index / 1000,
    season_id: '90D',
  }
}

function supabaseWithPages(pages: QueryPage[]): {
  supabase: SupabaseClient<Database>
  range: jest.Mock
} {
  const range = jest.fn()
  for (const page of pages) range.mockResolvedValueOnce(page)

  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'gt', 'or', 'order']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.range = range

  return {
    supabase: {
      from: jest.fn(() => builder),
    } as unknown as SupabaseClient<Database>,
    range,
  }
}

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

    it.each(['bitget_bots_futures', 'bitget_bots_spot'])(
      'never buffers quarantined source %s',
      async (source) => {
        await updateTraderScore('30D', source, 'cumulative-bot', 99)
        await flushBuffer()
        expect(__mocks.pipeline).not.toHaveBeenCalled()
        expect(__mocks.zadd).not.toHaveBeenCalled()
      }
    )
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
      expect(__mocks.zadd).toHaveBeenNthCalledWith(
        1,
        `${PUBLIC_RANKING_CACHE_EPOCH}:ranking:live:90D`,
        { score: 72.3, member: 'bybit:trader_a' }
      )
      expect(__mocks.expire).toHaveBeenCalled()
      expect(__mocks.exec).toHaveBeenCalled()
    })
  })

  describe('syncSortedSetFromLeaderboard', () => {
    it('publishes the sorted set and detail hash in one Redis transaction', async () => {
      const { supabase } = supabaseWithPages([{ data: [trader(1), trader(2)], error: null }])

      await expect(syncSortedSetFromLeaderboard(supabase, '90D')).resolves.toBe(2)

      expect(__mocks.pipeline).not.toHaveBeenCalled()
      expect(__mocks.multi).toHaveBeenCalledTimes(1)
      expect(__mocks.del).toHaveBeenNthCalledWith(
        1,
        `${PUBLIC_RANKING_CACHE_EPOCH}:ranking:live:90D`
      )
      expect(__mocks.del).toHaveBeenNthCalledWith(
        2,
        `${PUBLIC_RANKING_CACHE_EPOCH}:ranking:detail:90D`
      )
      expect(__mocks.zadd).toHaveBeenCalledTimes(2)
      expect(__mocks.hset).toHaveBeenCalledTimes(2)
      expect(__mocks.exec).toHaveBeenCalledTimes(1)
    })

    it('does not replace the last-good board when a later database page fails', async () => {
      const firstPage = Array.from({ length: 1000 }, (_, index) => trader(index))
      const { supabase, range } = supabaseWithPages([
        { data: firstPage, error: null },
        { data: null, error: { message: 'page unavailable' } },
      ])

      await expect(syncSortedSetFromLeaderboard(supabase, '90D')).rejects.toThrow(
        'leaderboard_ranks query failed for 90D page 2: page unavailable'
      )

      expect(range).toHaveBeenCalledTimes(2)
      expect(__mocks.multi).not.toHaveBeenCalled()
      expect(__mocks.del).not.toHaveBeenCalled()
    })

    it('preserves the last-good board when no public rows are available', async () => {
      const { supabase } = supabaseWithPages([
        { data: [trader(1, 'okx_web3_solana')], error: null },
      ])

      await expect(syncSortedSetFromLeaderboard(supabase, '90D')).rejects.toThrow(
        'No public traders found for 90D'
      )

      expect(__mocks.multi).not.toHaveBeenCalled()
      expect(__mocks.del).not.toHaveBeenCalled()
    })

    it('reports Redis transaction failure instead of returning a false zero-success', async () => {
      const { supabase } = supabaseWithPages([{ data: [trader(1)], error: null }])
      __mocks.exec.mockRejectedValueOnce(new Error('transaction unavailable'))

      await expect(syncSortedSetFromLeaderboard(supabase, '90D')).rejects.toThrow(
        'transaction unavailable'
      )
    })

    it('reports unavailable Redis instead of returning a false zero-success', async () => {
      const { supabase } = supabaseWithPages([{ data: [trader(1)], error: null }])
      __mocks.getSharedRedis.mockResolvedValueOnce(null)

      await expect(syncSortedSetFromLeaderboard(supabase, '90D')).rejects.toThrow(
        'Redis unavailable while syncing 90D'
      )
      expect(__mocks.multi).not.toHaveBeenCalled()
    })
  })
})
