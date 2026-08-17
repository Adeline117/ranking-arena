/**
 * @jest-environment node
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
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

type QueryResult = {
  data: unknown[] | null
  error: { message: string } | null
}

function queryResult(data: unknown[], error: QueryResult['error'] = null) {
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

import { GET } from '../route'
import { EXCHANGE_SLUG_ALIASES, PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { RETIRED_SOURCES } from '@/lib/constants/retired-sources'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'

const NOW = '2026-08-16T12:00:00.000Z'

function publicRankedRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    source_type: 'futures',
    handle: 'Top Trader',
    avatar_url: null,
    roi: 24.5,
    pnl: 12_000,
    win_rate: 62,
    max_drawdown: 16,
    trades_count: 42,
    followers: 123,
    copiers: null,
    arena_score: 91.5,
    arena_score_v3: 90.2,
    rank: 1,
    computed_at: '2026-08-16T11:59:00.000Z',
    season_id: '90D',
    sharpe_ratio: 1.7,
    sortino_ratio: 2.2,
    calmar_ratio: 1.3,
    profitability_score: 90,
    risk_control_score: 82,
    execution_score: 77,
    score_completeness: 'full',
    metrics_estimated: false,
    trading_style: 'swing',
    avg_holding_hours: 12,
    trader_type: 'human',
    is_outlier: false,
    ...overrides,
  }
}

function freshWatermark(source = 'binance_futures') {
  return { source, source_as_of: '2026-08-16T11:00:00.000Z' }
}

describe('GET /api/v2/rankings public-ranked cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers().setSystemTime(new Date(NOW))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function mockPublicView(
    rows: Record<string, unknown>[],
    sourceRows: Array<{ source: string; source_as_of: string | null }> = [freshWatermark()],
    freshnessError: QueryResult['error'] = null
  ) {
    const rankingQuery = queryResult(rows)
    const freshnessQuery = queryResult(sourceRows, freshnessError)
    mockFrom.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return rankingQuery
      if (table === 'leaderboard_source_freshness') return freshnessQuery
      throw new Error(`unexpected relation ${table}`)
    })
    return { rankingQuery, freshnessQuery }
  }

  it('rejects malformed, duplicate, alpha, and unknown scopes before database access', async () => {
    const urls = [
      'http://localhost/api/v2/rankings',
      'http://localhost/api/v2/rankings?window=90d',
      'http://localhost/api/v2/rankings?window=90D&platform=binance_futures',
      'http://localhost/api/v2/rankings?window=90d&platform=binance',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&limit=501',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&offset=-1',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&limit=2&limit=3',
      'http://localhost/api/v2/rankings?window=90d&platform=fake_exchange',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&sort=alpha',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&min_alpha=1',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&min_roi=Infinity',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&market_type=perp',
      'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&unknown=value',
    ]

    for (const url of urls) {
      const response = await GET({ url } as never)
      expect(response.status).toBe(400)
    }
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('reads only the SQL public cohort, filters/orders before a limit+1 range, and keeps totals unknown', async () => {
    const rows = [
      publicRankedRow({ rank: 5, source_trader_id: 'one' }),
      publicRankedRow({ rank: 6, source_trader_id: 'two' }),
      publicRankedRow({ rank: 7, source_trader_id: 'three' }),
    ]
    const { rankingQuery, freshnessQuery } = mockPublicView(rows)

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&market_type=futures&limit=2&offset=4&sort=sortino&trading_style=high_frequency&min_sortino=1.1&min_roi=10&min_pnl=20&min_win_rate=50&max_drawdown=30&min_score=70',
    } as never)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockFrom.mock.calls.map(([table]) => table)).toEqual([
      'public_ranked_leaderboard',
      'leaderboard_source_freshness',
    ])
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_count_cache')
    expect(rankingQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(rankingQuery.eq).toHaveBeenCalledWith('source_type', 'futures')
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery.eq).toHaveBeenCalledWith('trading_style', 'scalper')
    expect(rankingQuery.gte).toHaveBeenCalledWith('sortino_ratio', 1.1)
    expect(rankingQuery.gte).toHaveBeenCalledWith('roi', 10)
    expect(rankingQuery.gte).toHaveBeenCalledWith('pnl', 20)
    expect(rankingQuery.gte).toHaveBeenCalledWith('win_rate', 50)
    expect(rankingQuery.lte).toHaveBeenCalledWith('max_drawdown', 30)
    expect(rankingQuery.gte).toHaveBeenCalledWith('arena_score', 70)
    expect(rankingQuery.order.mock.calls).toEqual([
      ['sortino_ratio', { ascending: false, nullsFirst: false }],
      ['rank', { ascending: true, nullsFirst: false }],
    ])
    expect(rankingQuery.range).toHaveBeenCalledWith(4, 6)
    expect(freshnessQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(freshnessQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count: null,
        total_count_is_exact: false,
        has_more: true,
        sort: 'sortino',
      })
    )
    expect(body.traders).toHaveLength(2)
    expect(body.traders[0]).toEqual(
      expect.objectContaining({
        trader_key: 'one',
        updated_at: '2026-08-16T11:00:00.000Z',
        is_stale: false,
      })
    )
    expect(body.traders[0].metrics).toEqual(
      expect.objectContaining({
        copiers: null,
        platform_rank: 5,
        sortino_ratio: 2.2,
      })
    )
    expect(body.traders[0]).toEqual(
      expect.objectContaining({
        arena_score_v3: 90.2,
        sortino_ratio: 2.2,
        calmar_ratio: 1.3,
        alpha: null,
        trading_style: 'swing',
      })
    )
  })

  it('uses the upstream source watermark, not recent score computation time, as the hard serving gate', async () => {
    const { rankingQuery } = mockPublicView(
      [publicRankedRow({ computed_at: '2026-08-16T11:59:00.000Z' })],
      [{ source: 'binance_futures', source_as_of: '2026-08-14T09:00:00.000Z' }]
    )

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(rankingQuery).toBeDefined()
    expect(body.traders).toEqual([])
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count: null,
        total_count_is_exact: false,
        has_more: false,
        updated_at: '2026-08-14T09:00:00.000Z',
        staleness_seconds: 51 * 3600,
        is_stale: true,
      })
    )
    expect(body.ranking_visibility_reason).toBe('source_freshness_unverified')
  })

  it('fails closed when the source-watermark lookup itself cannot prove freshness', async () => {
    mockPublicView([publicRankedRow()], [], { message: 'watermark relation unavailable' })

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures',
    } as never)
    const body = await response.json()

    expect(body.traders).toEqual([])
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count: null,
        total_count_is_exact: false,
        updated_at: null,
        staleness_seconds: null,
        is_stale: true,
      })
    )
    expect(body.ranking_visibility_reason).toBe('source_freshness_unverified')
  })

  it.each([
    ['arena_score_v3', 'arena_score_v3'],
    ['calmar', 'calmar_ratio'],
  ] as const)('orders %s by its actual public-view metric', async (sort, column) => {
    const { rankingQuery } = mockPublicView([publicRankedRow()])

    const response = await GET({
      url: `http://localhost/api/v2/rankings?window=90d&platform=binance_futures&sort=${sort}`,
    } as never)

    expect(response.status).toBe(200)
    expect(rankingQuery.order.mock.calls[0]).toEqual([
      column,
      { ascending: false, nullsFirst: false },
    ])
  })

  it('fails the complete page closed if a public view result violates the published-row contract', async () => {
    mockPublicView([
      publicRankedRow({ rank: 5, source_trader_id: 'safe' }),
      publicRankedRow({ rank: 6, source_trader_id: 'estimated', metrics_estimated: true }),
      publicRankedRow({ rank: 7, source_trader_id: 'would-shift-into-page' }),
    ])

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=binance_futures&limit=2',
    } as never)
    const body = await response.json()

    expect(body.traders).toEqual([])
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count: null,
        total_count_is_exact: false,
        has_more: false,
        is_stale: true,
      })
    )
    expect(body.ranking_visibility_reason).toBe('publication_policy_filtered')
  })

  it('uses the canonical source type when market_type is omitted instead of labeling every cohort futures', async () => {
    const { rankingQuery } = mockPublicView(
      [
        publicRankedRow({
          source: 'hyperliquid',
          source_type: 'web3',
          source_trader_id: 'hl-trader',
        }),
      ],
      [freshWatermark('hyperliquid')]
    )

    const response = await GET({
      url: 'http://localhost/api/v2/rankings?window=90d&platform=hyperliquid',
    } as never)
    const body = await response.json()

    expect(rankingQuery.eq).toHaveBeenCalledWith('source_type', 'web3')
    expect(body.meta.market_type).toBe('web3')
    expect(body.traders[0].market_type).toBe('web3')
  })

  it.each(PUBLIC_RANKING_QUARANTINED_SOURCES)(
    'returns an exact empty public scope for quarantined platform %s without database access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.traders).toEqual([])
      expect(body.meta).toEqual(
        expect.objectContaining({ total_count: 0, total_count_is_exact: true, has_more: false })
      )
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each(PUBLIC_ACTIVE_RANKING_SOURCES)(
    'accepts canonical active platform %s at the public API boundary',
    async (platform) => {
      mockFrom.mockImplementation(() => queryResult([]))

      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(200)
    }
  )

  it.each([...RETIRED_SOURCES])(
    'rejects retired platform %s before database access',
    async (platform) => {
      const response = await GET({
        url: `http://localhost/api/v2/rankings?window=90d&platform=${platform}`,
      } as never)

      expect(response.status).toBe(400)
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
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )
})
