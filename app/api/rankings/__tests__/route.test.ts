/**
 * /api/rankings public-cohort contract tests.
 *
 * The route's safety boundary is the SQL security-barrier view. These tests
 * deliberately assert table selection, predicate/range ordering, strict scope
 * validation, and the absence of fabricated totals.
 */

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map(Object.entries(init.headers || {}))
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string

    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) })
      )
      this.method = opts?.method || 'GET'
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {} },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

const mockSupabaseQuery = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: (...args: unknown[]) => mockSupabaseQuery(...args),
  })),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
  getCorrelationId: jest.fn().mockReturnValue('test-cid'),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { PUBLIC_RANKING_QUARANTINED_SOURCES } from '@/lib/rankings/publication-policy'

type QueryResult = { data: unknown[] | null; error: { message: string } | null }

/** A chainable, awaitable PostgREST mock which records every SQL builder call. */
function makeChainableQuery(result: QueryResult = { data: [], error: null }) {
  const storage: Record<string, jest.Mock> = {}
  const chain = new Proxy(storage, {
    get(target, prop) {
      const key = prop as string
      if (key === 'then') {
        return (resolve: (value: QueryResult) => void) => Promise.resolve(result).then(resolve)
      }
      if (key === 'catch' || key === 'finally') return undefined
      if (!target[key]) target[key] = jest.fn(() => chain)
      return target[key]
    },
  })
  return chain
}

function nowIso(deltaMs = 0): string {
  return new Date(Date.now() + deltaMs).toISOString()
}

function publicRankedRow(overrides: Record<string, unknown> = {}) {
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
    computed_at: nowIso(-60_000),
    profitability_score: 90,
    risk_control_score: 82,
    execution_score: 77,
    score_completeness: 'full',
    metrics_estimated: false,
    trading_style: 'swing',
    avg_holding_hours: 12,
    sharpe_ratio: 1.7,
    sortino_ratio: 2.2,
    calmar_ratio: 1.3,
    profit_factor: 1.8,
    trader_type: 'human',
    is_outlier: false,
    season_id: '90D',
    ...overrides,
  }
}

function freshWatermark(source = 'binance_futures') {
  return { source, source_as_of: nowIso(-60_000) }
}

function unwrap(body: unknown): Record<string, unknown> {
  const record = body as { data?: Record<string, unknown> }
  return record.data ?? (body as Record<string, unknown>)
}

