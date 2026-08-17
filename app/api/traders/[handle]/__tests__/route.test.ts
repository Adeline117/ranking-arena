/**
 * /api/traders/[handle] route tests
 *
 * Tests the trader detail API: input validation, 404 handling,
 * cache behavior, and error handling.
 */

// --- Mocks (must be before imports) ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    _headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status || 200
      this._headers = new Map(Object.entries(init.headers || {}))
    }

    get headers() {
      return {
        get: (key: string) => this._headers.get(key) || null,
        set: (key: string, value: string) => this._headers.set(key, value),
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
    _headers: Map<string, string>
    method: string
    cookies: { get: () => undefined }

    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
      this._headers = new Map([['user-agent', 'Mozilla/5.0 (Test)']])
      this.method = 'GET'
      this.cookies = { get: () => undefined }
    }
    get headers() {
      const h = this._headers
      return { get: (key: string) => h.get(key) || null }
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({})),
  })),
}))

const mockSupabaseFrom = jest.fn(() => ({}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockSupabaseFrom,
  })),
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {}, authenticated: {} },
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { public: {}, authenticated: {} },
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

const mockResolveTrader = jest.fn().mockResolvedValue(null)
const mockGetTraderDetail = jest.fn().mockResolvedValue(null)
const mockToTraderPageData = jest
  .fn()
  .mockReturnValue({ performance: null, profile: null, equityCurve: null })

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
  getTraderDetail: (...args: unknown[]) => mockGetTraderDetail(...args),
  toTraderPageData: (...args: unknown[]) => mockToTraderPageData(...args),
}))

const mockGetServerCache = jest.fn().mockReturnValue(null)
const mockSetServerCache = jest.fn()

jest.mock('@/lib/utils/server-cache', () => ({
  getServerCache: (...args: unknown[]) => mockGetServerCache(...args),
  setServerCache: (...args: unknown[]) => mockSetServerCache(...args),
  CacheTTL: { SHORT: 60, MEDIUM: 300, LONG: 3600 },
}))

jest.mock('@/lib/utils/arena-score', () => ({
  calculateArenaScore: jest.fn().mockReturnValue(75),
  calculateOverallScore: jest.fn().mockReturnValue(80),
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
  return {
    createLogger: jest.fn(() => inst),
    logger: inst,
    fireAndForget: jest.fn(),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
  }
})

jest.mock('@/lib/constants/exchanges', () => ({
  ALL_SOURCES: ['binance_futures', 'bybit', 'okx_futures', 'hyperliquid'],
}))

const mockGetAggregatedStats = jest.fn().mockResolvedValue(null)
const mockFindUserByTrader = jest.fn().mockResolvedValue(null)
jest.mock('@/lib/data/linked-traders', () => ({
  getAggregatedStats: (...args: unknown[]) => mockGetAggregatedStats(...args),
  findUserByTrader: (...args: unknown[]) => mockFindUserByTrader(...args),
}))

const mockVerifyCronSecret = jest.fn().mockReturnValue(false)
jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyCronSecret: (...args: unknown[]) => mockVerifyCronSecret(...args),
}))

import { GET } from '../route'

/** Build a minimal mock request with headers needed by withApiMiddleware. */
function mockReq(url: string, authorization?: string) {
  return {
    nextUrl: new URL(url),
    method: 'GET',
    headers: {
      get: (key: string) => {
        if (key === 'user-agent') return 'Mozilla/5.0 (Jest Test Runner)'
        if (key === 'authorization') return authorization || null
        return null
      },
    },
    cookies: { get: () => undefined },
  }
}

