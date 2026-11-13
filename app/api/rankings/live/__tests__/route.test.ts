const mockCheckRateLimit = jest.fn()
const mockFrom = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers = new Headers()

    constructor(body: unknown, init: { status?: number } = {}) {
      this.body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
}))

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

type QueryResult = { data: unknown[] | null; error: { message: string } | null }

function query(result: QueryResult) {
  const methods: Record<string, jest.Mock> = {}
  const chain = new Proxy(methods, {
    get(target, property) {
      if (property === 'then') {
        return (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve)
      }
      const key = String(property)
      target[key] ??= jest.fn(() => chain)
      return target[key]
    },
  })
  return chain
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'trader-1',
    handle: 'Top Trader',
    source_type: 'futures',
    roi: 24.5,
    pnl: 12_000,
    win_rate: 62,
    max_drawdown: 16,
    trades_count: 42,
    followers: 123,
    copiers: 12,
    arena_score: 91.5,
    avatar_url: null,
    rank: 1,
    rank_change: 2,
    is_new: false,
    profitability_score: 90,
    risk_control_score: 82,
    execution_score: 77,
    score_completeness: 'full',
    metrics_estimated: false,
    trading_style: 'swing',
    avg_holding_hours: 12,
    style_confidence: 'full',
    sharpe_ratio: 1.7,
    sortino_ratio: 2.2,
    profit_factor: 1.8,
    calmar_ratio: 1.3,
    trader_type: 'human',
    is_outlier: false,
    season_id: '90D',
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function freshQuery(sourceAsOf: string | null = new Date(Date.now() - 60_000).toISOString()) {
  return query({
    data: sourceAsOf === null ? [] : [{ source: 'binance_futures', source_as_of: sourceAsOf }],
    error: null,
  })
}

import type { NextRequest } from 'next/server'
import { GET } from '../route'

function request(path = 'http://localhost/api/rankings/live?period=90D&limit=2&offset=0') {
  return { nextUrl: new URL(path) } as NextRequest
}

describe('GET /api/rankings/live public cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
  })

  it('reads only the public cohort before its lookahead range and leaves totals unknown', async () => {
    const rankingQuery = query({
      data: [
        row(),
        row({ source_trader_id: 'trader-2', rank: 2 }),
        row({ source_trader_id: 'trader-3', rank: 3 }),
      ],
      error: null,
    })
    mockFrom.mockImplementation((relation: string) =>
      relation === 'leaderboard_source_freshness' ? freshQuery() : rankingQuery
    )

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.is_stale).toBe(false)
    expect(body.as_of).not.toBeNull()
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery.order).toHaveBeenCalledWith('rank', { ascending: true, nullsFirst: false })
    expect(rankingQuery.range).toHaveBeenCalledWith(0, 2)
    expect(body).toEqual(
      expect.objectContaining({
        total: null,
        totalCount: null,
        totalCountIsExact: false,
        hasMore: true,
        availableSources: ['binance_futures'],
        availableSourcesIsExact: false,
      })
    )
    expect(body.traders).toHaveLength(2)
    expect(response.headers.get('X-Cache')).toBe('MISS')
  })

  it('fails closed for unknown core metrics instead of rendering them as zero', async () => {
    mockFrom.mockReturnValue(
      query({
        data: [row({ roi: null, arena_score: null, pnl: null, win_rate: null })],
        error: null,
      })
    )

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({
        traders: [],
        totalCount: null,
        hasMore: false,
        ranking_visibility_reason: 'publication_policy_filtered',
      })
    )
    expect(JSON.stringify(body)).not.toContain('"roi":0')
    expect(JSON.stringify(body)).not.toContain('"arena_score":0')
  })

  it('fails the complete finite page closed if a view/proxy response violates row proof', async () => {
    mockFrom.mockReturnValue(
      query({ data: [row(), row({ score_completeness: 'partial', rank: 2 })], error: null })
    )

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({
        traders: [],
        totalCount: null,
        hasMore: false,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'publication_policy_filtered',
      })
    )
  })

  it('fails closed when a displayed source has no trustworthy watermark (no hard-coded fresh)', async () => {
    const rankingQuery = query({ data: [row()], error: null })
    mockFrom.mockImplementation((relation: string) =>
      relation === 'leaderboard_source_freshness' ? freshQuery(null) : rankingQuery
    )

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual(
      expect.objectContaining({
        traders: [],
        is_stale: true,
        hasMore: false,
        ranking_visibility_reason: 'source_freshness_unverified',
      })
    )
  })

  it('rejects malformed, repeated, unknown, or oversized scopes before querying', async () => {
    const urls = [
      'http://localhost/api/rankings/live?period=wrong',
      'http://localhost/api/rankings/live?limit=201',
      'http://localhost/api/rankings/live?offset=-1',
      'http://localhost/api/rankings/live?period=90D&period=7D',
      'http://localhost/api/rankings/live?unexpected=value',
    ]
    for (const url of urls) {
      const response = await GET(request(url))
      expect(response.status).toBe(400)
    }
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns a server error when the verified cohort query itself fails', async () => {
    mockFrom.mockReturnValue(query({ data: null, error: { message: 'view unavailable' } }))

    const response = await GET(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Query failed' })
  })
})
