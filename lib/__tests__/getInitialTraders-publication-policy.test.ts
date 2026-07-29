const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockCacheGet = jest.fn()
const mockCacheSet = jest.fn()
const mockAttachAvatarMirrors = jest.fn(async (_supabase: unknown, traders: unknown[]) => traders)
const mockReadSealedRankingGeneration = jest.fn()
const mockPublishedCounts = new Map<string, number>()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))

jest.mock('@/lib/data/avatar-mirrors', () => ({
  attachAvatarMirrors: (...args: unknown[]) => mockAttachAvatarMirrors(...args),
}))

jest.mock('@/lib/cache', () => ({
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: (...args: unknown[]) => mockCacheSet(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  fireAndForget: jest.fn(),
}))

jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  ...jest.requireActual('@/lib/rankings/read-sealed-ranking-generation'),
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

const TEST_COHORT_ID = '11111111-1111-4111-8111-111111111111'

async function readThroughSealedGeneration(
  _supabase: unknown,
  input: { season: '7D' | '30D' | '90D'; sources: string[] },
  reader: (publication: {
    state: 'sealed'
    season: '7D' | '30D' | '90D'
    scoreCohortId: string
    proofs: unknown[]
  }) => Promise<unknown>
) {
  const publication = {
    state: 'sealed' as const,
    season: input.season,
    scoreCohortId: TEST_COHORT_ID,
    proofs: [...input.sources].sort().map((source) => ({
      season_id: input.season,
      source,
      source_as_of: '2026-07-24T11:00:00.000000Z',
      recorded_at: '2026-07-24T11:01:00.000000Z',
      score_cohort_id: TEST_COHORT_ID,
      rank_mutation_seq: 9,
      current_mutation_seq: 9,
      published_rank_count: mockPublishedCounts.get(source) ?? 0,
      published_identity_sha256: 'a'.repeat(64),
      is_sealed: true,
    })),
  }
  const value = await reader(publication)
  return {
    value,
    publication,
    publicationIdentity: JSON.stringify(publication),
  }
}

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

/**
 * Emulate PostgREST's source filters and RANGE order. A retired row ahead of a
 * page boundary therefore consumes a slot unless `.in('source', active)` was
 * applied before `.range(...)`.
 */
function sourceFilteredPageQuery(data: Array<Record<string, unknown>>, error: unknown = null) {
  let allowedSources: Set<unknown> | null = null
  let excludedSources = new Set<string>()
  let range: [number, number] | null = null
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          const filtered = data
            .filter((row) => allowedSources === null || allowedSources.has(row.source))
            .filter((row) => typeof row.source !== 'string' || !excludedSources.has(row.source))
          const page = range ? filtered.slice(range[0], range[1] + 1) : filtered
          const result = { data: page, error }
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }

        const key = String(property)
        if (key === 'in') {
          methods.in ??= jest.fn((column: string, values: unknown[]) => {
            if (column === 'source') allowedSources = new Set(values)
            return proxy
          })
          return methods.in
        }
        if (key === 'not') {
          methods.not ??= jest.fn((column: string, operator: string, value: string) => {
            if (column === 'source' && operator === 'in') {
              excludedSources = new Set(value.replace(/^\(|\)$/g, '').split(','))
            }
            return proxy
          })
          return methods.not
        }
        if (key === 'range') {
          methods.range ??= jest.fn((from: number, to: number) => {
            range = [from, to]
            return proxy
          })
          return methods.range
        }
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return proxy
}

function abortablePendingQuery() {
  let signal: AbortSignal | undefined
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (_resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
            const rejectAbort = () => {
              const error = new Error('request aborted')
              error.name = 'AbortError'
              reject(error)
            }
            if (signal?.aborted) rejectAbort()
            else signal?.addEventListener('abort', rejectAbort, { once: true })
          }
        }
        if (property === 'abortSignal') {
          methods.abortSignal ??= jest.fn((nextSignal: AbortSignal) => {
            signal = nextSignal
            return proxy
          })
          return methods.abortSignal
        }
        const key = String(property)
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return proxy
}

import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'
import { fetchLeaderboardFromDB, getInitialTraders } from '../getInitialTraders'

