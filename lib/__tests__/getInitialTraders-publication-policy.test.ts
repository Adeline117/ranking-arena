const mockFrom = jest.fn()
const mockCacheGet = jest.fn()
const mockCacheSet = jest.fn()
const mockReadSharedCacheWriteFence = jest.fn()
const mockAttachAvatarMirrors = jest.fn(async (_supabase: unknown, traders: unknown[]) => traders)

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/data/avatar-mirrors', () => ({
  attachAvatarMirrors: (...args: unknown[]) => mockAttachAvatarMirrors(...args),
}))

jest.mock('@/lib/cache', () => ({
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: (...args: unknown[]) => mockCacheSet(...args),
  readSharedCacheWriteFence: (...args: unknown[]) => mockReadSharedCacheWriteFence(...args),
  // One atomic round trip in production; modelled here as fence then each key.
  readSharedCacheWriteFenceWithEntries: async (fenceKey: string, keys: string[]) => {
    const fence = await mockReadSharedCacheWriteFence(fenceKey)
    const entries: unknown[] = []
    for (const key of keys) entries.push(await mockCacheGet(key, { skipMemory: true }))
    return { fence, entries }
  },
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  fireAndForget: jest.fn(),
}))

type QueryProxy = Record<string, jest.Mock>

function resultQuery(data: unknown[], error: unknown = null): QueryProxy {
  const methods: QueryProxy = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: { data: unknown[]; error: unknown }) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve({ data, error }).then(resolve, reject)
        }
        const key = String(property)
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return Object.assign(proxy, methods) as unknown as QueryProxy
}

/**
 * The relation is the already-filtered security-barrier view. This mock still
 * records the inclusive range so the test catches a regression back to
 * application filtering or a page-length-only pagination claim.
 */
function cohortQuery(rows: Array<Record<string, unknown>>, error: unknown = null): QueryProxy {
  let range: [number, number] | null = null
  const methods: QueryProxy = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          const page = range ? rows.slice(range[0], range[1] + 1) : rows
          return (
            resolve: (value: { data: unknown[]; error: unknown }) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve({ data: page, error }).then(resolve, reject)
        }
        const key = String(property)
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
  return Object.assign(proxy, methods) as unknown as QueryProxy
}

function cohortRow(
  sourceTraderId: string,
  rank: number,
  source = 'binance_futures'
): Record<string, unknown> {
  return {
    source,
    source_trader_id: sourceTraderId,
    source_type: 'futures',
    handle: `Trader ${sourceTraderId}`,
    roi: 12.5,
    pnl: 1234.5,
    win_rate: 55,
    max_drawdown: 12,
    trades_count: 20,
    followers: 7,
    arena_score: 80,
    rank,
    computed_at: '2026-07-24T11:55:00.000Z',
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    season_id: '90D',
  }
}

function cachedTrader(id: string) {
  return {
    id,
    handle: `Cached ${id}`,
    rank: 1,
    roi: 12.5,
    pnl: 1234.5,
    win_rate: 55,
    max_drawdown: 12,
    followers: 7,
    source: 'binance_futures',
    source_type: 'futures' as const,
    avatar_url: null,
    avatar_url_mirror: null,
    arena_score: 80,
    sharpe: null,
    trades_count: 20,
    score_confidence: 'full' as const,
    source_trader_id: id,
    season_id: '90D' as const,
    score_completeness: 'full' as const,
    metrics_estimated: false as const,
    computed_at: '2026-07-24T11:55:00.000Z',
    is_outlier: false as const,
  }
}