describe('GET /api/traders/[handle]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerCache.mockReturnValue(null)
    mockResolveTrader.mockResolvedValue(null)
    mockGetTraderDetail.mockResolvedValue(null)
    mockGetAggregatedStats.mockResolvedValue(null)
    mockFindUserByTrader.mockResolvedValue(null)
    mockVerifyCronSecret.mockReturnValue(false)
    mockSupabaseFrom.mockClear()
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  // --- Input Validation ---

  it('returns 400 for empty handle', async () => {
    const request = mockReq('http://localhost/api/traders/')
    const params = Promise.resolve({ handle: '' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    // handleError wraps ApiError.validation into { success: false, error: { code, message, ... } }
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/Invalid handle parameter/)
  })

  it('returns 400 for handle exceeding max length', async () => {
    const longHandle = 'a'.repeat(256)
    const request = mockReq(`http://localhost/api/traders/${longHandle}`)
    const params = Promise.resolve({ handle: longHandle })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/Invalid handle parameter/)
  })

  it('accepts single character handle (valid)', async () => {
    const request = mockReq('http://localhost/api/traders/x')
    const params = Promise.resolve({ handle: 'x' })

    const res = await GET(request as any, { params })
    // Should not be 400 (it'll be 404 since resolveTrader returns null)
    expect(res.status).not.toBe(400)
  })

  it('accepts 0x-prefixed address handle', async () => {
    const request = mockReq('http://localhost/api/traders/0x1234abcd')
    const params = Promise.resolve({ handle: '0x1234abcd' })

    const res = await GET(request as any, { params })
    expect(res.status).not.toBe(400)
  })

  // --- 404 Not Found ---

  it('returns 404 when trader is not found', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const request = mockReq('http://localhost/api/traders/nonexistent')
    const params = Promise.resolve({ handle: 'nonexistent' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/not found/i)
  })

  it('returns 404 with proper error structure', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const request = mockReq('http://localhost/api/traders/ghost')
    const params = Promise.resolve({ handle: 'ghost' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    // withApiMiddleware's createErrorResponse returns { success: false, error: <string> }
    expect(body.success).toBe(false)
    expect(body.error).toBeDefined()
    expect(typeof body.error === 'string' || body.error?.code === 'NOT_FOUND').toBe(true)
  })

  // --- Current public-cohort response ---

  it('returns a live detail projection with no shared response cache', async () => {
    const pageData = {
      performance: { roi: 42.5 },
      profile: { handle: 'CachedTrader' },
      equityCurve: { '90D': [{ date: '2026-08-17', roi: 9, pnl: 42 }] },
      assetBreakdown: { '90D': [{ symbol: 'BTC', weightPct: 100 }] },
      stats: { trading: { avgProfit: 42 } },
      portfolio: [{ market: 'BTCUSDT', price: 100, pnl: 42 }],
      positionHistory: [{ symbol: 'BTCUSDT', pnlUsd: 42 }],
      positionSummary: { totalUnrealizedPnl: 42 },
      historyCompleteness: { state: 'complete' },
    }
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'binance_futures',
      traderKey: 'trader123',
    })
    mockGetTraderDetail.mockResolvedValueOnce({ trader: {} })
    mockToTraderPageData.mockReturnValueOnce(pageData)

    const request = mockReq('http://localhost/api/traders/CachedTrader')
    const params = Promise.resolve({ handle: 'CachedTrader' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(200)
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
    expect(pageData.positionHistory).toHaveLength(1)
    expect(mockGetTraderDetail).toHaveBeenCalledTimes(1)
    expect(mockGetTraderDetail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publicProfileHistoryQuarantine: true })
    )
    expect(mockToTraderPageData).toHaveBeenCalledWith(expect.anything(), {
      publicProfileHistoryQuarantine: true,
    })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('X-Arena-Consistency-Proof')).toBeNull()
  })

  it('serializes include=aggregate through the subject-bound public DTO', async () => {
    mockResolveTrader.mockResolvedValueOnce({ platform: 'bybit', traderKey: 'account-42' })
    mockGetTraderDetail.mockResolvedValueOnce({ trader: {} })
    mockToTraderPageData.mockReturnValueOnce({
      performance: { roi: 42.5 },
      profile: { handle: 'LinkedTrader' },
    })
    mockFindUserByTrader.mockResolvedValueOnce('private-user-id')
    mockGetAggregatedStats.mockResolvedValueOnce({
      accounts: [
        {
          id: 'internal-1',
          userId: 'private-user-id',
          linkedAt: '2026-07-01T00:00:00Z',
          platform: 'bybit',
          traderKey: 'account-42',
          handle: 'Primary',
          label: 'Owner private label',
          isPrimary: true,
          roi: 10,
          pnl: 50000,
          arenaScore: 88,
          winRate: 60,
          maxDrawdown: -12,
          rank: 5,
        },
        {
          id: 'internal-2',
          userId: 'private-user-id',
          linkedAt: '2026-07-02T00:00:00Z',
          platform: 'okx',
          traderKey: 'account-2',
          handle: 'Secondary',
          label: 'Another private label',
          isPrimary: false,
          roi: 5,
          pnl: 25000,
          arenaScore: 70,
          winRate: 55,
          maxDrawdown: 8,
          rank: 20,
        },
      ],
      totalAccounts: 2,
      combinedPnl: 75000,
      bestRoi: { value: 10, platform: 'bybit', traderKey: 'account-42' },
      weightedScore: 82,
    })

    const request = mockReq(
      'http://localhost/api/traders/LinkedTrader?source=bybit&include=aggregate'
    )
    const response = await GET(request as any, {
      params: Promise.resolve({ handle: 'LinkedTrader' }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(body.data.aggregate).toMatchObject({
      subject: { platform: 'bybit', traderKey: 'account-42' },
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      totalAccounts: 2,
      accounts: [
        expect.objectContaining({
          id: 'bybit:account-42',
          label: null,
          pnl: null,
          arenaScore: null,
          rank: null,
        }),
        expect.any(Object),
      ],
    })
    expect(JSON.stringify(body.data.aggregate)).not.toMatch(
      /private-user-id|Owner private label|Another private label|50000|75000/
    )
  })

  it('returns an explicitly partial empty rank history without querying raw snapshots', async () => {
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'binance_futures',
      traderKey: 'rank-history-subject',
    })
    mockGetTraderDetail.mockResolvedValueOnce({ trader: {} })
    mockToTraderPageData.mockReturnValueOnce({
      performance: { roi: 42.5 },
      profile: { handle: 'RankHistorySubject' },
    })

    const response = await GET(
      mockReq(
        'http://localhost/api/traders/RankHistorySubject?include=rank_history&rh_period=90D&rh_days=7'
      ) as any,
      { params: Promise.resolve({ handle: 'RankHistorySubject' }) }
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.rank_history).toEqual({
      history: [],
      platform: 'binance_futures',
      trader_key: 'rank-history-subject',
      period: '90D',
      ranking_visibility: 'partial',
      ranking_visibility_reason: 'historical_rank_evidence_unavailable',
      ranking_visibility_reasons: ['historical_rank_evidence_unavailable'],
      history_completeness: {
        state: 'unknown',
        reason: 'historical_rank_evidence_unavailable',
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })

  it('keeps aggregate fixture output allowlisted and no-store', async () => {
    const request = mockReq(
      'http://localhost/api/traders/e2e_trader_fixture?e2e_fixture=linked_accounts'
    )
    const response = await GET(request as any, {
      params: Promise.resolve({ handle: 'e2e_trader_fixture' }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(body.data.aggregate).toMatchObject({
      subject: { platform: 'binance_futures', traderKey: 'e2e-primary-key' },
      aggregated: { combinedPnl: null, bestRoi: null, weightedScore: null },
      accounts: [
        expect.objectContaining({ label: null, pnl: null, arenaScore: null, rank: null }),
        expect.objectContaining({ label: null, pnl: null, arenaScore: null, rank: null }),
      ],
    })
    expect(JSON.stringify(body.data.aggregate)).not.toMatch(/e2e-private-owner|Private .* label/)
  })

  it('marks an authenticated consistency probe as a live loader', async () => {
    mockVerifyCronSecret.mockReturnValue(true)
    mockResolveTrader.mockResolvedValueOnce({
      platform: 'binance_futures',
      traderKey: 'trader123',
    })
    mockGetTraderDetail.mockResolvedValueOnce({ trader: {} })
    mockToTraderPageData.mockReturnValueOnce({
      performance: { roi_90d: 42.5, pnl: 100, arena_score_90d: 88 },
      profile: { handle: 'FreshTrader' },
    })

    const request = mockReq(
      'http://localhost/api/traders/FreshTrader?source=binance_futures&consistency_probe=1',
      'Bearer valid-cron-secret'
    )
    const params = Promise.resolve({ handle: 'FreshTrader' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockVerifyCronSecret).toHaveBeenCalledWith(request)
    expect(mockResolveTrader).toHaveBeenCalledTimes(1)
    expect(body.data.consistency_probe).toEqual({
      cache_bypassed: true,
      loader: 'unified-live',
    })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('X-Arena-Consistency-Proof')).toBe('live-loader-v1')
  })

  it('rejects an invalid consistency probe before loading a profile', async () => {
    mockVerifyCronSecret.mockReturnValue(false)

    const request = mockReq(
      'http://localhost/api/traders/CachedTrader?source=binance_futures&consistency_probe=1',
      'Bearer invalid-cron-secret'
    )
    const params = Promise.resolve({ handle: 'CachedTrader' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(mockVerifyCronSecret).toHaveBeenCalledWith(request)
    expect(mockResolveTrader).not.toHaveBeenCalled()
    expect(body.error).toMatchObject({ code: 'UNAUTHORIZED' })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('Pragma')).toBe('no-cache')
    expect(res.headers.get('Vary')).toBe('Authorization')
    expect(res.headers.get('X-Arena-Consistency-Proof')).toBeNull()
  })

  // --- Error Handling ---

  it('returns 500 on unexpected database error', async () => {
    mockResolveTrader.mockRejectedValueOnce(new Error('DB connection lost'))

    const request = mockReq('http://localhost/api/traders/crasher')
    const params = Promise.resolve({ handle: 'crasher' })

    const res = await GET(request as any, { params })

    expect(res.status).toBe(500)
  })

  it('marks base lookup errors no-store when include=aggregate was requested', async () => {
    mockResolveTrader.mockRejectedValueOnce(new Error('DB connection lost'))

    const request = mockReq('http://localhost/api/traders/crasher?source=bybit&include=aggregate')
    const res = await GET(request as any, { params: Promise.resolve({ handle: 'crasher' }) })

    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('Pragma')).toBe('no-cache')
  })

  it('throws when params promise rejects (unhandled before middleware)', async () => {
    const request = mockReq('http://localhost/api/traders/test')
    const params = Promise.reject(new Error('params error'))

    await expect(GET(request as any, { params })).rejects.toThrow('params error')
  })
})