describe('GET /api/rankings public-ranked cohort', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSupabaseQuery.mockReturnValue(makeChainableQuery())
  })

  function mockPublicView(
    rows: Record<string, unknown>[],
    sourceRows: Array<{ source: string; source_as_of: string | null }> = [freshWatermark()]
  ) {
    const rankingQuery = makeChainableQuery({ data: rows, error: null })
    const freshnessQuery = makeChainableQuery({ data: sourceRows, error: null })
    mockSupabaseQuery.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return rankingQuery
      if (table === 'leaderboard_source_freshness') return freshnessQuery
      throw new Error(`Unexpected relation: ${table}`)
    })
    return { rankingQuery, freshnessQuery }
  }

  it('rejects missing or malformed ranking scope before database access', async () => {
    const urls = [
      'http://localhost/api/rankings',
      'http://localhost/api/rankings?window=999d',
      'http://localhost/api/rankings?window=90d&sort_by=alpha',
      'http://localhost/api/rankings?window=90d&sort_dir=sideways',
      'http://localhost/api/rankings?window=90d&limit=501',
      'http://localhost/api/rankings?window=90d&offset=-1',
      'http://localhost/api/rankings?window=90d&min_trades=1.5',
      'http://localhost/api/rankings?window=90d&cursor=1',
      'http://localhost/api/rankings?window=90d&unknown=value',
      'http://localhost/api/rankings?window=90d&limit=2&limit=3',
    ]

    for (const url of urls) {
      const response = await GET(new NextRequest(url))
      expect(response.status).toBe(400)
    }
    expect(mockSupabaseQuery).not.toHaveBeenCalled()
  })

  it('reads only the public cohort view, applies SQL predicates before its lookahead range, and keeps totals unknown', async () => {
    const rows = [
      publicRankedRow({ rank: 5, source_trader_id: 'one' }),
      publicRankedRow({ rank: 6, source_trader_id: 'two' }),
      publicRankedRow({ rank: 7, source_trader_id: 'three' }),
    ]
    const { rankingQuery, freshnessQuery } = mockPublicView(rows)

    const response = await GET(
      new NextRequest(
        'http://localhost/api/rankings?window=90d&limit=2&offset=4&sort_by=roi&sort_dir=asc&min_pnl=10&min_trades=2&trader_type=human'
      )
    )
    const data = unwrap(await response.json())

    expect(response.status).toBe(200)
    expect(mockSupabaseQuery.mock.calls.map(([table]) => table)).toEqual([
      'public_ranked_leaderboard',
      'leaderboard_source_freshness',
    ])
    expect(mockSupabaseQuery).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockSupabaseQuery).not.toHaveBeenCalledWith('leaderboard_count_cache')
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(rankingQuery.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(rankingQuery.gte).toHaveBeenCalledWith('pnl', 10)
    expect(rankingQuery.gte).toHaveBeenCalledWith('trades_count', 2)
    expect(rankingQuery.neq).toHaveBeenCalledWith('source', 'web3_bot')
    expect(rankingQuery.order.mock.calls).toEqual([
      ['roi', { ascending: true, nullsFirst: false }],
      ['rank', { ascending: true, nullsFirst: false }],
    ])
    expect(rankingQuery.range).toHaveBeenCalledWith(4, 6)
    expect(freshnessQuery.in).toHaveBeenCalledWith('source', ['binance_futures'])
    expect(data.traders).toHaveLength(2)
    expect(data.hasMore).toBe(true)
    expect(data.totalCount).toBeNull()
    expect(data.totalcount).toBeNull()
    expect(data.total_count).toBeNull()
    expect(data.totalCountIsExact).toBe(false)
    expect(data.availableSources).toEqual(['binance_futures'])
    expect(data.availableSourcesIsExact).toBe(false)
    expect((data.traders as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        rank: 5,
        roi: 24.5,
        updated_at: expect.any(String),
        is_stale: false,
      })
    )
  })

  it('uses public-view source_type for category filtering and lets an explicit platform take precedence', async () => {
    const category = mockPublicView([publicRankedRow({ source_type: 'web3' })])
    await GET(new NextRequest('http://localhost/api/rankings?window=90d&category=onchain'))
    expect(category.rankingQuery.eq).toHaveBeenCalledWith('source_type', 'web3')

    const platform = mockPublicView([publicRankedRow()])
    await GET(
      new NextRequest(
        'http://localhost/api/rankings?window=90d&category=onchain&platform=binance_futures'
      )
    )
    expect(platform.rankingQuery.eq).toHaveBeenCalledWith('source', 'binance_futures')
    expect(platform.rankingQuery.eq).not.toHaveBeenCalledWith('source_type', 'web3')
  })

  it('serves composite from the published 90D cohort and labels it 90D (no fake COMPOSITE)', async () => {
    const { rankingQuery } = mockPublicView([publicRankedRow()])
    const response = await GET(new NextRequest('http://localhost/api/rankings?window=composite'))
    const data = unwrap(await response.json())

    expect(response.status).toBe(200)
    expect(rankingQuery.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(data.window).toBe('90D')
  })

  it('fails closed when a displayed source has no trustworthy source watermark', async () => {
    mockPublicView([publicRankedRow()], [])

    const response = await GET(new NextRequest('http://localhost/api/rankings?window=90d'))
    const data = unwrap(await response.json())

    expect(response.status).toBe(200)
    expect(data.traders).toEqual([])
    expect(data.hasMore).toBe(false)
    expect(data.totalCount).toBeNull()
    expect(data.ranking_visibility_reason).toBe('source_freshness_unverified')
  })

  it('fails a compromised public-view page closed without inventing a continuation or total', async () => {
    mockPublicView([
      publicRankedRow({ source_trader_id: 'safe', rank: 1 }),
      publicRankedRow({ source_trader_id: 'bad', rank: 2, metrics_estimated: true }),
    ])

    const response = await GET(new NextRequest('http://localhost/api/rankings?window=90d&limit=1'))
    const data = unwrap(await response.json())

    expect(response.status).toBe(200)
    expect(data.traders).toEqual([])
    expect(data.hasMore).toBe(false)
    expect(data.totalCount).toBeNull()
    expect(data.ranking_visibility_reason).toBe('publication_policy_filtered')
  })

  it.each(PUBLIC_RANKING_QUARANTINED_SOURCES)(
    'returns a policy-exact empty scope for quarantined platform %s without a database read',
    async (platform) => {
      const response = await GET(
        new NextRequest(`http://localhost/api/rankings?window=90d&platform=${platform}`)
      )
      const data = unwrap(await response.json())

      expect(response.status).toBe(200)
      expect(data).toEqual(
        expect.objectContaining({
          traders: [],
          totalCount: 0,
          totalCountIsExact: true,
          hasMore: false,
        })
      )
      expect(mockSupabaseQuery).not.toHaveBeenCalled()
    }
  )
})
