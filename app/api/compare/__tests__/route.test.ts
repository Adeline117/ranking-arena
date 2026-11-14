/**
 * /api/compare route tests
 *
 * Tests authentication, premium access control, identity handling, and the
 * sealed-current-ranking boundary used by the comparison response.
 */

const mockCheckRateLimit = jest.fn().mockResolvedValue(null)
const mockRequireAuth = jest.fn()
const mockSupabaseFrom = jest.fn()
const mockResolveTrader = jest.fn()
const mockFetchPublicProfileRankingRows = jest.fn()
const mockGetAuthUser = jest.fn()

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockSupabaseFrom(...args) })),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  success: jest.fn((data: unknown, status = 200, headers?: Record<string, string>) => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    return NextResponse.json(
      { success: true, data, meta: { timestamp: new Date().toISOString() } },
      { status, headers }
    )
  }),
  error: jest.fn((message: string, status: number) => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    return NextResponse.json({ success: false, error: { message } }, { status })
  }),
  handleError: jest.fn((err: unknown) => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    const statusCode = (err as { statusCode?: number } | null)?.statusCode || 500
    const message = err instanceof Error ? err.message : 'Internal error'
    return NextResponse.json({ success: false, error: { message } }, { status: statusCode })
  }),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { authenticated: { limit: 60, window: 60 } },
}))

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: { set: jest.Mock; get: jest.Mock }

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      const values = new Map(
        Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      )
      this.headers = {
        set: jest.fn((key: string, value: string) => values.set(key.toLowerCase(), value)),
        get: jest.fn((key: string) => values.get(key.toLowerCase()) ?? null),
      }
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
    cookies: { get: () => undefined }

    constructor(url: string, opts?: { method?: string; headers?: Record<string, string> }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.method = opts?.method || 'GET'
      this.headers = new Map(
        Object.entries({
          'user-agent': 'Mozilla/5.0 (Test)',
          ...(opts?.headers || {}),
        })
      )
      this.cookies = { get: () => undefined }
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: jest.fn().mockReturnValue(true),
  getFeatureLimits: jest.fn().mockReturnValue({ comparisonReportsPerMonth: 100 }),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/data/trader/public-profile-ranking', () => {
  const actual = jest.requireActual<typeof import('@/lib/data/trader/public-profile-ranking')>(
    '@/lib/data/trader/public-profile-ranking'
  )
  return {
    ...actual,
    fetchPublicProfileRankingRows: (...args: unknown[]) =>
      mockFetchPublicProfileRankingRows(...args),
  }
})

jest.mock('@/lib/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return { __esModule: true, default: logger, logger }
})

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}))

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockSupabaseFrom(...args) })),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: {
    public: { limit: 100, window: 60, prefix: 'public' },
    authenticated: { limit: 200, window: 60, prefix: 'auth' },
    write: { limit: 30, window: 60, prefix: 'write' },
    sensitive: { limit: 15, window: 60, prefix: 'sensitive' },
  },
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
import { hasFeatureAccess } from '@/lib/types/premium'

function buildFromMock(overrides: Record<string, unknown> = {}) {
  const defaultResult = { data: [], error: null, count: 0 }
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => void) => resolve(overrides.result ?? defaultResult)
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
}

function publicRankingRow(
  source: string,
  traderKey: string,
  seasonId: '90D' | '30D' | '7D',
  overrides: Record<string, unknown> = {}
) {
  return {
    season_id: seasonId,
    source,
    source_trader_id: traderKey,
    handle: `${traderKey}-${seasonId}`,
    avatar_url: `https://cdn.example/${traderKey}.png`,
    rank: seasonId === '90D' ? 1 : seasonId === '30D' ? 2 : 3,
    arena_score: 85,
    roi: seasonId === '90D' ? 45.2 : seasonId === '30D' ? 30.2 : 7.2,
    pnl: 10_000,
    win_rate: 65,
    max_drawdown: 12,
    trades_count: 200,
    followers: 42,
    profitability_score: 88,
    risk_control_score: 77,
    execution_score: 66,
    score_completeness: 'full',
    metrics_estimated: false,
    is_outlier: false,
    computed_at: new Date().toISOString(),
    ...overrides,
  }
}

function publicRankingResult(rows: unknown[]) {
  return {
    rows,
    rankingVisibility: rows.length === 3 ? 'verified' : rows.length > 0 ? 'partial' : 'unknown',
    rankingVisibilityReason:
      rows.length === 3
        ? null
        : rows.length > 0
          ? 'public_period_not_published'
          : 'public_rank_unavailable',
  }
}

