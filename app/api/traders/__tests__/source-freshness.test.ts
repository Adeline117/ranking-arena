/**
 * @jest-environment node
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Headers()

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => (request: { nextUrl: URL }) =>
    handler({ supabase: { from: mockFrom }, request }),
}))

const mockGetOrSetWithLock = jest.fn()
const mockCacheSet = jest.fn()
const mockReadSharedCacheWriteFence = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
  set: (...args: unknown[]) => mockCacheSet(...args),
  readSharedCacheWriteFence: (...args: unknown[]) => mockReadSharedCacheWriteFence(...args),
}))

jest.mock('@/lib/data/verified-traders', () => ({
  getVerifiedTraderKeys: jest.fn(async () => new Set()),
  verifiedTraderKey: (source: string, traderId: string) => `${source}:${traderId}`,
}))

jest.mock('@/lib/data/avatar-mirrors', () => ({
  attachAvatarMirrors: jest.fn(async (_supabase: unknown, traders: unknown[]) => traders),
}))

jest.mock('@/lib/api/traders-response-schema', () => ({
  validateTradersResponse: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
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

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    source_type: 'futures',
    handle: 'Trader One',
    roi: 10,
    pnl: 100,
    win_rate: 60,
    max_drawdown: 20,
    trades_count: 10,
    followers: 2,
    copiers: 1,
    avatar_url: null,
    arena_score: 90,
    rank: 1,
    rank_change: null,
    is_new: false,
    profitability_score: 80,
    risk_control_score: 75,
    execution_score: 70,
    score_completeness: 'full',
    metrics_estimated: false,
    trading_style: null,
    avg_holding_hours: null,
    style_confidence: null,
    computed_at: '2026-07-18T11:55:00.000Z',
    season_id: '90D',
    sharpe_ratio: null,
    sortino_ratio: null,
    profit_factor: null,
    calmar_ratio: null,
    trader_type: null,
    is_outlier: false,
    ...overrides,
  }
}

function publicRankedCohortScope(overrides: Record<string, unknown> = {}) {
  return {
    timeRange: '90D',
    exchangeFilter: null,
    categoryFilter: null,
    sortBy: 'arena_score',
    order: 'desc',
    cursor: null,
    limit: 50,
    useLegacyPaging: false,
    page: 0,
    ...overrides,
  }
}

function publicRankedPageQuery(rows: Array<Record<string, unknown>>) {
  let minimumRank: number | null = null
  let minimumComputedAt: string | null = null
  let sourceFilter: string | null = null
  let pageLimit: number | null = null
  let range: { from: number; to: number } | null = null
  const orders: Array<{ column: string; ascending: boolean }> = []
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          const filtered = rows
            .filter(
              (row) => minimumComputedAt == null || String(row.computed_at) >= minimumComputedAt
            )
            .filter((row) => minimumRank == null || Number(row.rank) > minimumRank)
            .filter((row) => sourceFilter == null || row.source === sourceFilter)
            .sort((left, right) => {
              for (const { column, ascending } of orders) {
                const a = left[column]
                const b = right[column]
                if (a === b) continue
                const direction = Number(a) < Number(b) ? -1 : 1
                return ascending ? direction : -direction
              }
              return 0
            })
          const ranged = range ? filtered.slice(range.from, range.to + 1) : filtered
          const data = pageLimit == null ? ranged : ranged.slice(0, pageLimit)
          const result = { data, error: null }
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }

        const key = String(property)
        if (key === 'eq') {
          methods.eq ??= jest.fn((column: string, value: string) => {
            if (column === 'source') sourceFilter = value
            return proxy
          })
          return methods.eq
        }
        if (key === 'gte') {
          methods.gte ??= jest.fn((column: string, value: string) => {
            if (column === 'computed_at') minimumComputedAt = value
            return proxy
          })
          return methods.gte
        }
        if (key === 'gt') {
          methods.gt ??= jest.fn((column: string, value: number) => {
            if (column === 'rank') minimumRank = value
            return proxy
          })
          return methods.gt
        }
        if (key === 'order') {
          methods.order ??= jest.fn((column: string, options: { ascending?: boolean } = {}) => {
            orders.push({ column, ascending: options.ascending === true })
            return proxy
          })
          return methods.order
        }
        if (key === 'limit') {
          methods.limit ??= jest.fn((value: number) => {
            pageLimit = value
            return proxy
          })
          return methods.limit
        }
        if (key === 'range') {
          methods.range ??= jest.fn((from: number, to: number) => {
            range = { from, to }
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

import { GET, warmDefaultPublicTradersCache } from '../route'
import { resetClaimedTraderBadgeCacheForTests } from '@/lib/data/claimed-trader-badges'

describe('GET /api/traders public ranked cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetClaimedTraderBadgeCacheForTests()
    mockGetOrSetWithLock.mockImplementation(
      async (_key: string, fetcher: () => Promise<unknown>) => await fetcher()
    )
    mockCacheSet.mockResolvedValue(true)
    mockReadSharedCacheWriteFence.mockResolvedValue({
      key: 'public-rankings:write-fence:v1',
      token: '7',
    })
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('reads only the source-fresh public view, returns nullable totals, and exposes page-scoped freshness', async () => {
    // Source freshness is now a database eligibility predicate. This route
    // must receive only rows whose sealed source cohort is current; a stale
    // source is proved at the view's PG17 contract, not relabelled as a ranked
    // row with a stale badge after pagination.
    const rankingQuery = publicRankedPageQuery([
      publicRankedRow({ source_trader_id: 'fresh', handle: 'Fresh', rank: 1 }),
    ])
    const freshnessQuery = queryResult([
      { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
    ])
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return rankingQuery
      if (table === 'leaderboard_source_freshness') return freshnessQuery
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
    } as never)
    const body = await response.json()

    expect(body.lastUpdated).toBe('2026-07-18T11:00:00.000Z')
    expect(body.isStale).toBe(false)
    expect(body.totalCount).toBeNull()
    expect(body.totalCountIsExact).toBe(false)
    expect(body.availableSources).toEqual(['binance_futures'])
    expect(body.source_freshness).toHaveLength(1)
    expect(body.traders).toEqual([
      expect.objectContaining({
        id: 'fresh',
        source: 'binance_futures',
        updated_at: '2026-07-18T11:00:00.000Z',
        is_stale: false,
      }),
    ])
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      'public_ranked_leaderboard',
      'verified_traders',
      'leaderboard_source_freshness',
    ])
    expect(rankingQuery.select).toHaveBeenCalledWith(expect.stringContaining('metrics_estimated'))
    // Shared public cohort predicate (lib/rankings/public-cohort.ts): same
    // score floor, ROI bound and 48h window as SSR and /api/rankings.
    expect(rankingQuery.gt).toHaveBeenCalledWith('arena_score', 0)
    expect(rankingQuery.gte).toHaveBeenCalledWith('roi', -50_000)
    expect(rankingQuery.lte).toHaveBeenCalledWith('roi', 50_000)
    expect(rankingQuery.gte).toHaveBeenCalledWith('computed_at', '2026-07-16T12:00:00.000Z')
    expect(rankingQuery.limit).toHaveBeenCalledWith(51)
  })

  it.each([
    ['arena_score', 'arena_score'],
    ['roi', 'roi'],
    ['pnl', 'pnl'],
    ['win_rate', 'win_rate'],
    ['max_drawdown', 'max_drawdown'],
    ['sortino_ratio', 'sortino_ratio'],
  ] as const)('orders the public cohort by supported sortBy=%s', async (sortBy, expectedColumn) => {
    const rankingQuery = publicRankedPageQuery([publicRankedRow()])
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return rankingQuery
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unsupported source relation ${table}`)
    })

    const response = await GET({
      nextUrl: new URL(`http://localhost/api/traders?timeRange=90D&sortBy=${sortBy}&order=asc`),
    } as never)

    expect(response.status).toBe(200)
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      'public_ranked_leaderboard',
      'verified_traders',
      'leaderboard_source_freshness',
    ])
    expect(rankingQuery.order.mock.calls).toEqual([
      [expectedColumn, { ascending: true, nullsFirst: false }],
      ['rank', { ascending: true, nullsFirst: false }],
    ])
    expect((await response.json()).rankingMode).toBe(sortBy)
  })

  it.each(['alpha', 'unpublished_metric'])(
    'rejects unsupported sortBy=%s before cache or DB reads',
    async (sortBy) => {
      const response = await GET({
        nextUrl: new URL(`http://localhost/api/traders?timeRange=90D&sortBy=${sortBy}`),
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each(['timeRange=not-a-period', 'order=sideways', 'limit=0', 'limit=501', 'page=40001'])(
    'rejects malformed explicit scope %s before cache or DB reads',
    async (query) => {
      const response = await GET({
        nextUrl: new URL(`http://localhost/api/traders?${query}`),
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('normalizes a lowercase valid period without changing its cohort', async () => {
    const rankingQuery = publicRankedPageQuery([publicRankedRow()])
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return rankingQuery
      if (table === 'leaderboard_source_freshness') return queryResult([])
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unsupported relation ${table}`)
    })

    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90d'),
    } as never)

    expect(response.status).toBe(200)
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
  })

  it('uses a limit+1 lookahead for rank-cursor pagination and emits no cursor on the final page', async () => {
    const tiedRows = [
      publicRankedRow({ source_trader_id: 'z-rank-one', rank: 1 }),
      publicRankedRow({ source_trader_id: 'a-rank-two', rank: 2 }),
      publicRankedRow({ source_trader_id: 'm-rank-three', rank: 3 }),
    ]
    const rankingQueries: Array<ReturnType<typeof publicRankedPageQuery>> = []
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') {
        const query = publicRankedPageQuery(tiedRows)
        rankingQueries.push(query)
        return query
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const firstResponse = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D&limit=2'),
    } as never)
    const first = await firstResponse.json()
    const secondResponse = await GET({
      nextUrl: new URL(
        `http://localhost/api/traders?timeRange=90D&limit=2&cursor=${first.nextCursor}`
      ),
    } as never)
    const second = await secondResponse.json()

    expect(first.traders.map(({ rank }: { rank: number }) => rank)).toEqual([1, 2])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBe(2)
    expect(second.traders.map(({ rank }: { rank: number }) => rank)).toEqual([3])
    expect(second.hasMore).toBe(false)
    expect(second.nextCursor).toBeNull()
    expect([...first.traders, ...second.traders].map(({ id }: { id: string }) => id)).toEqual([
      'z-rank-one',
      'a-rank-two',
      'm-rank-three',
    ])
    expect(rankingQueries[0].limit).toHaveBeenCalledWith(3)
    expect(rankingQueries[1].limit).toHaveBeenCalledWith(3)
    expect(rankingQueries[1].gt).toHaveBeenCalledWith('rank', 2)
  })

  it('caches only the default page size on page boundaries', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return publicRankedPageQuery([publicRankedRow()])
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })
    const request = (query: string) =>
      GET({ nextUrl: new URL(`http://localhost/api/traders?timeRange=90D&${query}`) } as never)

    for (const query of ['limit=50', 'limit=50&cursor=100', 'limit=50&page=3']) {
      mockGetOrSetWithLock.mockClear()
      expect((await request(query)).status).toBe(200)
      expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
        expect.stringMatching(/^public-rank-policy-v7:leaderboard:v6:public-cohort:/),
        expect.any(Function),
        expect.objectContaining({
          tags: ['rankings:public-rank-policy-v7', 'season:90D'],
          skipMemory: true,
        })
      )
    }
    // Non-canonical limits and off-boundary cursors are served uncached.
    for (const query of ['limit=37', 'limit=200', 'limit=50&cursor=101']) {
      mockGetOrSetWithLock.mockClear()
      const body = await (await request(query)).json()
      expect(body.traders).toHaveLength(query === 'limit=50&cursor=101' ? 0 : 1)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    }
  })

  it('uses an inclusive legacy range for the same limit+1 lookahead without count-cache totals', async () => {
    const rows = [
      publicRankedRow({ source_trader_id: 'rank-one', rank: 1 }),
      publicRankedRow({ source_trader_id: 'rank-two', rank: 2 }),
      publicRankedRow({ source_trader_id: 'rank-three', rank: 3 }),
    ]
    const rankingQueries: Array<ReturnType<typeof publicRankedPageQuery>> = []
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') {
        const query = publicRankedPageQuery(rows)
        rankingQueries.push(query)
        return query
      }
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`old table/count cache must not be queried: ${table}`)
    })

    const first = await (
      await GET({
        nextUrl: new URL('http://localhost/api/traders?timeRange=90D&page=0&limit=2'),
      } as never)
    ).json()
    const last = await (
      await GET({
        nextUrl: new URL('http://localhost/api/traders?timeRange=90D&page=1&limit=2'),
      } as never)
    ).json()

    expect(rankingQueries[0].range).toHaveBeenCalledWith(0, 2)
    expect(rankingQueries[1].range).toHaveBeenCalledWith(2, 4)
    expect(first.hasMore).toBe(true)
    expect(last.hasMore).toBe(false)
    expect(first.totalCount).toBeNull()
    expect(last.totalCountIsExact).toBe(false)
  })

  it('revalidates a raw cached cohort with the complete proof and fails closed on a bad row', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      scope: publicRankedCohortScope(),
      rows: [
        publicRankedRow({ source_trader_id: 'first', rank: 1 }),
        publicRankedRow({ source_trader_id: 'partial', rank: 2, metrics_estimated: true }),
        publicRankedRow({ source_trader_id: 'last', rank: 3 }),
      ],
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'public_ranked_leaderboard') {
        return queryResult([
          { source: 'binance_futures', source_trader_id: 'first' },
          { source: 'binance_futures', source_trader_id: 'last' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected cache-hit query ${table}`)
    })

    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
    } as never)
    const body = await response.json()

    expect(body.traders.map(({ id }: { id: string }) => id)).toEqual(['first', 'last'])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.totalCount).toBeNull()
    expect(body.totalCountIsExact).toBe(false)
    expect(body.ranking_visibility_reasons).toEqual(['ineligible_cached_cohort_row_removed'])
    expect(body.traders[0]).not.toHaveProperty('metrics_estimated')
    expect(body.traders[0]).not.toHaveProperty('season_id')
    expect(body.traders[0]).not.toHaveProperty('source_trader_id')
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      'public_ranked_leaderboard',
      'verified_traders',
      'leaderboard_source_freshness',
    ])
  })

  it('rejects a cross-period raw cache envelope instead of reusing it', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      scope: publicRankedCohortScope({ timeRange: '30D' }),
      rows: [publicRankedRow({ source_trader_id: 'wrong-period' })],
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected malformed-cache query ${table}`)
    })

    const body = await (
      await GET({
        nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
      } as never)
    ).json()

    expect(body.traders).toEqual([])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.totalCount).toBeNull()
    expect(body.totalCountIsExact).toBe(false)
  })

  it('rejects a raw cache row older than the shared 48-hour cohort window', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      scope: publicRankedCohortScope(),
      rows: [
        publicRankedRow({
          source_trader_id: 'served-too-old',
          computed_at: '2026-07-16T11:59:00.000Z',
        }),
      ],
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected stale-cache query ${table}`)
    })

    const body = await (
      await GET({
        nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
      } as never)
    ).json()

    expect(body.traders).toEqual([])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.totalCount).toBeNull()
    expect(body.totalCountIsExact).toBe(false)
    expect(body.ranking_visibility_reasons).toEqual(['ineligible_cached_cohort_row_removed'])
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      'verified_traders',
      'leaderboard_source_freshness',
    ])
  })

  it('does not let a cached row retain a public rank after its source watermark expires', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      scope: publicRankedCohortScope(),
      rows: [publicRankedRow({ source_trader_id: 'source-expired' })],
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-16T11:59:59.999Z' },
        ])
      }
      if (table === 'public_ranked_leaderboard') {
        return queryResult([{ source: 'binance_futures', source_trader_id: 'source-expired' }])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected stale-source cache query ${table}`)
    })

    const body = await (
      await GET({
        nextUrl: new URL('http://localhost/api/traders?timeRange=90D'),
      } as never)
    ).json()

    expect(body.traders).toEqual([])
    expect(body.hasMore).toBe(false)
    expect(body.nextCursor).toBeNull()
    expect(body.isStale).toBe(true)
    expect(body.ranking_visibility_reasons).toEqual(['source_freshness_unverified'])
  })

  it.each(['all', 'not_a_source', 'BINANCE_FUTURES', ' binance_futures'])(
    'rejects non-canonical exchange=%s before cache or DB reads (cache-key amplification)',
    async (exchange) => {
      const response = await GET({
        nextUrl: new URL(
          `http://localhost/api/traders?timeRange=90D&exchange=${encodeURIComponent(exchange)}`
        ),
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each(['limit=201', 'page=1001', 'cursor=50001', 'page=250&limit=201', 'page=1000&limit=51'])(
    'rejects out-of-range paging %s before cache or DB reads',
    async (query) => {
      const response = await GET({
        nextUrl: new URL(`http://localhost/api/traders?timeRange=90D&${query}`),
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('reloads a cached page whose rows the database has since withdrawn', async () => {
    mockGetOrSetWithLock.mockResolvedValue({
      scope: publicRankedCohortScope(),
      rows: [
        publicRankedRow({ source_trader_id: 'kept', rank: 1 }),
        publicRankedRow({ source_trader_id: 'withdrawn', rank: 2 }),
      ],
    })
    const liveRows = [publicRankedRow({ source_trader_id: 'kept', rank: 1 })]
    mockFrom.mockImplementation((table: string) => {
      // The membership read and the reload both see the live view only.
      if (table === 'public_ranked_leaderboard') return publicRankedPageQuery(liveRows)
      if (table === 'leaderboard_source_freshness') {
        return queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
      }
      if (table === 'verified_traders') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const body = await (
      await GET({ nextUrl: new URL('http://localhost/api/traders?timeRange=90D') } as never)
    ).json()

    expect(body.traders.map(({ id }: { id: string }) => id)).toEqual(['kept'])
    expect(body.ranking_visibility_reasons).toBeUndefined()
    // The reloaded page replaces the stale entry under the current fence.
    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v7:leaderboard:v6:public-cohort:/),
      expect.objectContaining({ rows: [expect.objectContaining({ source_trader_id: 'kept' })] }),
      expect.objectContaining({ writeFence: expect.objectContaining({ token: '7' }) })
    )
  })

  it('warms the versioned raw cohort key only after Redis confirms it', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') {
        return publicRankedPageQuery([publicRankedRow({ source_trader_id: 'rank-one' })])
      }
      throw new Error(`warmup must only query the public view, got ${table}`)
    })

    await expect(
      warmDefaultPublicTradersCache({ from: mockFrom } as never, '90D', 50)
    ).resolves.toBe(1)
    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v7:leaderboard:v6:public-cohort:/),
      expect.objectContaining({
        scope: publicRankedCohortScope(),
        rows: [expect.objectContaining({ source_trader_id: 'rank-one', metrics_estimated: false })],
      }),
      {
        ttl: 300,
        tags: ['rankings:public-rank-policy-v7', 'season:90D'],
        skipMemory: true,
        writeFence: { key: 'public-rankings:write-fence:v1', token: '7' },
      }
    )

    mockCacheSet.mockResolvedValueOnce(false)
    await expect(
      warmDefaultPublicTradersCache({ from: mockFrom } as never, '90D', 50)
    ).rejects.toThrow('[90D] public traders Redis cache write was not confirmed')
  })

  it('returns an exact empty result for an explicitly quarantined source without DB access', async () => {
    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?timeRange=90D&exchange=okx_web3_solana'),
    } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({
        traders: [],
        totalCount: 0,
        totalCountIsExact: true,
        availableSources: [],
      })
    )
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects rank cursors that do not match the persisted arena-score order', async () => {
    const response = await GET({
      nextUrl: new URL('http://localhost/api/traders?sortBy=roi&cursor=10'),
    } as never)

    expect(response.status).toBe(400)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
