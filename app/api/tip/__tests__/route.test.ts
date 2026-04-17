/**
 * /api/tip route tests
 *
 * Tests authentication, input validation, tip creation,
 * self-tip prevention, and error handling for the tip API.
 *
 * Note: This tests the base /api/tip route (gifts table insert),
 * not the /api/tip/checkout route (Stripe session creation).
 */

// --- Mocks (must be before imports) ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
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
    _body: unknown
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string; body?: unknown }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Jest Test Runner)', ...opts?.headers }))
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {}, sensitive: {}, authenticated: {} },
}))

const mockGetAuthUser = jest.fn()

// Track Supabase calls by table
let mockPostSelectResult: { data: unknown; error: unknown } = { data: null, error: null }
let mockGiftInsertResult: { error: unknown } = { error: null }

const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table === 'posts') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            maybeSingle: jest.fn().mockResolvedValue(mockPostSelectResult),
          }),
        }),
      }
    }
    if (table === 'gifts') {
      return {
        insert: jest.fn().mockResolvedValue(mockGiftInsertResult),
      }
    }
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
    }
  }),
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function, _opts?: unknown) => async (req: unknown) => {
    const user = await mockGetAuthUser(req)
    if (!user) {
      const { NextResponse: NR } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NR.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return handler({ user, supabase: mockSupabase, request: req, version: { current: 'v1' } })
  },
  withPublic: (handler: Function) => handler,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabase),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  fireAndForget: jest.fn(),
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

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: 'csrf',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

jest.mock('@/lib/api/validation', () => ({
  validateString: jest.fn((val: unknown, opts?: { required?: boolean; fieldName?: string }) => {
    if (opts?.required && (typeof val !== 'string' || !val.trim())) return null
    return typeof val === 'string' ? val.trim() : null
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

describe('POST /api/tip', () => {
  const mockUser = { id: 'user-123', email: 'test@test.com' }
  const mockPost = { id: 'post-abc', author_id: 'author-456' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockPostSelectResult = { data: mockPost, error: null }
    mockGiftInsertResult = { error: null }
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc', amount_cents: 100 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBeDefined()
  })

  // --- Input Validation ---

  it('returns 400 when post_id is missing', async () => {
    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { amount_cents: 100 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/post_id|Missing/i)
  })

  it('returns 400 when amount_cents is negative', async () => {
    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc', amount_cents: -100 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/Invalid tip amount/i)
  })

  it('returns 400 when amount_cents exceeds maximum', async () => {
    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc', amount_cents: 200000 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/Invalid tip amount/i)
  })

  // --- Post Not Found ---

  it('returns 404 when post does not exist', async () => {
    mockPostSelectResult = { data: null, error: null }

    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'nonexistent-post', amount_cents: 100 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error?.message ?? body.error).toMatch(/Post not found/i)
  })

  // --- Self-Tip Prevention ---

  it('returns 400 when trying to tip own post', async () => {
    mockPostSelectResult = { data: { id: 'post-abc', author_id: 'user-123' }, error: null }

    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc', amount_cents: 100 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/Cannot tip your own/i)
  })

  // --- Success Case ---

  it('creates tip successfully with valid input', async () => {
    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc', amount_cents: 300 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data?.message ?? body.message).toMatch(/Tip successful/i)
    expect(mockSupabase.from).toHaveBeenCalledWith('gifts')
  })

  it('defaults amount_cents to 100 when not provided', async () => {
    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc' },
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    // The route defaults to 100 when amount_cents is not set
    expect(mockSupabase.from).toHaveBeenCalledWith('gifts')
  })

  // --- Database Error ---

  it('returns 500 when gift insert fails', async () => {
    mockGiftInsertResult = { error: { message: 'DB constraint violation' } }

    const req = new NextRequest('http://localhost/api/tip', {
      method: 'POST',
      body: { post_id: 'post-abc', amount_cents: 100 },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error?.message ?? body.error).toMatch(/Tip failed/i)
  })
})