function validCachedResult(id: string) {
  return {
    traders: [cachedTrader(id)],
    lastUpdated: '2026-07-24T11:00:00.000Z',
    isStale: false,
    totalCount: null,
    totalCountIsExact: false,
    hasMore: true,
    categoryCounts: { all: null, futures: null, spot: null, onchain: null },
    categoryCountsAreExact: false,
    sourceFreshness: [{ source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' }],
  }
}

import {
  fetchLeaderboardFromDB,
  getInitialTraders,
  homeInitialTradersCacheKeys,
} from '../getInitialTraders'

describe('SSR public ranking cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCacheGet.mockResolvedValue(null)
    mockCacheSet.mockResolvedValue(true)
    mockReadSharedCacheWriteFence.mockResolvedValue({
      key: 'public-rankings:write-fence:v1',
      token: '7',
    })
    jest.useFakeTimers().setSystemTime(new Date('2026-07-24T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('queries the verified cohort before an inclusive lookahead range and never reads raw ranks/count cache', async () => {
    const cohort = cohortQuery([
      cohortRow('safe-1', 1),
      cohortRow('safe-2', 2),
      cohortRow('safe-3', 3),
    ])
    const freshness = resultQuery([
      { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
    ])
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return cohort
      if (relation === 'leaderboard_source_freshness') return freshness
      throw new Error(`unexpected relation ${relation}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 2, 0)

    expect(result.traders.map((trader) => trader.id)).toEqual(['safe-1', 'safe-2'])
    expect(result.hasMore).toBe(true)
    expect(result.totalCount).toBeNull()
    expect(result.totalCountIsExact).toBe(false)
    expect(result.categoryCounts).toEqual({ all: null, futures: null, spot: null, onchain: null })
    expect(result.categoryCountsAreExact).toBe(false)
    expect(mockFrom.mock.calls.map(([relation]) => relation)).toEqual([
      'public_ranked_leaderboard',
      'leaderboard_source_freshness',
    ])
    expect(cohort.range).toHaveBeenCalledWith(0, 2)
    expect((cohort.eq as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (cohort.range as jest.Mock).mock.invocationCallOrder[0]
    )
    expect(freshness.in).toHaveBeenCalledWith('source', ['binance_futures'])
  })

  it('keeps totals unknown even on terminal pages until a same-predicate count authority exists', async () => {
    const cohort = cohortQuery([
      cohortRow('safe-1', 1),
      cohortRow('safe-2', 2),
      cohortRow('safe-3', 3),
    ])
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return cohort
      if (relation === 'leaderboard_source_freshness') {
        return resultQuery([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected relation ${relation}`)
    })

    const terminal = await fetchLeaderboardFromDB('90D', 2, 1)
    expect(terminal.traders.map((trader) => trader.id)).toEqual(['safe-3'])
    expect(terminal.hasMore).toBe(false)
    expect(terminal.totalCount).toBeNull()
    expect(terminal.totalCountIsExact).toBe(false)

    const pastEnd = await fetchLeaderboardFromDB('90D', 2, 3)
    expect(pastEnd.traders).toEqual([])
    expect(pastEnd.hasMore).toBe(false)
    expect(pastEnd.totalCount).toBeNull()
    expect(pastEnd.totalCountIsExact).toBe(false)
  })

  it('revalidates cached proof and never lets a partial row retain a ranked slot', async () => {
    const partial = {
      ...validCachedResult('partial-cache'),
      traders: [{ ...cachedTrader('partial-cache'), pnl: null }],
      totalCount: 999,
      totalCountIsExact: true,
      hasMore: true,
    }
    mockCacheGet.mockResolvedValueOnce(partial).mockResolvedValueOnce(null)
    const cohort = cohortQuery([cohortRow('safe-after-cache', 1)])
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') return cohort
      if (relation === 'leaderboard_source_freshness') {
        return resultQuery([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected relation ${relation}`)
    })

    const result = await getInitialTraders('90D', 2, 0)

    expect(result.traders.map((trader) => trader.id)).toEqual(['safe-after-cache'])
    expect(result.totalCount).toBeNull()
    expect(result.totalCountIsExact).toBe(false)
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('does not reuse a cached hasMore claim after its SQL look-ahead witness was discarded', async () => {
    mockCacheGet.mockResolvedValueOnce(validCachedResult('cached-visible-row'))
    mockFrom.mockImplementation(() => {
      throw new Error('a valid primary cache hit must avoid database work')
    })

    const result = await getInitialTraders('90D', 20, 0)

    expect(result.traders.map((trader) => trader.id)).toEqual(['cached-visible-row'])
    // The cache contains the visible rows only. `hasMore` is a claim about an
    // omitted look-ahead row, so it must be reproved by a fresh cohort query
    // rather than survive the cache TTL by itself.
    expect(result.hasMore).toBe(false)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('serves a valid fallback cache as stale but rejects old source-only cache shapes', async () => {
    const legacySourceOnly = {
      traders: [{ id: 'legacy', source: 'binance_futures', rank: 1 }],
      lastUpdated: '2026-07-24T11:00:00.000Z',
      isStale: false,
      totalCount: 1,
      categoryCounts: { all: 1, futures: 1, spot: 0, onchain: 0 },
    }
    const fallback = validCachedResult('fallback-safe')
    mockCacheGet.mockResolvedValueOnce(legacySourceOnly).mockResolvedValueOnce(fallback)
    mockFrom.mockImplementation(() => {
      throw new Error('a valid fallback cache must avoid database work')
    })

    const result = await getInitialTraders('90D', 20, 0)

    expect(result.traders.map((trader) => trader.id)).toEqual(['fallback-safe'])
    expect(result.isStale).toBe(true)
    expect(result.totalCount).toBeNull()
    expect(result.totalCountIsExact).toBe(false)
    expect(result.categoryCounts).toEqual({ all: null, futures: null, spot: null, onchain: null })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rechecks cached rows against the homepage six-hour cohort window and source watermarks', async () => {
    const staleByHomepageWindow = {
      ...validCachedResult('six-hours-old'),
      traders: [
        {
          ...cachedTrader('six-hours-old'),
          computed_at: '2026-07-24T05:59:59.999Z',
        },
      ],
    }
    mockCacheGet.mockResolvedValueOnce(staleByHomepageWindow).mockResolvedValueOnce(null)
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard')
        return cohortQuery([cohortRow('fresh-after-cache', 1)])
      if (relation === 'leaderboard_source_freshness') {
        return resultQuery([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected relation ${relation}`)
    })

    const result = await getInitialTraders('90D', 20, 0)

    expect(result.traders.map((trader) => trader.id)).toEqual(['fresh-after-cache'])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('does not let a cache entry retain ranks after its upstream source watermark expires', async () => {
    const staleSourceCache = {
      ...validCachedResult('source-expired'),
      sourceFreshness: [{ source: 'binance_futures', source_as_of: '2026-07-22T11:59:59.999Z' }],
    }
    mockCacheGet.mockResolvedValueOnce(staleSourceCache).mockResolvedValueOnce(null)
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard')
        return cohortQuery([cohortRow('fresh-after-source', 1)])
      if (relation === 'leaderboard_source_freshness') {
        return resultQuery([
          { source: 'binance_futures', source_as_of: '2026-07-24T11:00:00.000Z' },
        ])
      }
      throw new Error(`unexpected relation ${relation}`)
    })

    const result = await getInitialTraders('90D', 20, 0)

    expect(result.traders.map((trader) => trader.id)).toEqual(['fresh-after-source'])
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
  })

  it('returns explicit unknown state rather than zero totals after a cohort failure', async () => {
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard')
        return cohortQuery([], { message: 'view unavailable' })
      throw new Error(`unexpected relation ${relation}`)
    })

    const result = await getInitialTraders('90D', 20, 0)

    expect(result).toEqual({
      traders: [],
      lastUpdated: null,
      isStale: true,
      totalCount: null,
      totalCountIsExact: false,
      hasMore: false,
      categoryCounts: { all: null, futures: null, spot: null, onchain: null },
      categoryCountsAreExact: false,
      sourceFreshness: [],
    })
  })

  it.each([
    ['partial completeness', { score_completeness: 'partial' }],
    ['estimated metrics', { metrics_estimated: true }],
    ['outlier flag', { is_outlier: true }],
    ['unknown ROI', { roi: null }],
    ['unknown PnL', { pnl: null }],
    ['unknown win rate', { win_rate: null }],
    ['unknown drawdown', { max_drawdown: null }],
  ])('fails closed if the view transport unexpectedly returns %s', async (_label, override) => {
    mockFrom.mockImplementation((relation: string) => {
      if (relation === 'public_ranked_leaderboard') {
        return cohortQuery([{ ...cohortRow('unexpected-row', 1), ...override }])
      }
      throw new Error(`unexpected relation ${relation}`)
    })

    const result = await fetchLeaderboardFromDB('90D', 20, 0)

    expect(result.traders).toEqual([])
    expect(result.totalCount).toBeNull()
    expect(result.totalCountIsExact).toBe(false)
    expect(result.hasMore).toBe(false)
  })

  it('epochs cache entries that lack the view proof fields', () => {
    expect(homeInitialTradersCacheKeys('90D', 2)).toEqual({
      cacheKey: 'public-rank-policy-v7:home-initial-traders-v7:90D:n50:p2',
      fallbackKey: 'public-rank-policy-v7:home-initial-traders-fallback-v7:90D:n50:p2',
    })
  })

  it('keeps cache pages isolated by their normalized page size', () => {
    expect(homeInitialTradersCacheKeys('90D', 2, 20)).toEqual({
      cacheKey: 'public-rank-policy-v7:home-initial-traders-v7:90D:n20:p2',
      fallbackKey: 'public-rank-policy-v7:home-initial-traders-fallback-v7:90D:n20:p2',
    })
  })
})
