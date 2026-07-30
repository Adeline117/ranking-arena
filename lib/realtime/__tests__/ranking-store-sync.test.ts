/**
 * @jest-environment node
 */

const mockGetSharedRedis = jest.fn()
const mockReadSealedGeneration = jest.fn()
const mockPageAbort = jest.fn()
const mockFrom = jest.fn()
const mockMulti = jest.fn()
const mockExec = jest.fn()

const query: Record<string, jest.Mock> = {}
for (const method of ['select', 'in', 'eq', 'filter', 'gt', 'or', 'order', 'range']) {
  query[method] = jest.fn(() => query)
}
query.abortSignal = mockPageAbort

jest.mock('@/lib/cache/redis-client', () => ({
  getSharedRedis: (...args: unknown[]) => mockGetSharedRedis(...args),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingAuthorityGeneration: (...args: unknown[]) => mockReadSealedGeneration(...args),
}))

jest.mock('@/lib/rankings/publication-policy', () => ({
  isPublicRankingSourceAllowed: (source: unknown) => source === 'binance_futures',
  publicRankingCacheKey: (key: string) => `epoch:${key}`,
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { syncSortedSetFromLeaderboard } from '../ranking-store'

type Command = { name: 'del' | 'zadd' | 'expire' | 'hset'; args: unknown[] }

describe('syncSortedSetFromLeaderboard', () => {
  let rows: Array<Record<string, unknown>>
  let commands: Command[]
  let mutateAcknowledgements: ((results: unknown[]) => unknown[]) | undefined
  let transaction: {
    del: jest.Mock
    zadd: jest.Mock
    expire: jest.Mock
    hset: jest.Mock
    length: jest.Mock
    exec: jest.Mock
  }

  beforeEach(() => {
    jest.clearAllMocks()
    rows = [{ source: 'binance_futures', source_trader_id: 'leader-1', arena_score: 88 }]
    commands = []
    mutateAcknowledgements = undefined

    transaction = {
      del: jest.fn((...args: unknown[]) => {
        commands.push({ name: 'del', args })
        return transaction
      }),
      zadd: jest.fn((...args: unknown[]) => {
        commands.push({ name: 'zadd', args })
        return transaction
      }),
      expire: jest.fn((...args: unknown[]) => {
        commands.push({ name: 'expire', args })
        return transaction
      }),
      hset: jest.fn((...args: unknown[]) => {
        commands.push({ name: 'hset', args })
        return transaction
      }),
      length: jest.fn(() => commands.length),
      exec: mockExec,
    }
    mockMulti.mockReturnValue(transaction)
    mockGetSharedRedis.mockResolvedValue({ multi: mockMulti })
    mockFrom.mockReturnValue(query)
    mockPageAbort.mockImplementation(async () => ({ data: rows, error: null }))
    mockReadSealedGeneration.mockImplementation(
      async (
        _supabase: unknown,
        season: string,
        reader: (publication: unknown) => Promise<unknown>,
        options: unknown
      ) => {
        const publication = {
          season,
          scoreCohortId: '00000000-0000-4000-8000-000000000001',
          proofs: [{ source: 'binance_futures', published_rank_count: rows.length }],
        }
        return {
          value: await reader(publication),
          publication,
          options,
        }
      }
    )
    mockExec.mockImplementation(async () => {
      const results = commands.map((command) => {
        if (command.name === 'del') return 0
        if (command.name === 'expire') return 1
        if (command.name === 'zadd') return command.args.length - 1
        return Object.keys(command.args[1] as Record<string, string>).length
      })
      return mutateAcknowledgements ? mutateAcknowledgements(results) : results
    })
  })

  it('batches rows and accepts only exact Redis acknowledgements', async () => {
    rows = Array.from({ length: 501 }, (_, index) => ({
      source: 'binance_futures',
      source_trader_id: `leader-${index}`,
      arena_score: 100 - index / 100,
    }))
    const controller = new AbortController()
    const supabase = { from: mockFrom }

    await expect(
      syncSortedSetFromLeaderboard(supabase as never, '7D', { signal: controller.signal })
    ).resolves.toBe(501)

    expect(mockReadSealedGeneration).toHaveBeenCalledWith(supabase, '7D', expect.any(Function), {
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    expect(mockPageAbort).toHaveBeenCalledWith(controller.signal)
    expect(transaction.zadd).toHaveBeenCalledTimes(2)
    expect(transaction.zadd.mock.calls[0]).toHaveLength(501)
    expect(transaction.zadd.mock.calls[1]).toHaveLength(2)
    expect(transaction.hset).toHaveBeenCalledTimes(1)
    expect(Object.keys(transaction.hset.mock.calls[0][1])).toHaveLength(200)
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate members before opening a Redis transaction', async () => {
    rows = [
      { source: 'binance_futures', source_trader_id: 'duplicate', arena_score: 90 },
      { source: 'binance_futures', source_trader_id: 'duplicate', arena_score: 80 },
    ]

    await expect(syncSortedSetFromLeaderboard({ from: mockFrom } as never, '30D')).rejects.toThrow(
      'duplicate member'
    )
    expect(mockMulti).not.toHaveBeenCalled()
  })

  it.each([
    [{ source: 'binance_futures', source_trader_id: '', arena_score: 90 }, 'identifier'],
    [{ source: 'binance_futures', source_trader_id: 'leader', arena_score: 0 }, 'arena score'],
    [{ source: 'binance_futures', source_trader_id: 'leader', arena_score: true }, 'arena score'],
    [{ source: 'private_source', source_trader_id: 'leader', arena_score: 90 }, 'non-public'],
  ])('rejects a malformed cache row: %p', async (row, message) => {
    rows = [row]

    await expect(syncSortedSetFromLeaderboard({ from: mockFrom } as never, '90D')).rejects.toThrow(
      message
    )
    expect(mockMulti).not.toHaveBeenCalled()
  })

  it('fails when Redis does not acknowledge an expiry command', async () => {
    mutateAcknowledgements = (results) => {
      const mutated = [...results]
      const expiryIndex = commands.findIndex((command) => command.name === 'expire')
      mutated[expiryIndex] = 0
      return mutated
    }

    await expect(syncSortedSetFromLeaderboard({ from: mockFrom } as never, '7D')).rejects.toThrow(
      'expected 1'
    )
  })

  it('does not publish a page completed after the caller deadline', async () => {
    const controller = new AbortController()
    controller.abort(new Error('ranking cache deadline'))

    await expect(
      syncSortedSetFromLeaderboard({ from: mockFrom } as never, '7D', {
        signal: controller.signal,
      })
    ).rejects.toThrow('ranking cache deadline')
    expect(mockGetSharedRedis).not.toHaveBeenCalled()
    expect(mockMulti).not.toHaveBeenCalled()
  })
})
