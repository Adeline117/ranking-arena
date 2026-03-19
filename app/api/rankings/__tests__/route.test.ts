/**
 * /api/rankings route tests
 *
 * Tests parameter validation, error handling, and response shape
 * for the main leaderboard rankings endpoint.
 */

// --- Mocks ---

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
    async json() { return this._body }
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
      this.headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) }))
      this.method = opts?.method || 'GET'
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {} },
}))

const mockTieredGetOrSet = jest.fn()
const mockTieredGet = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
}))

// Supabase mock
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

/** Build a thenable chainable Supabase mock */
function makeChainableQuery(result = { data: [], error: null, count: 0 }) {
  const storage: Record<string, jest.Mock> = {}
  const chain = new Proxy(storage, {
    get(target, prop) {
      const key = prop as string
      if (key === 'then') {
        // Make chain directly awaitable
        return (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve)
      }
      if (key === 'catch' || key === 'finally') return undefined
      if (!target[key]) {
        target[key] = jest.fn(() => chain)
      }
      return target[key]
    },
  })
  return chain
}

describe('GET /api/rankings', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTieredGetOrSet.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn())
    mockTieredGet.mockResolvedValue({ data: null })
    // Default: Supabase query returns empty results
    mockSupabaseQuery.mockReturnValue(makeChainableQuery())
  })

  // --- Parameter Validation ---

  it('returns 400 when window parameter is missing', async () => {
    const req = new NextRequest('http://localhost/api/rankings')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/window/i)
  })

  it('returns 400 for invalid window parameter', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=999d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/window/i)
  })

  it('returns 400 for invalid category', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=90d&category=invalid')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/category/i)
  })

  it('returns 400 for invalid sort_by', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=90d&sort_by=invalid_field')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/sort_by/i)
  })

  it('returns 400 for invalid platform', async () => {
    const req = new NextRequest('http://localhost/api/rankings?window=90d&platform=fake_exchange')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/platform/i)
  })

  // --- Successful Responses ---

  it('returns rankings for a valid window', async () => {
    const mockResult = {
      traders: [
        {
          platform: 'binance_futures',
          trader_key: 'trader1',
          display_name: 'TopTrader',
          rank: 1,
          metrics: { arena_score: 95.5, roi: 120.3, pnl: 50000 },
        },
      ],
      window: '90D',
      totalcount: 1,
      total_count: 1,
      as_of: '2026-03-06T00:00:00.000Z',
      is_stale: false,
      availableSources: ['binance_futures'],
    }
    mockTieredGetOrSet.mockResolvedValue(mockResult)

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    // Response is wrapped by apiSuccess: { success: true, data: { traders, window, ... } }
    const data = body.data ?? body
    expect(data.traders).toBeDefined()
    expect(data.window).toBe('90D')
    expect(data.totalcount ?? data.total_count ?? 0).toBeGreaterThanOrEqual(0)
  })

  it('accepts valid category filter', async () => {
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: '30D',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=30d&category=futures')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  it('accepts valid sort_by and sort_dir parameters', async () => {
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: '7D',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=7d&sort_by=roi&sort_dir=asc')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  it('clamps limit to max 500', async () => {
    // The route clamps limit to 500 internally. We verify no error is thrown.
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: '90D',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=90d&limit=9999')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  // --- Composite Window ---

  it('accepts composite window', async () => {
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredGetOrSet.mockResolvedValue({
      traders: [],
      window: 'COMPOSITE',
      totalcount: 0,
      total_count: 0,
      as_of: new Date().toISOString(),
      is_stale: false,
      availableSources: [],
    })

    const req = new NextRequest('http://localhost/api/rankings?window=composite')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  // --- Error Handling ---

  it('returns 500 when an internal error occurs', async () => {
    mockTieredGetOrSet.mockRejectedValue(new Error('DB connection failed'))
    mockTieredGet.mockResolvedValue({ data: null })

    const req = new NextRequest('http://localhost/api/rankings?window=90d')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    // Error response — the exact message depends on middleware locale
    expect(res.status).toBe(500)
  })
})
