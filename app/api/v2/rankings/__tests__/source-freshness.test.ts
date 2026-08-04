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
  withPublic: (handler: (context: unknown) => unknown) => (request: { url: string }) =>
    handler({ supabase: { from: mockFrom }, request }),
}))

const mockGetOrSetWithLock = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

function queryResult(data: unknown[], error: unknown = null, count: number | null = null) {
  const result = { data, error, count }
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

const COUNT_GENERATION = '2026-07-18T11:58:00.000Z'

function countAuthorityRows(source: string, total: number) {
  return [
    { source: '_all_gt0', total_count: total, updated_at: COUNT_GENERATION },
    { source: `${source}_gt0`, total_count: total, updated_at: COUNT_GENERATION },
  ]
}

import { GET } from '../route'
import { EXCHANGE_SLUG_ALIASES, PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { RETIRED_SOURCES } from '@/lib/constants/retired-sources'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'

describe('GET /api/v2/rankings source freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetOrSetWithLock.mockImplementation(
      async (_key: string, fetcher: () => Promise<unknown>) => await fetcher()
    )
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('uses the requested platform watermark instead of its recent score compute time', async () => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    let freshnessQuery: ReturnType<typeof queryResult> | undefined
    let countQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult(
          [
            {
              source: 'binance_futures',
              source_trader_id: 'trader',
              source_type: 'futures',
              handle: 'Trader',
              roi: 10,
              pnl: 100,
              arena_score: 90,
              arena_score_v3: 88,
              sortino_ratio: 2.5,
              calmar_ratio: 3.5,
              rank: 1,
              computed_at: '2026-07-18T11:59:00.000Z',
              season_id: '90D',
            },
          ],
          null,
          1
        )
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        countQuery = queryResult(countAuthorityRows('binance_futures', 1))
        return countQuery
      }
      if (table === 'leaderboard_source_freshness') {
        freshnessQuery = queryResult([
          {
            source: 'binance_futures',
            source_as_of: '2026-07-16T09:00:00.000Z',
          },
        ])
        return freshnessQuery
      }
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(body.meta).toEqual(
      expect.objectContaining({
        updated_at: '2026-07-16T09:00:00.000Z',
        staleness_seconds: 51 * 3600,
        is_stale: true,
      })
    )
    expect(body.traders[0]).toEqual(
      expect.objectContaining({
        updated_at: '2026-07-16T09:00:00.000Z',
        is_stale: true,
        computed_at: '2026-07-18T11:59:00.000Z',
      })
    )
    expect(rankingQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(rankingQuery?.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery?.gt).toHaveBeenCalledWith('arena_score', 0)
    expect(rankingQuery?.eq).not.toHaveBeenCalledWith('source_type', expect.anything())
    expect(rankingQuery?.select).toHaveBeenCalledWith(
      expect.stringContaining(
        'arena_score_v3,rank,computed_at,sharpe_ratio,sortino_ratio,calmar_ratio'
      ),
      { count: 'planned' }
    )
    expect(rankingQuery?.select).not.toHaveBeenCalledWith(expect.anything(), { count: 'exact' })
    expect(rankingQuery?.order.mock.calls.slice(0, 2)).toEqual([
      ['arena_score', { ascending: false, nullsFirst: false }],
      ['rank', { ascending: true, nullsFirst: false }],
    ])
    expect(freshnessQuery?.not).toHaveBeenCalledWith(
      'source',
      'in',
      '(okx_web3_solana,bitget_bots_futures,bitget_bots_spot)'
    )
    expect(countQuery?.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(countQuery?.like).toHaveBeenCalledWith('source', '%_gt0')
    expect(body.meta).toEqual(
      expect.objectContaining({ total_count: 1, total_count_is_estimate: false })
    )
  })

  it('uses persisted V3 metrics and planner counts for every filtered cohort', async () => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    let freshnessQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult(
          [
            {
              source: 'binance_futures',
              source_trader_id: 'v3-trader',
              source_type: 'futures',
              handle: 'V3 Trader',
              roi: 12,
              pnl: 345,
              win_rate: 67,
              max_drawdown: 8,
              arena_score: 91,
              arena_score_v3: 93.5,
              sharpe_ratio: 1.1,
              sortino_ratio: 2.75,
              calmar_ratio: 4.25,
              trading_style: 'scalper',
              rank: 4,
              computed_at: '2026-07-18T11:59:00.000Z',
            },
          ],
          null,
          42
        )
        return rankingQuery
      }
      if (table === 'leaderboard_source_freshness') {
        freshnessQuery = queryResult([
          { source: 'binance_futures', source_as_of: '2026-07-18T11:00:00.000Z' },
        ])
        return freshnessQuery
      }
      if (table === 'leaderboard_count_cache') {
        throw new Error('filtered requests must not read the unfiltered count authority')
      }
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url:
        'http://localhost/api/v2/rankings?window=90d&platform=binance_futures' +
        '&market_type=futures&sort=sortino&limit=17&offset=3' +
        '&trading_style=high_frequency&min_sortino=1.25&min_roi=2&min_pnl=3' +
        '&min_win_rate=4&max_drawdown=5&min_score=6',
    } as never)
    const body = await response.json()

    expect(rankingQuery?.select).toHaveBeenCalledWith(expect.stringContaining('arena_score_v3'), {
      count: 'planned',
    })
    expect(rankingQuery?.select).not.toHaveBeenCalledWith(expect.anything(), { count: 'exact' })
    expect(rankingQuery?.eq).toHaveBeenCalledWith('source_type', 'futures')
    expect(rankingQuery?.eq).toHaveBeenCalledWith('trading_style', 'scalper')
    expect(rankingQuery?.gte).toHaveBeenCalledWith('sortino_ratio', 1.25)
    expect(rankingQuery?.gte).toHaveBeenCalledWith('roi', 2)
    expect(rankingQuery?.gte).toHaveBeenCalledWith('pnl', 3)
    expect(rankingQuery?.gte).toHaveBeenCalledWith('win_rate', 4)
    expect(rankingQuery?.lte).toHaveBeenCalledWith('max_drawdown', 5)
    expect(rankingQuery?.gte).toHaveBeenCalledWith('arena_score', 6)
    expect(rankingQuery?.order.mock.calls.slice(0, 2)).toEqual([
      ['sortino_ratio', { ascending: false, nullsFirst: false }],
      ['rank', { ascending: true, nullsFirst: false }],
    ])
    expect(rankingQuery?.range).toHaveBeenCalledWith(3, 19)
    expect(body.meta).toEqual(
      expect.objectContaining({
        market_type: 'futures',
        total_count: 42,
        total_count_is_estimate: true,
      })
    )
    expect(body.traders[0]).toEqual(
      expect.objectContaining({
        arena_score_v3: 93.5,
        sortino_ratio: 2.75,
        calmar_ratio: 4.25,
        alpha: null,
        metrics: expect.objectContaining({ sortino_ratio: 2.75 }),
      })
    )

    const cacheKey = mockGetOrSetWithLock.mock.calls[0]?.[0] as string
    for (const fragment of [
      'platform=binance_futures',
      'window=90d',
      'market_type_filter=futures',
      'sort=sortino',
      'offset=3',
      'limit=17',
      'trading_style=scalper',
      'min_sortino=1.25',
      'min_roi=2',
      'min_pnl=3',
      'min_win_rate=4',
      'max_drawdown=5',
      'min_score=6',
    ]) {
      expect(cacheKey).toContain(fragment)
    }
  })

  it.each([
    ['arena_score_v3', 'arena_score_v3'],
    ['calmar', 'calmar_ratio'],
  ] as const)('sort=%s orders by its authoritative column', async (sort, column) => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult([], null, 0)
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult(countAuthorityRows('binance_futures', 0))
      }
      if (table === 'leaderboard_source_freshness') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    await GET({
      url: `http://localhost/api/v2/rankings?window=90d&platform=binance_futures&sort=${sort}`,
    } as never)

    expect(rankingQuery?.order.mock.calls[0]).toEqual([
      column,
      { ascending: false, nullsFirst: false },
    ])
  })

  it('derives a source market for metadata without filtering an omitted market_type', async () => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult([], null, 999)
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult(countAuthorityRows('binance_spot', 7))
      }
      if (table === 'leaderboard_source_freshness') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_spot',
    } as never)
    const body = await response.json()

    expect(rankingQuery?.eq).not.toHaveBeenCalledWith('source_type', expect.anything())
    expect(rankingQuery?.select).toHaveBeenCalledWith(expect.any(String), { count: 'planned' })
    expect(body.meta).toEqual(
      expect.objectContaining({
        market_type: 'spot',
        total_count: 7,
        total_count_is_estimate: false,
      })
    )
  })

  it('falls back to a clamped planner count when the count authority query fails', async () => {
    let rankingQuery: ReturnType<typeof queryResult> | undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') {
        rankingQuery = queryResult(
          [
            {
              source: 'binance_futures',
              source_trader_id: 'visible-trader',
              source_type: 'futures',
              arena_score: 80,
              rank: 6,
            },
          ],
          null,
          0
        )
        return rankingQuery
      }
      if (table === 'leaderboard_count_cache') {
        return queryResult([], { message: 'count cache unavailable' })
      }
      if (table === 'leaderboard_source_freshness') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&offset=5',
    } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(rankingQuery?.select).toHaveBeenCalledWith(expect.any(String), { count: 'planned' })
    expect(body.traders).toHaveLength(1)
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count: 6,
        total_count_is_estimate: true,
      })
    )
  })

  it('falls back to the planner count when the count authority generation is missing', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'leaderboard_ranks') return queryResult([], null, 23)
      if (table === 'leaderboard_count_cache') {
        return queryResult([
          {
            source: 'binance_futures_gt0',
            total_count: 99,
            updated_at: COUNT_GENERATION,
          },
        ])
      }
      if (table === 'leaderboard_source_freshness') return queryResult([])
      throw new Error(`unexpected table ${table}`)
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count: 23,
        total_count_is_estimate: true,
      })
    )
  })

  it.each(['sort=alpha', 'min_alpha=1', 'sort=arena_score&min_alpha='])(
    'rejects unsupported alpha authority request %s',
    async (query) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=binance_futures&${query}`,
      } as never)
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body).toEqual(
        expect.objectContaining({
          error: 'Unsupported ranking metric',
        })
      )
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('rejects market types outside the shared MARKET_TYPES enum', async () => {
    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&market_type=onchain',
    } as never)

    expect(response.status).toBe(400)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('sanitizes a polluted cache hit and epochs the reader/writer key together', async () => {
    const first = { source: 'binance_futures', source_trader_id: 'first' }
    const last = { source: 'binance_futures', source_trader_id: 'last' }
    mockGetOrSetWithLock.mockResolvedValue({
      traders: [first, { source: 'okx_web3_solana', source_trader_id: 'blocked' }, last],
      meta: {
        platform: 'binance_futures',
        market_type: 'futures',
        window: '90d',
        total_count: 999,
        updated_at: 'blocked-aggregate-watermark',
        staleness_seconds: 1,
        is_stale: false,
        source_freshness: [
          { source: 'binance_futures', updated_at: 'safe' },
          { source: 'okx_web3_solana', updated_at: 'blocked' },
        ],
      },
    })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      expect.stringMatching(/^public-rank-policy-v6:v2-rankings:v4:/),
      expect.any(Function),
      expect.any(Object)
    )
    expect(body.traders).toEqual([first, last])
    expect(body.meta.total_count).toBe(2)
    expect(body.meta.updated_at).toBeNull()
    expect(body.meta.staleness_seconds).toBeNull()
    expect(body.meta.is_stale).toBe(true)
    expect(body.meta.source_freshness).toEqual([{ source: 'binance_futures', updated_at: 'safe' }])
  })

  it.each(PUBLIC_ACTIVE_RANKING_SOURCES)(
    'accepts canonical active platform %s at the v2 public API boundary',
    async (platform) => {
      mockFrom.mockImplementation((table: string) =>
        table === 'leaderboard_count_cache'
          ? queryResult(countAuthorityRows(platform, 0))
          : queryResult([])
      )

      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(200)
    }
  )

  it.each(PUBLIC_RANKING_QUARANTINED_SOURCES)(
    'returns 200 empty for quarantined platform %s without DB or cache access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.traders).toEqual([])
      expect(body.meta).toEqual(expect.objectContaining({ platform, total_count: 0 }))
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([...RETIRED_SOURCES])(
    'rejects retired platform %s before cache or database access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each(Object.keys(EXCHANGE_SLUG_ALIASES))(
    'rejects non-canonical platform alias %s consistently',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${encodeURIComponent(platform)}`,
      } as never)

      expect(response.status).toBe(400)
      expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('continues to reject unknown platforms', async () => {
    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=fake_exchange',
    } as never)

    expect(response.status).toBe(400)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
