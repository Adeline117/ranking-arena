/**
 * /api/compare route tests
 *
 * Tests authentication, premium access control, input validation,
 * and error handling for the trader comparison API.
 */

// --- Mocks ---

const mockCheckRateLimit = jest.fn().mockResolvedValue(null)
const mockRequireAuth = jest.fn()
const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/api', () => {
  return {
    getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockSupabaseFrom(...args) })),
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    success: jest.fn((data: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NextResponse.json({ success: true, data, meta: { timestamp: new Date().toISOString() } })
    }),
    error: jest.fn((message: string, status: number) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NextResponse.json({ success: false, error: { message } }, { status })
    }),
    handleError: jest.fn((err: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      const statusCode = (err as any)?.statusCode || 500
      const message = err instanceof Error ? err.message : 'Internal error'
      return NextResponse.json({ success: false, error: { message } }, { status: statusCode })
    }),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    RateLimitPresets: { authenticated: { limit: 60, window: 60 } },
  }
})

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: { set: jest.Mock; get: jest.Mock }
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = { set: jest.fn(), get: jest.fn().mockReturnValue(null) }
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
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
      this.headers = new Map(Object.entries({
        'user-agent': 'Mozilla/5.0 (Test)',
        ...(opts?.headers || {}),
      }))
      this.cookies = { get: () => undefined }
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/types/premium', () => ({
  hasFeatureAccess: jest.fn().mockReturnValue(true),
  getFeatureLimits: jest.fn().mockReturnValue({ comparisonReportsPerMonth: 100 }),
}))

// Mock unified data layer
const mockResolveTrader = jest.fn()
const mockGetTraderDetail = jest.fn()
const mockToTraderPageData = jest.fn()
jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
  getTraderDetail: (...args: unknown[]) => mockGetTraderDetail(...args),
  toTraderPageData: (...args: unknown[]) => mockToTraderPageData(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
}))

// Skip CSRF and correlation in tests
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

// Mock tieredGetOrSet to pass through to the fetcher function
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: jest.fn((_key: string, fn: () => unknown) => fn()),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'
import { hasFeatureAccess } from '@/lib/types/premium'

// Helper to build a chainable Supabase mock
function buildFromMock(overrides: Record<string, unknown> = {}) {
  const defaultResult = { data: [], error: null, count: 0 }
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(overrides.result ?? defaultResult)
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
}

describe('GET /api/compare', () => {
  const mockUser = { id: 'user-pro-1', email: 'pro@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue(mockUser)
    ;(hasFeatureAccess as jest.Mock).mockReturnValue(true)
    // Default: unified data layer returns null (trader not found)
    mockResolveTrader.mockResolvedValue(null)
    mockGetTraderDetail.mockResolvedValue(null)
    mockToTraderPageData.mockReturnValue({ performance: null, profile: null, equityCurve: null })

    // Default: subscription query returns pro tier
    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === 'subscriptions') {
        return buildFromMock({ result: { data: { tier: 'pro' }, error: null } })
      }
      return buildFromMock()
    })
  })

  // --- Rate Limiting ---

  it('returns rate limit response when rate limited', async () => {
    // Mock the rate-limit module used by withPublic middleware (uses checkRateLimitFull)
    const { checkRateLimitFull } = require('@/lib/utils/rate-limit') // eslint-disable-line @typescript-eslint/no-require-imports
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    checkRateLimitFull.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'Rate limited' }, { status: 429 }),
      meta: null,
    })

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.error).toBe('Rate limited')
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    const authError = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    mockRequireAuth.mockRejectedValue(authError)

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    await res.json()

    expect(res.status).toBe(401)
  })

  // --- Premium Access ---

  it('returns 403 when user lacks pro access', async () => {
    ;(hasFeatureAccess as jest.Mock).mockReturnValue(false)

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.message).toMatch(/Pro membership required/)
  })

  // --- Input Validation ---

  it('returns 400 when ids parameter is missing', async () => {
    const req = new NextRequest('http://localhost/api/compare')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/Missing ids/)
  })

  it('returns 400 when ids is empty after parsing', async () => {
    const req = new NextRequest('http://localhost/api/compare?ids=')
    const res = await GET(req)
    await res.json()

    expect(res.status).toBe(400)
  })

  it('returns 400 when more than 5 trader IDs provided', async () => {
    const ids = 't1,t2,t3,t4,t5,t6'
    const req = new NextRequest(`http://localhost/api/compare?ids=${ids}`)
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.message).toMatch(/Maximum 5/)
  })

  // --- Success Case ---

  it('returns comparison data for valid trader IDs', async () => {
    // Mock unified data layer to return traders
    mockResolveTrader
      .mockResolvedValueOnce({ platform: 'binance_futures', traderKey: 't1', handle: 'Trader1' })
      .mockResolvedValueOnce({ platform: 'bybit', traderKey: 't2', handle: 'Trader2' })

    const trader1Detail = { source: 'binance_futures', sourceId: 't1', handle: 'Trader1', roi: 45.2, pnl: 10000 }
    const trader2Detail = { source: 'bybit', sourceId: 't2', handle: 'Trader2', roi: 32.1, pnl: 5000 }
    mockGetTraderDetail
      .mockResolvedValueOnce(trader1Detail)
      .mockResolvedValueOnce(trader2Detail)

    mockToTraderPageData
      .mockReturnValueOnce({
        performance: { roi: 45.2, pnl: 10000, win_rate: 0.65, max_drawdown: -12, trades_count: 200, arena_score: 85, arena_score_v3: 88 },
        profile: { handle: 'Trader1', avatar_url: null },
        equityCurve: null,
      })
      .mockReturnValueOnce({
        performance: { roi: 32.1, pnl: 5000, win_rate: 0.72, max_drawdown: -8, trades_count: 150, arena_score: 78, arena_score_v3: null },
        profile: { handle: 'Trader2', avatar_url: null },
        equityCurve: null,
      })

    const req = new NextRequest('http://localhost/api/compare?ids=t1,t2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.traders).toHaveLength(2)
    expect(body.data.requestedIds).toEqual(['t1', 't2'])
    expect(body.data.foundCount).toBe(2)
  })

  // --- DB Error ---

  it('returns 500 when data fetch fails', async () => {
    // Make resolveTrader throw to simulate a DB error
    mockResolveTrader.mockRejectedValue(new Error('Failed to fetch trader data'))

    const req = new NextRequest('http://localhost/api/compare?ids=t1')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
  })
})