describe('SSR public ranking source quarantine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPublishedCounts.clear()
    mockReadSealedRankingGeneration.mockImplementation(readThroughSealedGeneration)
    mockCacheGet.mockResolvedValue(null)
    mockCacheSet.mockResolvedValue(undefined)
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('applies the active allowlist before a deep-page range so retired rows cannot consume slots', async () => {
    for (const source of ['binance_futures', 'bybit', 'hyperliquid', 'gmx']) {
      mockPublishedCounts.set(source, 1)
    }
    const generation = '2026-07-24T11:59:00.000Z'
    let rankingQuery: ReturnType<typeof sourceFilteredPageQuery> | undefined
    let freshnessQuery: ReturnType<typeof queryResult> | undefined

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') {
        return queryResult([
          { source_type: 'futures', count: 4 },
          { source_type: 'web3', count: 2 },
        ])
      }
      throw new Error(`unexpected RPC ${name}`)
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = sourceFilteredPageQuery([
          {
            source: 'binance_futures',
            source_trader_id: 'page-0-safe-1',
            source_type: 'futures',
            handle: 'Page 0 Safe 1',
            arena_score: 100,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'bybit',
            source_trader_id: 'page-0-safe-2',
            source_type: 'futures',
            handle: 'Page 0 Safe 2',
            arena_score: 95,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'copin',
            source_trader_id: 'hyperliquid:0xretired-slot',
            source_type: 'web3',
            handle: 'Retired Copin Slot',
            arena_score: 90,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'toobit',
            source_trader_id: 'retired-toobit-slot',
            source_type: 'futures',
            handle: 'Retired Toobit Slot',
            arena_score: 85,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'hyperliquid',
            source_trader_id: 'page-1-safe-1',
            source_type: 'web3',
            handle: 'Page 1 Safe 1',
            arena_score: 80,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'gmx',
            source_trader_id: 'page-1-safe-2',
            source_type: 'web3',
            handle: 'Page 1 Safe 2',
            arena_score: 75,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
        ])
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 6, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
          { source: 'bybit_gt0', total_count: 1, updated_at: generation },
          { source: 'copin_gt0', total_count: 1, updated_at: generation },
          { source: 'toobit_gt0', total_count: 1, updated_at: generation },
          { source: 'hyperliquid_gt0', total_count: 1, updated_at: generation },
          { source: 'gmx_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        freshnessQuery = queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
          { source: 'bybit', source_as_of: '2026-07-24T10:30:00.000Z' },
          { source: 'copin', source_as_of: '2026-07-01T00:00:00.000Z' },
          { source: 'toobit', source_as_of: '2026-07-01T00:00:00.000Z' },
          { source: 'hyperliquid', source_as_of: '2026-07-24T10:00:00.000Z' },
          { source: 'gmx', source_as_of: '2026-07-24T09:30:00.000Z' },
        ])
        return freshnessQuery
      }
      throw new Error(`unexpected table ${table}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 2, 1)

    expect(result.traders.map(({ id }) => id)).toEqual(['page-1-safe-1', 'page-1-safe-2'])
    expect(result.totalCount).toBe(4)
    expect(result.categoryCounts).toEqual({ all: 4, futures: 2, spot: 0, onchain: 2 })
    expect(rankingQuery?.in).toHaveBeenCalledWith('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
    expect(rankingQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(rankingQuery?.filter).toHaveBeenCalledWith('rank_publication_id', 'eq', TEST_COHORT_ID)
    expect(rankingQuery?.range).toHaveBeenCalledWith(2, 3)
    expect((rankingQuery?.in as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (rankingQuery?.range as jest.Mock).mock.invocationCallOrder[0]
    )
    expect(freshnessQuery).toBeUndefined()
  })

  it('fills page zero after active allowlist and quarantine filters run before LIMIT', async () => {
    for (const source of ['binance_futures', 'bybit', 'hyperliquid']) {
      mockPublishedCounts.set(source, 1)
    }
    const generation = '2026-07-24T11:59:00.000Z'
    let rankingQuery: ReturnType<typeof sourceFilteredPageQuery> | undefined

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') {
        return queryResult([
          { source_type: 'futures', count: 3 },
          { source_type: 'web3', count: 1 },
        ])
      }
      throw new Error(`unexpected RPC ${name}`)
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = sourceFilteredPageQuery([
          {
            source: 'copin',
            source_trader_id: 'hyperliquid:0xretired-page-zero',
            handle: 'Retired Copin',
            arena_score: 110,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'toobit',
            source_trader_id: 'retired-toobit-page-zero',
            handle: 'Retired Toobit',
            arena_score: 105,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'okx_web3_solana',
            source_trader_id: 'quarantined-page-zero',
            handle: 'Quarantined',
            arena_score: 100,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
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
          { source: '_all_gt0', total_count: 6, updated_at: generation },
          { source: 'copin_gt0', total_count: 1, updated_at: generation },
          { source: 'toobit_gt0', total_count: 1, updated_at: generation },
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
    expect(rankingQuery?.in).toHaveBeenCalledWith('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
    expect(rankingQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(rankingQuery?.filter).toHaveBeenCalledWith('rank_publication_id', 'eq', TEST_COHORT_ID)
    expect(rankingQuery?.range).toHaveBeenCalledWith(0, 2)
    expect((rankingQuery?.in as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (rankingQuery?.range as jest.Mock).mock.invocationCallOrder[0]
    )
    expect((rankingQuery?.not as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (rankingQuery?.range as jest.Mock).mock.invocationCallOrder[0]
    )
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        season: '90D',
        sources: expect.not.arrayContaining([
          'okx_web3_solana',
          'bitget_bots_futures',
          'bitget_bots_spot',
        ]),
      }),
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 4_500, signal: expect.any(AbortSignal) })
    )
  })

  it('rejects copin:hyperliquid pollution before mapping can relabel it as active', async () => {
    mockPublishedCounts.set('binance_futures', 1)
    const generation = '2026-07-24T11:59:00.000Z'
    let rankingQuery: ReturnType<typeof queryResult> | undefined

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') {
        return queryResult([
          { source_type: 'futures', count: 1 },
          { source_type: 'web3', count: 1 },
        ])
      }
      throw new Error(`unexpected RPC ${name}`)
    })

    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        // Deliberately emulate a misbehaving DB/proxy that returns a row despite
        // the SQL allowlist. Raw-source filtering must still run before mapping.
        rankingQuery = queryResult([
          {
            source: 'copin',
            source_trader_id: 'hyperliquid:0xpoison',
            source_type: 'web3',
            handle: 'Retired Copin',
            arena_score: 100,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
          {
            source: 'binance_futures',
            source_trader_id: 'safe-after-copin',
            source_type: 'futures',
            handle: 'Safe',
            arena_score: 90,
            computed_at: '2026-07-24T11:55:00.000Z',
          },
        ])
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 2, updated_at: generation },
          { source: 'copin_gt0', total_count: 1, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'copin', source_as_of: '2026-07-01T00:00:00.000Z' },
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected table ${table}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 2, 1)

    expect(result.traders.map(({ id, source }) => ({ id, source }))).toEqual([
      { id: 'safe-after-copin', source: 'binance_futures' },
    ])
    expect(result.traders).not.toContainEqual(
      expect.objectContaining({ id: '0xpoison', source: 'hyperliquid' })
    )
    expect(result.totalCount).toBe(1)
    expect(rankingQuery?.in).toHaveBeenCalledWith('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])
  })

  it('rejects an old generic SSR cache page instead of treating it as sealed last-good', async () => {
    const first = { source: 'binance_futures', source_type: 'futures', id: 'first-safe' }
    const last = { source: 'hyperliquid', source_type: 'web3', id: 'last-safe' }
    mockCacheGet.mockResolvedValueOnce({
      traders: [first, { source: 'okx_web3_solana', id: 'blocked' }, last],
      lastUpdated: '2026-07-24T10:00:00.000Z',
      isStale: false,
      totalCount: 999,
      categoryCounts: { all: 999, futures: 999, spot: 999, onchain: 999 },
    })
    mockReadSealedRankingGeneration.mockRejectedValueOnce(new Error('proof unavailable'))

    const result = await getInitialTraders('90D', 3, 1)

    expect(mockCacheGet).toHaveBeenCalledWith(
      'public-rank-policy-v4:home-initial-traders-sealed-v5:90D:p1'
    )
    expect(result.traders).toEqual([])
    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('never reads legacy data and uses the sealed v5 envelope for normal cache writes and reads', async () => {
    mockPublishedCounts.set('binance_futures', 1)
    const oldV3Key = 'public-rank-policy-v3:home-initial-traders-v4:90D:p1'
    const newV5Key = 'public-rank-policy-v4:home-initial-traders-sealed-v5:90D:p1'
    const newV5FallbackKey = 'public-rank-policy-v4:home-initial-traders-sealed-fallback-v5:90D:p1'
    const transformedCopin = {
      traders: [
        {
          source: 'hyperliquid',
          source_type: 'web3',
          id: '0xlegacy-copin',
          handle: 'Transformed Copin',
        },
      ],
      lastUpdated: '2026-07-24T10:00:00.000Z',
      isStale: false,
      totalCount: 1,
      categoryCounts: { all: 1, futures: 0, spot: 0, onchain: 1 },
    }
    const cacheEntries = new Map<string, unknown>([[oldV3Key, transformedCopin]])
    mockCacheGet.mockImplementation(async (key: string) => cacheEntries.get(key) ?? null)
    mockCacheSet.mockImplementation(async (key: string, value: unknown) => {
      cacheEntries.set(key, value)
    })

    const generation = '2026-07-24T11:59:00.000Z'
    const rankingQuery = queryResult([
      {
        source: 'binance_futures',
        source_trader_id: 'fresh-v4',
        source_type: 'futures',
        handle: 'Fresh V4',
        arena_score: 90,
        computed_at: '2026-07-24T11:55:00.000Z',
      },
    ])
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') {
        return queryResult([{ source_type: 'futures', count: 1 }])
      }
      throw new Error(`unexpected RPC ${name}`)
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') return rankingQuery
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          { source: '_all_gt0', total_count: 1, updated_at: generation },
          { source: 'binance_futures_gt0', total_count: 1, updated_at: generation },
        ])
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected table ${table}`)
    })

    const first = await getInitialTraders('90D', 1, 1)

    expect(first.traders.map(({ id }) => id)).toEqual(['fresh-v4'])
    expect(mockCacheGet).not.toHaveBeenCalledWith(oldV3Key)
    expect(mockCacheGet).toHaveBeenNthCalledWith(1, newV5Key)
    expect(mockCacheGet).toHaveBeenNthCalledWith(2, newV5FallbackKey)
    expect(mockCacheSet).toHaveBeenCalledWith(
      newV5Key,
      expect.objectContaining({
        contract: 'sealed-ranking-cache@1',
        season: '90D',
        value: first,
      }),
      { ttl: 7200 }
    )
    expect(mockCacheSet).toHaveBeenCalledWith(
      newV5FallbackKey,
      expect.objectContaining({
        contract: 'sealed-ranking-cache@1',
        season: '90D',
        value: first,
      }),
      { ttl: 14400 }
    )
    expect(cacheEntries.get(oldV3Key)).toBe(transformedCopin)

    mockFrom.mockClear()
    mockRpc.mockClear()
    const second = await getInitialTraders('90D', 1, 1)

    expect(second).toEqual(first)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('serves a non-empty fallback cache immediately and always marks it stale', async () => {
    mockPublishedCounts.set('binance_futures', 1)
    const fallback = {
      traders: [{ source: 'binance_futures', source_type: 'futures', id: 'cached-trader' }],
      lastUpdated: '2026-07-24T10:00:00.000Z',
      isStale: false,
      totalCount: 1,
      categoryCounts: { all: 1, futures: 1, spot: 0, onchain: 0 },
    }
    const sealedFallback = await readThroughSealedGeneration(
      {},
      {
        season: '90D',
        sources: PUBLIC_ACTIVE_RANKING_SOURCES.filter(
          (source) => !PUBLIC_RANKING_QUARANTINED_SOURCES.includes(source)
        ),
      },
      async () => fallback
    )
    mockCacheGet.mockResolvedValueOnce(null).mockResolvedValueOnce({
      contract: 'sealed-ranking-cache@1',
      season: '90D',
      publicationIdentity: sealedFallback.publicationIdentity,
      publication: sealedFallback.publication,
      cachedAt: '2026-07-24T11:02:00.000Z',
      value: fallback,
    })
    mockFrom.mockImplementation(() => {
      throw new Error('DB must not start when stale fallback data is available')
    })

    const result = await getInitialTraders('90D', 20, 0)

    expect(mockCacheGet).toHaveBeenNthCalledWith(
      1,
      'public-rank-policy-v4:home-initial-traders-sealed-v5:90D:p0'
    )
    expect(mockCacheGet).toHaveBeenNthCalledWith(
      2,
      'public-rank-policy-v4:home-initial-traders-sealed-fallback-v5:90D:p0'
    )
    expect(result).toEqual({ ...fallback, isStale: true })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('passes one shared AbortSignal through every related Supabase read', async () => {
    mockPublishedCounts.set('binance_futures', 1)
    const rankingQuery = queryResult([
      {
        source: 'binance_futures',
        source_trader_id: 'shared-signal',
        source_type: 'futures',
        handle: 'Shared Signal',
        arena_score: 90,
        computed_at: '2026-07-24T11:55:00.000Z',
      },
    ])
    const categoryQuery = queryResult([{ source_type: 'futures', count: 1 }])
    const countQuery = queryResult([
      {
        source: '_all_gt0',
        total_count: 1,
        updated_at: '2026-07-24T11:59:00.000Z',
      },
      {
        source: 'binance_futures_gt0',
        total_count: 1,
        updated_at: '2026-07-24T11:59:00.000Z',
      },
    ])
    const freshnessQuery = queryResult([
      { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
    ])

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') return categoryQuery
      throw new Error(`unexpected RPC ${name}`)
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') return rankingQuery
      if (table === 'leaderboard_count_cache') return countQuery
      if (table === 'leaderboard_source_freshness') return freshnessQuery
      throw new Error(`unexpected table ${table}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 1, 1)
    const signal = (rankingQuery.abortSignal as jest.Mock).mock.calls[0]?.[0] as AbortSignal

    expect(result.traders.map(({ id }) => id)).toEqual(['shared-signal'])
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(categoryQuery.abortSignal).not.toHaveBeenCalled()
    expect(countQuery.abortSignal).not.toHaveBeenCalled()
    expect(freshnessQuery.abortSignal).not.toHaveBeenCalled()
    expect(mockAttachAvatarMirrors).toHaveBeenCalledWith(expect.anything(), result.traders, signal)
    expect(signal.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('treats a resolved cohort query error as a failed sealed read', async () => {
    const rankingQuery = queryResult([], { message: 'rank query unavailable' })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') return rankingQuery
      throw new Error(`unexpected table ${table}`)
    })

    await expect(fetchLeaderboardFromDB('90D', 20, 1)).resolves.toEqual({
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: 0,
      categoryCounts: { all: 0, futures: 0, spot: 0, onchain: 0 },
    })

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledTimes(1)
    expect(mockAttachAvatarMirrors).not.toHaveBeenCalled()
  })

  it('uses one timeout to abort the underlying query instead of racing abandoned work', async () => {
    const rankingQuery = abortablePendingQuery()
    const categoryQuery = queryResult([])
    const countQuery = queryResult([])
    const freshnessQuery = queryResult([])

    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_leaderboard_category_counts') return categoryQuery
      throw new Error(`unexpected RPC ${name}`)
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') return rankingQuery
      if (table === 'leaderboard_count_cache') return countQuery
      if (table === 'leaderboard_source_freshness') return freshnessQuery
      throw new Error(`unexpected table ${table}`)
    })

    const pending = getInitialTraders('90D', 20, 1)
    await jest.advanceTimersByTimeAsync(0)

    const signal = (rankingQuery.abortSignal as jest.Mock).mock.calls[0]?.[0] as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(jest.getTimerCount()).toBe(1)

    await jest.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toEqual({
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: 0,
      categoryCounts: { all: 0, futures: 0, spot: 0, onchain: 0 },
    })
    expect(signal.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })
})
