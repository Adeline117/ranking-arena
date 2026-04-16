/**
 * Integration tests for withApiMiddleware
 *
 * Covers the full middleware pipeline:
 *   - Authentication (requireAuth)
 *   - Rate limiting (429)
 *   - CSRF validation (403)
 *   - Error response format (correlation ID, status, safe messages)
 *   - Correlation ID propagation (X-Correlation-ID header)
 *   - Versioning headers (X-API-Version)
 *
 * Complements lib/api/__tests__/middleware.test.ts (which tests individual features)
 * by asserting the full integration contract exposed to callers.
 */

// -------- next/server mock (must be defined BEFORE imports) ----------
jest.mock('next/server', () => {
  class MockNextRequest {
    url: string
    headers: Map<string, string>
    method: string
    cookies: { get: (name: string) => { value: string } | undefined }

    constructor(
      url: string,
      init?: {
        method?: string
        headers?: Record<string, string>
        cookies?: Record<string, string>
      }
    ) {
      this.url = url
      this.method = init?.method || 'GET'
      this.headers = new Map(
        Object.entries({
          'user-agent': 'Mozilla/5.0 (Integration Test)',
          ...(init?.headers || {}),
        }).map(([k, v]) => [k.toLowerCase(), v])
      )
      // Case-insensitive header lookup
      const rawGet = this.headers.get.bind(this.headers)
      this.headers.get = (k: string) => rawGet(k.toLowerCase())

      const cookieMap = new Map(Object.entries(init?.cookies || {}))
      this.cookies = {
        get: (name: string) => {
          const v = cookieMap.get(name)
          return v ? { value: v } : undefined
        },
      }
    }

    get nextUrl() {
      return new URL(this.url)
    }
  }

  class MockNextResponse {
    body: string
    status: number
    headers: Map<string, string>

    constructor(
      body?: string | null,
      init?: { status?: number; headers?: Record<string, string> }
    ) {
      this.body = body || ''
      this.status = init?.status || 200
      const map = new Map(Object.entries(init?.headers || {}))
      ;(map as unknown as { set: (k: string, v: string) => void }).set = map.set.bind(map)
      ;(map as unknown as { get: (k: string) => string | undefined }).get = map.get.bind(map)
      this.headers = map
    }

    async json() {
      return JSON.parse(this.body)
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(JSON.stringify(data), init)
    }
  }

  return {
    NextRequest: MockNextRequest,
    NextResponse: MockNextResponse,
  }
})

// -------- Supabase mock ----------
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: jest.fn(),
  getSupabaseAdmin: jest.fn(() => ({ from: jest.fn() })),
}))

// -------- Rate-limit mock: NO preset mock from jest.setup.js (we override below)
// The global setup mocks @/lib/utils/rate-limit — we must override with a
// compatible surface including checkRateLimitFull + RateLimitPresets used by
// middleware code.
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimitFull: jest.fn(async () => ({ response: null, meta: null })),
  checkRateLimit: jest.fn(async () => null),
  addRateLimitHeaders: jest.fn((res: unknown) => res),
  RateLimitPresets: {
    public: { requests: 100, window: 60, prefix: 'public' },
    authenticated: { requests: 200, window: 60, prefix: 'auth' },
    write: { requests: 30, window: 60, prefix: 'write' },
  },
}))

// -------- CSRF mock ----------
jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('csrf-token-value'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

// -------- Correlation ID mock (spy on real behavior) ----------
jest.mock('@/lib/api/correlation', () => {
  const actual = jest.requireActual('@/lib/api/correlation')
  return {
    ...actual,
    getOrCreateCorrelationId: jest.fn(actual.getOrCreateCorrelationId),
    runWithCorrelationId: jest.fn(actual.runWithCorrelationId),
  }
})

// -------- Versioning mock: capture header writes so we can assert ----------
jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn(() => ({ version: 'v1', isDeprecated: false })),
  addVersionHeaders: jest.fn((res: { headers: Map<string, string> }, ctx: { version: string }) => {
    res.headers.set('X-API-Version', ctx.version)
  }),
  addDeprecationHeaders: jest.fn(),
}))

