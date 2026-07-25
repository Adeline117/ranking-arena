const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockCacheGet = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))

jest.mock('@/lib/data/avatar-mirrors', () => ({
  attachAvatarMirrors: jest.fn(async (_supabase: unknown, traders: unknown[]) => traders),
}))

jest.mock('@/lib/cache', () => ({
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  fireAndForget: jest.fn(),
}))

function queryResult(data: unknown[], error: unknown = null) {
  const result = { data, error }
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        const key = String(property)
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return proxy
}

import { fetchLeaderboardFromDB, getInitialTraders } from '../getInitialTraders'

describe('SSR public ranking source quarantine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCacheGet.mockResolvedValue(null)
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('keeps safe rows after a quarantined row on a finite DB page and excludes it in SQL', async () => {
    const generation = '2026-07-24T11:59:00.000Z'
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    let freshnessQuery: ReturnType<typeof queryResult> | undefined

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') {
        return Promise.resolve({
          data: [
            { source_type: 'futures', count: 1 },
            { source_type: 'web3', count: 2 },
          ],
          error: null,
        })
      }
      throw new Error(`unexpected RPC ${name}`)
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult([
          {
            source: 'binance_futures',
            source_trader_id: 'first-safe',
            source_type: 'futures',
            handle: 'First',
            arena_score: 90,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'okx_web3_solana',
            source_trader_id: 'blocked',
            source_type: 'web3',
            handle: 'Blocked',
            arena_score: 85,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'hyperliquid',
            source_trader_id: 'last-safe',
            source_type: 'web3',
            handle: 'Last',
            arena_score: 80,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
        ])
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 3, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
          { source: 'okx_web3_solana_gt0', total_count: 1, updated_at: generation },
          { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        freshnessQuery = queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
          { source: 'okx_web3_solana', source_as_of: '2026-07-01T00:00:00.000Z' },
          { source: 'hyperliquid', source_as_of: '2026-07-24T10:00:00.000Z' },
        ])
        return freshnessQuery
      }
      throw new Error(`unexpected table ${table}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 3, 1)

    expect(result.traders.map(({ id }) => id)).toEqual(['first-safe', 'last-safe'])
    expect(result.totalCount).toBe(2)
    expect(result.categoryCounts).toEqual({ all: 2, futures: 1, spot: 0, onchain: 1 })
    expect(result.lastUpdated).toBeNull()
    expect(result.isStale).toBe(true)
    expect(rankingQuery?.not).toHaveBeenCalledWith('source', 'in', '(okx_web3_solana)')
    expect(freshnessQuery?.not).toHaveBeenCalledWith('source', 'in', '(okx_web3_solana)')
  })

  it('fills SSR page zero from a DB query that excludes quarantine before LIMIT', async () => {
    const generation = '2026-07-24T11:59:00.000Z'
    let rankingQuery: ReturnType<typeof queryResult> | undefined

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') {
        return Promise.resolve({
          data: [
            { source_type: 'futures', count: 3 },
            { source_type: 'web3', count: 1 },
          ],
          error: null,
        })
      }
      throw new Error(`unexpected RPC ${name}`)
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        // Represents the first three rows after PostgREST applies source NOT IN;
        // quarantined leaders cannot consume any of these LIMIT slots.
        rankingQuery = queryResult([
          {
            source: 'binance_futures',
            source_trader_id: 'safe-1',
            handle: 'Safe 1',
            arena_score: 90,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'bybit',
            source_trader_id: 'safe-2',
            handle: 'Safe 2',
            arena_score: 80,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'hyperliquid',
            source_trader_id: 'safe-3',
            handle: 'Safe 3',
            arena_score: 70,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
        ])
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 4, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
          { source: 'bybit_gt0', total_count: 1, updated_at: generation },
          { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
          { source: 'okx_web3_solana_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
          { source: 'bybit', source_as_of: '2026-07-24T10:30:00.000Z' },
          { source: 'hyperliquid', source_as_of: '2026-07-24T10:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected table ${table}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 3, 0)

    expect(result.traders.map(({ id }) => id)).toEqual(['safe-1', 'safe-2', 'safe-3'])
    expect(result.totalCount).toBe(3)
    expect(rankingQuery?.not).toHaveBeenCalledWith('source', 'in', '(okx_web3_solana)')
    expect(rankingQuery?.range).toHaveBeenCalledWith(0, 2)
    expect((rankingQuery?.not as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (rankingQuery?.range as jest.Mock).mock.invocationCallOrder[0]
    )
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual(['get_leaderboard_category_counts'])
  })

  it('sanitizes an old SSR cache page without invoking strict row proof or the DB', async () => {
    const first = { source: 'binance_futures', source_type: 'futures', id: 'first-safe' }
    const last = { source: 'hyperliquid', source_type: 'web3', id: 'last-safe' }
    mockCacheGet.mockResolvedValueOnce({
      traders: [first, { source: 'okx_web3_solana', id: 'blocked' }, last],
      lastUpdated: '2026-07-24T10:00:00.000Z',
      isStale: false,
      totalCount: 999,
      categoryCounts: { all: 999, futures: 999, spot: 999, onchain: 999 },
    })

    const result = await getInitialTraders('90D', 3, 1)

    expect(mockCacheGet).toHaveBeenCalledWith(
      'public-rank-policy-v2:home-initial-traders-v4:90D:p1'
    )
    expect(result.traders).toEqual([first, last])
    expect(result.totalCount).toBe(2)
    expect(result.categoryCounts).toEqual({ all: 2, futures: 1, spot: 0, onchain: 1 })
    expect(result.lastUpdated).toBeNull()
    expect(result.isStale).toBe(true)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
