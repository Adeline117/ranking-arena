const mockCheckRateLimitFull = jest.fn()
const mockGetLeaderboard = jest.fn()
const mockGetTraderDetail = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    readonly status: number
    readonly headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    async text() {
      return String(this.body ?? '')
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    readonly url: string
    readonly nextUrl: URL
    readonly headers: Headers

    constructor(url: string, init: { headers?: HeadersInit } = {}) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Headers(init.headers)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitFull: (...args: unknown[]) => mockCheckRateLimitFull(...args),
}))

jest.mock('@/lib/data/unified', () => ({
  getLeaderboard: (...args: unknown[]) => mockGetLeaderboard(...args),
  getTraderDetail: (...args: unknown[]) => mockGetTraderDetail(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}))

const mockLogWarn = jest.fn()
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
const PRIVATE_NO_STORE = 'private, no-store, max-age=0, must-revalidate'

function request(path: string, headers?: HeadersInit) {
  return new NextRequest(`http://localhost${path}`, { headers })
}

type PublicRankedQueryResponse = {
  data?: unknown[] | null
  error?: { message: string } | null
}

type PublicRankedQueryMock = Record<string, jest.Mock> & {
  then: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>['then']
}

function publicRankedQuery(response: PublicRankedQueryResponse = {}): PublicRankedQueryMock {
  const query = {} as PublicRankedQueryMock
  for (const method of ['select', 'eq', 'not', 'or', 'order', 'limit']) {
    query[method] = jest.fn(() => query)
  }
  const settled = {
    data: response.data ?? [],
    error: response.error ?? null,
  }
  query.then = ((onfulfilled, onrejected) =>
    Promise.resolve(settled).then(onfulfilled, onrejected)) as PublicRankedQueryMock['then']
  return query
}

function publicSearchRow(overrides: Record<string, unknown> = {}) {
  return {
    source: 'binance_futures',
    source_trader_id: 'alice',
    handle: 'Alice Whale',
    avatar_url: null,
    source_type: 'futures',
    season_id: '90D',
    rank: 1,
    arena_score: 92,
    roi: 12.5,
    pnl: 5000,
    win_rate: 62,
    max_drawdown: 8,
    trades_count: 42,
    followers: 12,
    copiers: 0,
    profitability_score: 40,
    risk_control_score: 30,
    execution_score: 20,
    score_completeness: 'full',
    metrics_estimated: false,
    trader_type: 'human',
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('GET /api/v3 cache and publication boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimitFull.mockReset()
    mockGetLeaderboard.mockReset()
    mockGetTraderDetail.mockReset()
    mockFrom.mockReset()
    mockRpc.mockReset()
    mockCheckRateLimitFull.mockResolvedValue({
      response: null,
      meta: { remaining: 73 },
    })
    mockGetLeaderboard.mockResolvedValue({
      traders: [
        {
          platform: 'binance_futures',
          traderKey: 'alice',
          handle: 'Alice',
          rank: 1,
          roi: 12,
        },
      ],
      total: 1,
    })
    mockGetTraderDetail.mockResolvedValue(null)
  })

  it('keeps successful JSON private when its metadata contains a caller quota', async () => {
    const response = await GET(request('/api/v3?endpoint=rankings'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
    expect(body.meta).toEqual(
      expect.objectContaining({
        credits_remaining: 73,
        rate_limit: { daily_limit: 100, remaining: 73 },
      })
    )
  })

  it('keeps CSV exports private after performing caller-specific rate limiting', async () => {
    const response = await GET(request('/api/v3?endpoint=rankings&format=csv'))
    const csv = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
    expect(mockCheckRateLimitFull).toHaveBeenCalledTimes(1)
    expect(csv).toContain('platform,traderKey,handle,rank,roi')
  })

  it('keeps free-tier 429 quota metadata private', async () => {
    mockCheckRateLimitFull.mockResolvedValue({
      response: { status: 429 },
      meta: { remaining: 0 },
    })

    const response = await GET(request('/api/v3?endpoint=rankings'))
    const body = await response.json()

    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('cache-control')).not.toMatch(/\bpublic\b|s-maxage/i)
    expect(response.headers.get('retry-after')).toBe('86400')
    expect(body.meta).toEqual(
      expect.objectContaining({
        credits_remaining: 0,
        rate_limit: { daily_limit: 100, remaining: 0 },
      })
    )
    expect(mockGetLeaderboard).not.toHaveBeenCalled()
  })

  it('builds each platform count from the sealed 90D cohort, never the retained raw table', async () => {
    const query = publicRankedQuery({
      data: [
        publicSearchRow(),
        publicSearchRow({ source_trader_id: 'alice-2', rank: 2 }),
        publicSearchRow({ source: 'bybit', source_trader_id: 'bob', rank: 3 }),
      ],
    })
    mockFrom.mockImplementation((relation: string) => {
      if (relation !== 'public_ranked_leaderboard') {
        throw new Error(`Unexpected relation ${relation}`)
      }
      return query
    })

    const response = await GET(request('/api/v3?endpoint=platforms'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(query.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(query.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'binance_futures', traderCount: 2 }),
        expect.objectContaining({ key: 'bybit', traderCount: 1 }),
      ])
    )
    expect(body.meta).toEqual(expect.objectContaining({ total_count_is_exact: true, total: 2 }))
  })

  it('counts each platform without idle-window rows', async () => {
    const query = publicRankedQuery({
      data: [
        publicSearchRow(),
        publicSearchRow({ source_trader_id: 'alice-2', rank: 2 }),
        publicSearchRow({ source: 'bybit', source_trader_id: 'bob', rank: 3 }),
      ],
    })
    mockFrom.mockReturnValueOnce(query)

    const response = await GET(request('/api/v3?endpoint=platforms'))
    const body = await response.json()

    expect(query.eq).toHaveBeenCalledWith('idle_window', false)
    // Old rule (no idle row): the predicate removes nothing, same counts.
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'binance_futures', traderCount: 2 }),
        expect.objectContaining({ key: 'bybit', traderCount: 1 }),
      ])
    )
  })

  it('does not reuse a stale platform count between requests', async () => {
    const firstQuery = publicRankedQuery({
      data: [publicSearchRow(), publicSearchRow({ source_trader_id: 'alice-2', rank: 2 })],
    })
    const currentQuery = publicRankedQuery({ data: [publicSearchRow()] })
    mockFrom.mockReturnValueOnce(firstQuery).mockReturnValueOnce(currentQuery)

    const first = await GET(request('/api/v3?endpoint=platforms'))
    const second = await GET(request('/api/v3?endpoint=platforms'))
    const firstBody = await first.json()
    const secondBody = await second.json()

    expect(firstBody.data).toContainEqual(
      expect.objectContaining({ key: 'binance_futures', traderCount: 2 })
    )
    expect(secondBody.data).toContainEqual(
      expect.objectContaining({ key: 'binance_futures', traderCount: 1 })
    )
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('makes a malformed platform cohort partial instead of emitting a shortened count map', async () => {
    const query = publicRankedQuery({
      data: [
        publicSearchRow(),
        {
          source: 'binance_futures',
          source_trader_id: 'unverified',
          season_id: '90D',
          rank: 2,
        },
      ],
    })
    mockFrom.mockReturnValue(query)

    const response = await GET(request('/api/v3?endpoint=platforms&format=csv'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).not.toBe('text/csv; charset=utf-8')
    expect(body.data).toEqual([])
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count_is_exact: false,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'public_cohort_unverified',
      })
    )
  })

  it('searches only the sealed public cohort and omits an unprovable search total', async () => {
    const query = publicRankedQuery({ data: [publicSearchRow()] })
    mockFrom.mockReturnValue(query)

    const response = await GET(request('/api/v3?endpoint=search&q=alice&limit=5'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('public_ranked_leaderboard')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(query.eq).toHaveBeenCalledWith('season_id', '90D')
    expect(query.not).toHaveBeenCalledWith('rank', 'is', null)
    expect(query.or).toHaveBeenCalledWith('handle.ilike.%alice%,source_trader_id.ilike.%alice%')
    expect(body.data).toEqual([
      expect.objectContaining({
        platform: 'binance_futures',
        traderKey: 'alice',
        rank: 1,
        arenaScore: 92,
      }),
    ])
    expect(body.meta).toEqual(expect.objectContaining({ total_count_is_exact: false }))
    expect(body.meta.total).toBeUndefined()
  })

  it('drops one search row that fails the proof, logs the count, and returns the rest', async () => {
    const query = publicRankedQuery({
      data: [
        publicSearchRow(),
        publicSearchRow({ source_trader_id: 'alice-estimated', rank: 2, metrics_estimated: true }),
        publicSearchRow({ source_trader_id: 'alice-3', handle: 'Alice Three', rank: 3 }),
      ],
    })
    mockFrom.mockReturnValue(query)
    mockLogWarn.mockClear()

    const response = await GET(request('/api/v3?endpoint=search&q=alice&limit=5'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.map((trader: { traderKey: string }) => trader.traderKey)).toEqual([
      'alice',
      'alice-3',
    ])
    expect(body.meta).toEqual(expect.objectContaining({ total_count_is_exact: false }))
    expect(body.meta.ranking_visibility).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('alice-estimated')
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('dropped rows'),
      expect.objectContaining({ dropped: 1, kept: 2 })
    )
  })

  it('returns the same search response as before when every row passes (old rule)', async () => {
    const query = publicRankedQuery({
      data: [
        publicSearchRow(),
        publicSearchRow({ source_trader_id: 'alice-3', handle: 'Alice Three', rank: 3 }),
      ],
    })
    mockFrom.mockReturnValue(query)
    mockLogWarn.mockClear()

    const response = await GET(request('/api/v3?endpoint=search&q=alice&limit=5'))
    const body = await response.json()

    expect(body.data).toEqual([
      expect.objectContaining({ platform: 'binance_futures', traderKey: 'alice', rank: 1 }),
      expect.objectContaining({ platform: 'binance_futures', traderKey: 'alice-3', rank: 3 }),
    ])
    expect(body.meta).toEqual(expect.objectContaining({ total_count_is_exact: false }))
    expect(body.meta.total).toBeUndefined()
    expect(body.meta.ranking_visibility).toBeUndefined()
    expect(mockLogWarn).not.toHaveBeenCalled()
  })

  it('still marks the search unverified, with no rows, when every row fails the proof', async () => {
    const query = publicRankedQuery({
      data: [
        {
          source: 'binance_futures',
          source_trader_id: 'alice',
          season_id: '90D',
          rank: 1,
        },
      ],
    })
    mockFrom.mockReturnValue(query)

    const response = await GET(request('/api/v3?endpoint=search&q=alice'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.meta).toEqual(
      expect.objectContaining({
        total_count_is_exact: false,
        ranking_visibility: 'partial',
        ranking_visibility_reason: 'public_cohort_unverified',
      })
    )
  })

  it('does not promote a page or an upstream fallback count to a rankings total', async () => {
    mockGetLeaderboard.mockResolvedValueOnce({
      traders: [
        {
          platform: 'binance_futures',
          traderKey: 'alice',
          handle: 'Alice',
          rank: 1,
          roi: 12,
        },
      ],
      total: 9_999,
      totalCountIsExact: false,
      hasMore: true,
    })

    const response = await GET(request('/api/v3?endpoint=rankings'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.meta).toEqual(
      expect.objectContaining({ total_count_is_exact: false, has_more: true })
    )
    expect(body.meta.total).toBeUndefined()
  })

  it('quarantines every legacy historical profile surface in trader responses', async () => {
    const cachedDetail = {
      trader: { platform: 'bybit', traderKey: 'cached-trader' },
      equityCurve: { '90D': [{ date: '2026-08-17', roi: 9, pnl: 42 }] },
      assetBreakdown: { '90D': [{ symbol: 'BTC', weightPct: 100 }] },
      stats: { avgProfit: 42 },
      portfolio: [{ entryPrice: 100, pnlUsd: 42 }],
      positionHistory: [{ symbol: 'BTCUSDT', pnlUsd: 42 }],
      positionSummary: { totalUnrealizedPnl: 42 },
      historyCompleteness: { state: 'complete' },
    }
    mockGetTraderDetail.mockResolvedValueOnce(cachedDetail)

    const response = await GET(
      request('/api/v3?endpoint=trader&platform=bybit&trader_key=cached-trader')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.equityCurve).toBeUndefined()
    expect(body.data.assetBreakdown).toBeUndefined()
    expect(body.data.stats).toBeNull()
    expect(body.data.portfolio).toEqual([])
    expect(body.data.positionHistory).toEqual([])
    expect(body.data.positionSummary).toBeNull()
    expect(body.data.historyCompleteness).toEqual({
      state: 'unknown',
      reason: 'history_evidence_not_bound',
    })
    expect(cachedDetail.positionHistory).toHaveLength(1)
    expect(mockGetTraderDetail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publicProfileHistoryQuarantine: true })
    )
  })

  // History uses the V1 fail-closed 503 contract (route.ts `endpoint === 'history'`).
  it('fails closed before reading unproven daily history', async () => {
    const response = await GET(
      request('/api/v3?endpoint=history&platform=bybit&trader_key=cached-trader&days=30', {
        'x-api-key': 'would-consume-usage',
      })
    )
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe(PRIVATE_NO_STORE)
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(body.error.code).toBe('TRADER_HISTORY_NOT_PUBLISHED')
    expect(body.error.message).toContain('snapshot provenance is unverified')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockCheckRateLimitFull).not.toHaveBeenCalled()
  })

  it('keeps the quarantined history response as JSON when CSV is requested', async () => {
    const response = await GET(
      request('/api/v3?endpoint=history&platform=bybit&trader_key=cached-trader&format=csv')
    )
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).not.toBe('text/csv; charset=utf-8')
    expect(body.error.code).toBe('TRADER_HISTORY_NOT_PUBLISHED')
    expect(mockCheckRateLimitFull).not.toHaveBeenCalled()
  })
})
