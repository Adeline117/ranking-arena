/**
 * /api/following route tests
 *
 * Tests authentication, authorization, input validation,
 * pagination, and error handling for the following list API.
 */

// --- Mocks ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    _headersMap: Map<string, string>

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this._headersMap = new Map()
    }

    get headers() {
      const map = this._headersMap
      return {
        set: (key: string, value: string) => map.set(key, value),
        get: (key: string) => map.get(key) || null,
        has: (key: string) => map.has(key),
      }
    }

    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    _headers: Map<string, string>
    method: string
    cookies: { get: () => undefined }
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.url = url
      this.nextUrl = new URL(url)
      this._headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) }))
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

const mockGetAuthUser = jest.fn()

// Supabase query chain proxy
let supabaseQueryResult: { data: unknown; error: unknown } = { data: [], error: null }

function buildChainMock(): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(supabaseQueryResult)
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
}

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => buildChainMock()),
  })),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { authenticated: { limit: 60, window: 60 }, public: { limit: 100, window: 60 } },
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), apiError: jest.fn(), dbError: jest.fn() }
  return {
    createLogger: jest.fn(() => inst),
    logger: inst,
    fireAndForget: jest.fn(),
    captureError: jest.fn(),
    captureMessage: jest.fn(),
  }
})

const mockTieredGet = jest.fn()
const mockTieredSet = jest.fn()
const mockTieredDel = jest.fn()
jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGet: (...args: unknown[]) => mockTieredGet(...args),
  tieredSet: (...args: unknown[]) => mockTieredSet(...args),
  tieredDel: (...args: unknown[]) => mockTieredDel(...args),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/following', () => {
  const mockUser = { id: 'user-123', email: 'test@example.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredSet.mockResolvedValue(undefined)
    supabaseQueryResult = { data: [], error: null }
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/following?userId=user-123')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    // withAuth middleware returns Chinese error: { success: false, error: '未授权' }
    expect(body.error).toBe('未授权')
  })

  // --- Input Validation ---

  it('returns 400 when userId is missing', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/following')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Missing userId')
  })

  // --- Authorization ---

  it('returns 403 when userId does not match authenticated user', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/following?userId=other-user-456')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toMatch(/Unauthorized/)
  })

  // --- Success Cases ---

  it('returns empty list when user has no followings', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockTieredGet.mockResolvedValue({ data: null })

    const req = new NextRequest('http://localhost/api/following?userId=user-123')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.items).toEqual([])
    expect(body.count).toBe(0)
    expect(body.traderCount).toBe(0)
    expect(body.userCount).toBe(0)
  })

  it('returns cached following list when available', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    const cachedResult = {
      items: [
        { id: 'trader1', handle: 'TopTrader', type: 'trader', roi: 42.5 },
      ],
      traderCount: 1,
      userCount: 0,
    }
    mockTieredGet.mockResolvedValue({ data: cachedResult })

    const req = new NextRequest('http://localhost/api/following?userId=user-123')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].handle).toBe('TopTrader')
    expect(body.count).toBe(1)
    expect(body.traderCount).toBe(1)
  })

  it('applies pagination with limit and offset', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      handle: `Trader${i}`,
      type: 'trader' as const,
      roi: i * 10,
    }))
    mockTieredGet.mockResolvedValue({
      data: { items, traderCount: 10, userCount: 0 },
    })

    const req = new NextRequest('http://localhost/api/following?userId=user-123&limit=3&offset=2')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.items).toHaveLength(3)
    expect(body.items[0].id).toBe('t2')
    expect(body.limit).toBe(3)
    expect(body.offset).toBe(2)
    expect(body.hasMore).toBe(true)
  })

  it('clamps limit to max 200', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockTieredGet.mockResolvedValue({
      data: { items: [], traderCount: 0, userCount: 0 },
    })

    const req = new NextRequest('http://localhost/api/following?userId=user-123&limit=500')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.limit).toBe(200)
  })

  // --- Error Handling ---

  it('returns 500 on unexpected error', async () => {
    mockGetAuthUser.mockRejectedValue(new Error('Auth service down'))

    const req = new NextRequest('http://localhost/api/following?userId=user-123')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    // middleware sanitizes 5xx errors to generic English message
    expect(body.error).toBe('Internal server error')
  })
})
