/**
 * /api/traders server-side cohort filters (audit 2026-11-12 frontend P2-5).
 *
 * Advanced filters / presets are SQL predicates on public_ranked_leaderboard
 * applied before ordering and paging, so every page and `hasMore` describe the
 * filtered cohort. Filtered requests never touch the Redis cohort cache.
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

const mockGetOrSetWithLock = jest.fn(
  async (_key: string, loader: () => Promise<unknown>) => await loader()
)
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (key: string, loader: () => Promise<unknown>) =>
    mockGetOrSetWithLock(key, loader),
  readSharedCacheWriteFence: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/lib/data/verified-traders', () => ({
  getVerifiedTraderKeys: jest.fn().mockResolvedValue(new Set()),
  verifiedTraderKey: (source: string, id: string) => `${source}:${id}`,
}))
jest.mock('@/lib/data/avatar-mirrors', () => ({
  attachAvatarMirrors: jest.fn(async (_supabase: unknown, rows: unknown[]) => rows),
}))
jest.mock('@/lib/data/claimed-trader-badges', () => ({
  getClaimedTraderBadgeKeys: jest.fn().mockResolvedValue(new Set()),
  claimedTraderBadgeKey: (source: string, id: string) => `${source}:${id}`,
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

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

describe('GET /api/traders server-side filters', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  function mockPublicView(rows: Record<string, unknown>[]) {
    const rankingQuery = makeChainableQuery({ data: rows, error: null })
    const freshnessQuery = makeChainableQuery({ data: [freshWatermark()], error: null })
    mockSupabaseQuery.mockImplementation((table: string) => {
      if (table === 'public_ranked_leaderboard') return rankingQuery
      if (table === 'leaderboard_source_freshness') return freshnessQuery
      throw new Error(`Unexpected relation: ${table}`)
    })
    return { rankingQuery }
  }

  it('applies advanced filters + preset in SQL before ordering/paging, uncached', async () => {
    const rows = [
      publicRankedRow({ rank: 51, source_trader_id: 'one' }),
      publicRankedRow({ rank: 52, source_trader_id: 'two' }),
    ]
    const { rankingQuery } = mockPublicView(rows)

    const response = await GET(
      new NextRequest(
        'http://localhost/api/traders?timeRange=90D&limit=1&page=1' +
          '&roi_min=10&roi_max=500&dd_max=30&dd_min=5&min_pnl=1000&min_score=40&min_wr=55' +
          '&grade=A&fex=bybit,binance_futures&fcat=futures,onchain&preset=high_pnl'
      )
    )
    const data = unwrap(await response.json())

    expect(response.status).toBe(200)
    expect(rankingQuery.gte).toHaveBeenCalledWith('roi', 10)
    expect(rankingQuery.lte).toHaveBeenCalledWith('roi', 500)
    expect(rankingQuery.gte).toHaveBeenCalledWith('max_drawdown', -30)
    expect(rankingQuery.lte).toHaveBeenCalledWith('max_drawdown', 30)
    expect(rankingQuery.or).toHaveBeenCalledWith('max_drawdown.gte.5,max_drawdown.lte.-5')
    expect(rankingQuery.gte).toHaveBeenCalledWith('pnl', 1000)
    // preset=high_pnl adds its own predicate (AND with the advanced filters)
    expect(rankingQuery.gte).toHaveBeenCalledWith('pnl', 10_000)
    expect(rankingQuery.gte).toHaveBeenCalledWith('arena_score', 40)
    expect(rankingQuery.gte).toHaveBeenCalledWith('win_rate', 55)
    expect(rankingQuery.gte).toHaveBeenCalledWith('arena_score', 75)
    expect(rankingQuery.lt).toHaveBeenCalledWith('arena_score', 90)
    expect(rankingQuery.in).toHaveBeenCalledWith('source', ['binance_futures', 'bybit'])
    expect(rankingQuery.in).toHaveBeenCalledWith('source_type', ['futures', 'web3'])

    // Filters are applied before the order + page range.
    const firstOrder = rankingQuery.order.mock.invocationCallOrder[0]
    for (const call of rankingQuery.gte.mock.invocationCallOrder) {
      expect(call).toBeLessThan(firstOrder)
    }
    expect(rankingQuery.range).toHaveBeenCalledWith(1, 2)
    // The lookahead row of the FILTERED cohort drives hasMore.
    expect(data.traders).toHaveLength(1)
    expect(data.hasMore).toBe(true)
    // Open-ended filter values never mint Redis cohort keys.
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
  })

  it('keeps the canonical unfiltered page on the Redis cohort cache', async () => {
    const { rankingQuery } = mockPublicView([publicRankedRow()])
    const response = await GET(new NextRequest('http://localhost/api/traders?timeRange=90D'))
    expect(response.status).toBe(200)
    expect(mockGetOrSetWithLock).toHaveBeenCalledTimes(1)
    expect(rankingQuery.in).not.toHaveBeenCalled()
    expect(rankingQuery.or).not.toHaveBeenCalled()
  })

  it('hides idle-window rows by default and still caches that default page', async () => {
    const { rankingQuery } = mockPublicView([publicRankedRow()])
    const response = await GET(new NextRequest('http://localhost/api/traders?timeRange=90D'))
    expect(response.status).toBe(200)
    expect(rankingQuery.eq).toHaveBeenCalledWith('idle_window', false)
    expect(mockGetOrSetWithLock).toHaveBeenCalledTimes(1)
  })

  it('idle=1 lists idle-window rows too, as an uncached cohort of its own', async () => {
    const idleRow = publicRankedRow({
      rank: 4261,
      source_trader_id: 'idle',
      arena_score: 0.01,
      roi: 0,
      pnl: 0,
      win_rate: null,
      max_drawdown: null,
      score_completeness: 'minimal',
      idle_window: true,
    })
    const { rankingQuery } = mockPublicView([idleRow])
    const response = await GET(new NextRequest('http://localhost/api/traders?timeRange=90D&idle=1'))
    const data = unwrap(await response.json())

    expect(response.status).toBe(200)
    expect(rankingQuery.eq).not.toHaveBeenCalledWith('idle_window', false)
    expect(mockGetOrSetWithLock).not.toHaveBeenCalled()
    const traders = data.traders as Array<Record<string, unknown>>
    expect(traders).toHaveLength(1)
    // The flag reaches the client; missing metrics stay missing, never 0.
    expect(traders[0]).toMatchObject({ idle_window: true, win_rate: null, max_drawdown: null })
  })

  it.each([
    ['a non-default sort', 'idle=1&sortBy=roi&page=0'],
    ['ascending score order', 'idle=1&order=asc&page=0'],
    ['another filter', 'idle=1&min_score=10'],
  ])('ignores idle=1 together with %s: idle rows would not stay at the tail', async (_l, query) => {
    const { rankingQuery } = mockPublicView([publicRankedRow()])
    const response = await GET(
      new NextRequest(`http://localhost/api/traders?timeRange=90D&${query}`)
    )
    expect(response.status).toBe(200)
    expect(rankingQuery.eq).toHaveBeenCalledWith('idle_window', false)
  })

  it('rejects any other idle value before database access', async () => {
    mockPublicView([])
    const response = await GET(new NextRequest('http://localhost/api/traders?idle=true'))
    expect(response.status).toBe(400)
    expect(mockSupabaseQuery).not.toHaveBeenCalled()
  })

  it.each([
    'roi_min=abc',
    'roi_min=',
    'roi_min=1e3',
    'dd_max=101',
    'min_wr=-1',
    'min_score=101',
    'grade=Z',
    'preset=bogus',
    'fex=not_a_source',
    'fex=bybit,',
    'fcat=options',
  ])('rejects malformed filter %s before database access', async (query) => {
    mockPublicView([])
    const response = await GET(new NextRequest(`http://localhost/api/traders?${query}`))
    expect(response.status).toBe(400)
    expect(mockSupabaseQuery).not.toHaveBeenCalled()
  })
})