describe('GET /api/compare', () => {
  const mockUser = { id: 'user-pro-1', email: 'pro@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue(mockUser)
    ;(hasFeatureAccess as jest.Mock).mockReturnValue(true)
    mockResolveTrader.mockResolvedValue(null)
    mockFetchPublicProfileRankingRows.mockResolvedValue(publicRankingResult([]))

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return buildFromMock({ result: { data: { tier: 'pro' }, error: null } })
      }
      return buildFromMock()
    })
  })

  it('returns rate limit response when rate limited', async () => {
    const { checkRateLimitFull } = require('@/lib/utils/rate-limit') // eslint-disable-line @typescript-eslint/no-require-imports
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    checkRateLimitFull.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'Rate limited' }, { status: 429 }),
      meta: null,
    })

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=t1,t2&platforms=bybit,binance_futures')
    )

    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('Rate limited')
  })

  it('returns 401 when not authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=t1,t2&platforms=bybit,binance_futures')
    )

    expect(res.status).toBe(401)
  })

  it('returns 403 when user lacks pro access', async () => {
    ;(hasFeatureAccess as jest.Mock).mockReturnValue(false)

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=t1,t2&platforms=bybit,binance_futures')
    )

    expect(res.status).toBe(403)
    expect((await res.json()).error.message).toMatch(/Pro membership required/)
  })

  it('answers 503, not 403, when the subscription lookup fails', async () => {
    mockSupabaseFrom.mockImplementation((table: string) =>
      table === 'subscriptions'
        ? buildFromMock({ result: { data: null, error: { message: 'multiple rows' } } })
        : buildFromMock()
    )

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=t1,t2&platforms=bybit,binance_futures')
    )

    expect(res.status).toBe(503)
  })

  it('passes a profile-only Pro grant to the feature gate', async () => {
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') return buildFromMock({ result: { data: null, error: null } })
      if (table === 'user_profiles') {
        return buildFromMock({ result: { data: { subscription_tier: 'pro' }, error: null } })
      }
      return buildFromMock()
    })

    await GET(
      new NextRequest('http://localhost/api/compare?ids=t1,t2&platforms=bybit,binance_futures')
    )

    expect(hasFeatureAccess).toHaveBeenCalledWith('pro', 'trader_comparison')
  })

  it.each([
    ['missing ids', 'http://localhost/api/compare'],
    ['empty ids', 'http://localhost/api/compare?ids=&platforms=bybit'],
    ['missing platforms', 'http://localhost/api/compare?ids=t1,t2'],
    ['mismatched pairs', 'http://localhost/api/compare?ids=t1,t2&platforms=bybit'],
    ['duplicate identities', 'http://localhost/api/compare?ids=t1,t1&platforms=bybit,bybit'],
  ])('rejects invalid comparison input: %s', async (_name, url) => {
    const res = await GET(new NextRequest(url))

    expect(res.status).toBe(400)
  })

  it('returns 400 when more than ten accounts are requested', async () => {
    const ids = 't1,t2,t3,t4,t5,t6,t7,t8,t9,t10,t11'
    const platforms = Array.from({ length: 11 }, () => 'bybit').join(',')
    const res = await GET(
      new NextRequest(`http://localhost/api/compare?ids=${ids}&platforms=${platforms}`)
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toMatch(/Maximum 10/)
  })

  it('keeps sealed reads and resolver identity source-aware for equal raw IDs', async () => {
    mockResolveTrader
      .mockResolvedValueOnce({
        platform: 'bybit',
        traderKey: 'shared',
        handle: 'Bybit trader',
        avatarUrl: null,
      })
      .mockResolvedValueOnce({
        platform: 'binance_futures',
        traderKey: 'shared',
        handle: 'Binance trader',
        avatarUrl: null,
      })
    mockFetchPublicProfileRankingRows
      .mockResolvedValueOnce(publicRankingResult([publicRankingRow('bybit', 'shared', '90D')]))
      .mockResolvedValueOnce(
        publicRankingResult([publicRankingRow('binance_futures', 'shared', '90D')])
      )

    const res = await GET(
      new NextRequest(
        'http://localhost/api/compare?ids=shared,shared&platforms=bybit,binance_futures'
      )
    )

    expect(res.status).toBe(200)
    expect(mockResolveTrader).toHaveBeenNthCalledWith(1, expect.anything(), {
      handle: 'shared',
      platform: 'bybit',
    })
    expect(mockResolveTrader).toHaveBeenNthCalledWith(2, expect.anything(), {
      handle: 'shared',
      platform: 'binance_futures',
    })
    expect(mockFetchPublicProfileRankingRows).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        source: 'bybit',
        sourceTraderId: 'shared',
        periods: ['90D', '30D', '7D'],
      })
    )
    expect(mockFetchPublicProfileRankingRows).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        source: 'binance_futures',
        sourceTraderId: 'shared',
        periods: ['90D', '30D', '7D'],
      })
    )
  })

  it('re-reads the sealed cohort for each request instead of replaying rank-bearing data', async () => {
    mockResolveTrader.mockResolvedValue({
      platform: 'bybit',
      traderKey: 't1',
      handle: 'Trader1',
      avatarUrl: null,
    })
    mockFetchPublicProfileRankingRows.mockResolvedValue(
      publicRankingResult([publicRankingRow('bybit', 't1', '90D')])
    )
    const request = new NextRequest('http://localhost/api/compare?ids=t1&platforms=bybit')

    await GET(request)
    await GET(request)

    expect(mockFetchPublicProfileRankingRows).toHaveBeenCalledTimes(2)
  })

  it('returns only sealed current-ranking scalars when the retired curve query is supplied', async () => {
    mockResolveTrader.mockResolvedValue({
      platform: 'bybit',
      traderKey: 't1',
      handle: 'Resolved identity',
      avatarUrl: 'https://identity.example/t1.png',
    })
    mockFetchPublicProfileRankingRows.mockResolvedValue(
      publicRankingResult([
        publicRankingRow('bybit', 't1', '90D', { roi: 45.2, pnl: 10_000 }),
        publicRankingRow('bybit', 't1', '30D', { roi: 30.2 }),
        publicRankingRow('bybit', 't1', '7D', { roi: 7.2 }),
      ])
    )

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=t1&platforms=bybit&include_equity=1')
    )
    const body = await res.json()
    const trader = body.data.traders[0]

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate')
    expect(trader).toMatchObject({
      id: 't1',
      source: 'bybit',
      roi: 45.2,
      roi_30d: 30.2,
      roi_7d: 7.2,
      pnl: 10_000,
      arena_score: 85,
      ranking_visibility: 'verified',
      ranking_visibility_reason: null,
    })
    expect(trader).not.toHaveProperty('equity_curve')
    expect(JSON.stringify(body)).not.toContain('daily-pnl')
    expect(mockFetchPublicProfileRankingRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'bybit',
        sourceTraderId: 't1',
        periods: ['90D', '30D', '7D'],
      })
    )
  })

  it('keeps unavailable public metrics explicit instead of coercing them to zero', async () => {
    mockResolveTrader.mockResolvedValue({
      platform: 'bybit',
      traderKey: 'unranked',
      handle: 'Unranked identity',
      avatarUrl: null,
    })
    mockFetchPublicProfileRankingRows.mockResolvedValue(publicRankingResult([]))

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=unranked&platforms=bybit')
    )
    const trader = (await res.json()).data.traders[0]

    expect(res.status).toBe(200)
    expect(trader).toMatchObject({
      id: 'unranked',
      roi: null,
      roi_30d: null,
      roi_7d: null,
      pnl: null,
      max_drawdown: null,
      win_rate: null,
      trades_count: null,
      followers: null,
      ranking_visibility: 'unknown',
      ranking_visibility_reason: 'public_rank_unavailable',
    })
  })

  it('returns comparison data and exact missing identities for resolvable accounts', async () => {
    mockResolveTrader
      .mockResolvedValueOnce({
        platform: 'binance_futures',
        traderKey: 't1',
        handle: 'Trader1',
        avatarUrl: null,
      })
      .mockResolvedValueOnce(null)
    mockFetchPublicProfileRankingRows.mockResolvedValueOnce(
      publicRankingResult([publicRankingRow('binance_futures', 't1', '90D')])
    )

    const res = await GET(
      new NextRequest('http://localhost/api/compare?ids=t1,missing&platforms=binance_futures,bybit')
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.traders).toHaveLength(1)
    expect(body.data.traders[0]).toMatchObject({ id: 't1', source: 'binance_futures' })
    expect(body.data.missingAccounts).toEqual([{ id: 'missing', source: 'bybit' }])
    expect(body.data.foundCount).toBe(1)
  })

  it('returns 500 when identity resolution fails', async () => {
    mockResolveTrader.mockRejectedValue(new Error('Failed to fetch trader data'))

    const res = await GET(new NextRequest('http://localhost/api/compare?ids=t1&platforms=bybit'))

    expect(res.status).toBe(500)
  })
})