import { NextRequest, NextResponse } from 'next/server'
import { withApiMiddleware } from '../middleware'
import { getAuthUser } from '@/lib/supabase/server'
import { checkRateLimitFull } from '@/lib/utils/rate-limit'
import { validateCsrfToken } from '@/lib/utils/csrf'
import { getOrCreateCorrelationId } from '@/lib/api/correlation'

const mockedGetAuthUser = getAuthUser as jest.Mock
const mockedCheckRateLimit = checkRateLimitFull as jest.Mock
const mockedValidateCsrf = validateCsrfToken as jest.Mock
const mockedGetOrCreateCid = getOrCreateCorrelationId as jest.Mock

describe('withApiMiddleware integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedCheckRateLimit.mockResolvedValue({ response: null, meta: null })
    mockedValidateCsrf.mockReturnValue(true)
  })

  // --- Authentication ---

  describe('authentication', () => {
    it('returns 401 when requireAuth:true and user is not logged in', async () => {
      mockedGetAuthUser.mockResolvedValueOnce(null)

      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler, { requireAuth: true })

      const req = new NextRequest('http://localhost/api/protected')
      const res = await wrapped(req)

      expect(res.status).toBe(401)
      expect(handler).not.toHaveBeenCalled()
      const body = await res.json()
      expect(body.success).toBe(false)
      expect(body.error).toBeTruthy()
    })

    it('attaches the authenticated user to the handler context', async () => {
      const user = { id: 'u-42', email: 'test@example.com' }
      mockedGetAuthUser.mockResolvedValueOnce(user)

      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler, { requireAuth: true })

      const req = new NextRequest('http://localhost/api/me')
      await wrapped(req)

      expect(handler).toHaveBeenCalledTimes(1)
      const ctx = handler.mock.calls[0][0]
      expect(ctx.user).toEqual(user)
      expect(ctx.supabase).toBeDefined()
      expect(ctx.request).toBe(req)
      expect(ctx.version).toEqual({ version: 'v1', isDeprecated: false })
    })

    it('does not call getAuthUser on public routes without readsAuth', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/public')
      await wrapped(req)

      expect(mockedGetAuthUser).not.toHaveBeenCalled()
    })
  })

  // --- Rate limiting ---

  describe('rate limiting', () => {
    it('returns 429 response from rate limiter', async () => {
      const rateLimitResp = NextResponse.json(
        { success: false, error: 'Too many requests' },
        { status: 429 }
      )
      mockedCheckRateLimit.mockResolvedValueOnce({
        response: rateLimitResp,
        meta: null,
      })

      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler, { rateLimit: 'public' })

      const req = new NextRequest('http://localhost/api/hot')
      const res = await wrapped(req)

      expect(res.status).toBe(429)
      expect(handler).not.toHaveBeenCalled()
    })

    it('attaches correlation ID to 429 responses', async () => {
      const rateLimitResp = NextResponse.json(
        { success: false, error: 'Too many requests' },
        { status: 429 }
      )
      mockedCheckRateLimit.mockResolvedValueOnce({
        response: rateLimitResp,
        meta: null,
      })

      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/hot', {
        headers: { 'x-correlation-id': 'cid-rate-limit' },
      })
      const res = await wrapped(req)

      expect(res.headers.get('X-Correlation-ID')).toBe('cid-rate-limit')
    })
  })

  // --- CSRF ---

  describe('CSRF validation', () => {
    it('returns 403 when POST request is missing CSRF header', async () => {
      mockedValidateCsrf.mockReturnValueOnce(false)

      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/write', {
        method: 'POST',
      })
      const res = await wrapped(req)

      expect(res.status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
      const body = await res.json()
      expect(body.success).toBe(false)
    })

    it('allows GET requests without CSRF validation', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/read', { method: 'GET' })
      await wrapped(req)

      expect(mockedValidateCsrf).not.toHaveBeenCalled()
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('skips CSRF validation on POST when skipCsrf:true', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler, { skipCsrf: true })

      const req = new NextRequest('http://localhost/api/webhook', { method: 'POST' })
      const res = await wrapped(req)

      expect(mockedValidateCsrf).not.toHaveBeenCalled()
      expect(res.status).toBe(200)
    })
  })

  // --- Error response format ---

  describe('error response format', () => {
    it('returns consistent 500 error shape when handler throws', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('internal db crashed'))
      const wrapped = withApiMiddleware(handler, { name: 'test-api' })

      const req = new NextRequest('http://localhost/api/broken')
      const res = await wrapped(req)

      expect(res.status).toBe(500)
      const body = await res.json()
      // Safe error message — internal detail redacted
      expect(body).toEqual({ success: false, error: 'Internal server error' })
    })

    it('preserves caller-provided status code on structured errors', async () => {
      const err = new Error('widget not found') as Error & { statusCode: number }
      err.statusCode = 404
      const handler = jest.fn().mockRejectedValue(err)
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/404')
      const res = await wrapped(req)

      expect(res.status).toBe(404)
    })

    it('error responses carry correlation ID header', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('boom'))
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/fail', {
        headers: { 'x-correlation-id': 'err-cid-123' },
      })
      const res = await wrapped(req)

      expect(res.status).toBe(500)
      expect(res.headers.get('X-Correlation-ID')).toBe('err-cid-123')
    })

    it('401 auth-fail response carries correlation ID header', async () => {
      mockedGetAuthUser.mockResolvedValueOnce(null)

      const wrapped = withApiMiddleware(jest.fn(), { requireAuth: true })
      const req = new NextRequest('http://localhost/api/me', {
        headers: { 'x-correlation-id': 'auth-cid' },
      })
      const res = await wrapped(req)

      expect(res.status).toBe(401)
      expect(res.headers.get('X-Correlation-ID')).toBe('auth-cid')
    })
  })

  // --- Correlation ID propagation ---

  describe('correlation ID propagation', () => {
    it('preserves incoming X-Correlation-ID on the response', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/trace', {
        headers: { 'x-correlation-id': 'abc-123-xyz' },
      })
      const res = await wrapped(req)

      expect(res.headers.get('X-Correlation-ID')).toBe('abc-123-xyz')
    })

    it('generates a correlation ID when none provided', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/trace')
      const res = await wrapped(req)

      const cid = res.headers.get('X-Correlation-ID')
      expect(cid).toBeTruthy()
      expect(typeof cid).toBe('string')
      expect(cid!.length).toBeGreaterThan(0)
    })

    it('invokes getOrCreateCorrelationId with the incoming request', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/trace')
      await wrapped(req)

      expect(mockedGetOrCreateCid).toHaveBeenCalledWith(req)
    })
  })

  // --- Versioning headers ---

  describe('versioning headers', () => {
    it('adds X-API-Version header to successful responses', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/v')
      const res = await wrapped(req)

      expect(res.headers.get('X-API-Version')).toBe('v1')
    })

    it('adds X-API-Version header to error responses', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('boom'))
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/v-error')
      const res = await wrapped(req)

      expect(res.headers.get('X-API-Version')).toBe('v1')
    })

    it('omits version headers when versioning:false', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler, { versioning: false })

      const req = new NextRequest('http://localhost/api/raw')
      const res = await wrapped(req)

      expect(res.headers.get('X-API-Version')).toBeUndefined()
    })
  })

  // --- Bot protection / response timing ---

  describe('observability headers', () => {
    it('adds X-Response-Time header to successful responses', async () => {
      const handler = jest.fn().mockResolvedValue({ ok: true })
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/time')
      const res = await wrapped(req)

      const rt = res.headers.get('X-Response-Time')
      expect(rt).toMatch(/^\d+ms$/)
    })

    it('rejects requests with missing user-agent (bot protection)', async () => {
      const handler = jest.fn()
      const wrapped = withApiMiddleware(handler)

      const req = new NextRequest('http://localhost/api/bot', {
        headers: { 'user-agent': '' },
      })
      const res = await wrapped(req)

      expect(res.status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
    })
  })
})
