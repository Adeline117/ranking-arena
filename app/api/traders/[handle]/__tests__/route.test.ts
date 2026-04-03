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

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({})),
  })),
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {}, authenticated: {} },
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
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
const mockToTraderPageData = jest.fn().mockReturnValue({ performance: null, profile: null, equityCurve: null })

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

jest.mock('@/lib/data/linked-traders', () => ({
  getAggregatedStats: jest.fn().mockResolvedValue(null),
  findUserByTrader: jest.fn().mockResolvedValue(null),
}))

const mockTieredGetOrSet = jest.fn(async (_key: string, fetcher: () => unknown) => fetcher())
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

import { GET } from '../route'

describe('GET /api/traders/[handle]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetServerCache.mockReturnValue(null)
    mockResolveTrader.mockResolvedValue(null)
    mockGetTraderDetail.mockResolvedValue(null)
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  // --- Input Validation ---

  it('returns 400 for empty handle', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/') }
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
    const request = { nextUrl: new URL(`http://localhost/api/traders/${longHandle}`) }
    const params = Promise.resolve({ handle: longHandle })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(400)
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/Invalid handle parameter/)
  })

  it('accepts single character handle (valid)', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/x') }
    const params = Promise.resolve({ handle: 'x' })

    const res = await GET(request as any, { params })
    // Should not be 400 (it'll be 404 since resolveTrader returns null)
    expect(res.status).not.toBe(400)
  })

  it('accepts 0x-prefixed address handle', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/0x1234abcd') }
    const params = Promise.resolve({ handle: '0x1234abcd' })

    const res = await GET(request as any, { params })
    expect(res.status).not.toBe(400)
  })

  // --- 404 Not Found ---

  it('returns 404 when trader is not found', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const request = { nextUrl: new URL('http://localhost/api/traders/nonexistent') }
    const params = Promise.resolve({ handle: 'nonexistent' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    const errMsg = body.error?.message ?? body.error
    expect(errMsg).toMatch(/not found/i)
  })

  it('returns 404 with proper error structure', async () => {
    mockResolveTrader.mockResolvedValue(null)

    const request = { nextUrl: new URL('http://localhost/api/traders/ghost') }
    const params = Promise.resolve({ handle: 'ghost' })

    const res = await GET(request as any, { params })
    const body = await res.json()

    expect(res.status).toBe(404)
    // handleError returns { success: false, error: { code, message, timestamp } }
    expect(body.success).toBe(false)
    expect(body.error).toBeDefined()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  // --- Cache Hit ---

  it('returns 200 when data is found via tieredGetOrSet', async () => {
    const pageData = {
      performance: { roi: 42.5 },
      profile: { handle: 'CachedTrader' },
    }
    mockTieredGetOrSet.mockResolvedValueOnce({
      pageData,
      resolved: { platform: 'binance_futures', traderKey: 'trader123' },
    })

    const request = { nextUrl: new URL('http://localhost/api/traders/CachedTrader') }
    const params = Promise.resolve({ handle: 'CachedTrader' })

    const res = await GET(request as any, { params })

    expect(res.status).toBe(200)
  })

  // --- Error Handling ---

  it('returns 500 on unexpected database error', async () => {
    mockResolveTrader.mockRejectedValueOnce(new Error('DB connection lost'))

    const request = { nextUrl: new URL('http://localhost/api/traders/crasher') }
    const params = Promise.resolve({ handle: 'crasher' })

    const res = await GET(request as any, { params })

    expect(res.status).toBe(500)
  })

  it('returns 500 when params promise rejects', async () => {
    const request = { nextUrl: new URL('http://localhost/api/traders/test') }
    const params = Promise.reject(new Error('params error'))

    const res = await GET(request as any, { params })

    expect(res.status).toBe(500)
  })
})
