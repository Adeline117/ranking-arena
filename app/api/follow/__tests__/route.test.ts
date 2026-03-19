/**
 * /api/follow route tests
 *
 * Tests authentication, input validation, follow/unfollow actions,
 * and error handling for the follow API.
 */

// --- Mocks ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    cookies: { get: jest.Mock }
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
      this.cookies = { get: jest.fn() }
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
    cookies: { get: jest.Mock }
    _body: unknown
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string; body?: unknown }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) }))
      this.method = opts?.method || 'GET'
      this.cookies = { get: jest.fn() }
      this._body = opts?.body
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
let mockSupabaseResult: { data: unknown; error: unknown } = { data: null, error: null }

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, authenticated: {}, public: {}, sensitive: {} },
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
  return {
    createLogger: jest.fn(() => inst),
    fireAndForget: jest.fn(),
  }
})

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: 'csrf',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
}))

jest.mock('@/app/api/following/route', () => ({
  invalidateFollowingCache: jest.fn().mockResolvedValue(undefined),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

describe('/api/follow', () => {
  const mockUser = { id: 'user-123', email: 'test@example.com' }

  function createMockSupabase(result: { data: unknown; error: unknown } = { data: null, error: null }) {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        if (prop === 'catch' || prop === 'finally') return undefined
        return jest.fn(() => new Proxy({}, handler))
      },
    }
    return { from: jest.fn(() => new Proxy({}, handler)) }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockSupabaseResult = { data: null, error: null }
    mockGetSupabaseAdmin.mockReturnValue(createMockSupabase(mockSupabaseResult))
  })

  // --- GET: Check Follow Status ---

  describe('GET /api/follow', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const req = new NextRequest('http://localhost/api/follow?traderId=t1')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(401)
      expect(body.success).toBe(false)
    })

    it('returns 400 when traderId is missing', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: null, error: null }))

      const req = new NextRequest('http://localhost/api/follow')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.success).toBe(false)
    })

    it('returns following: false when not following', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: null, error: null }))

      const req = new NextRequest('http://localhost/api/follow?traderId=trader-abc')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      // withApiMiddleware wraps result as { success: true, data: { following: false } }
      const following = body.data?.following ?? body.following
      expect(following).toBe(false)
    })

    it('returns following: true when already following', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: { id: 'follow-1' }, error: null }))

      const req = new NextRequest('http://localhost/api/follow?traderId=trader-abc')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      const following = body.data?.following ?? body.following
      expect(following).toBe(true)
    })
  })

  // --- POST: Follow/Unfollow ---

  describe('POST /api/follow', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const req = new NextRequest('http://localhost/api/follow', {
        method: 'POST',
        body: { traderId: 'trader-abc', action: 'follow' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(401)
      expect(body.success).toBe(false)
    })

    it('returns 400 when traderId is missing', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: null, error: null }))

      const req = new NextRequest('http://localhost/api/follow', {
        method: 'POST',
        body: { action: 'follow' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toBeDefined()
    })

    it('returns 400 when action is invalid', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: null, error: null }))

      const req = new NextRequest('http://localhost/api/follow', {
        method: 'POST',
        body: { traderId: 'trader-abc', action: 'block' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(400)
      expect(body.error).toBeDefined()
    })

    it('successfully follows a trader', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: null, error: null }))

      const req = new NextRequest('http://localhost/api/follow', {
        method: 'POST',
        body: { traderId: 'trader-abc', action: 'follow' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      const followResult = body.data?.following ?? body.following
      expect(followResult).toBe(true)
    })

    it('successfully unfollows a trader', async () => {
      mockGetAuthUser.mockResolvedValue(mockUser)
      mockGetSupabaseAdmin.mockReturnValue(createMockSupabase({ data: null, error: null }))

      const req = new NextRequest('http://localhost/api/follow', {
        method: 'POST',
        body: { traderId: 'trader-abc', action: 'unfollow' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      const unfollowResult = body.data?.following ?? body.following
      expect(unfollowResult).toBe(false)
    })
  })
})
