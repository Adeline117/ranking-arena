/**
 * /api/feedback route tests
 *
 * Tests input validation, rate limiting, optional auth,
 * Supabase insert, and error handling for the feedback API.
 */

// --- Mocks (must be before imports) ---

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
    method: string
    _headers: Map<string, string>
    _body: unknown
    cookies: { get: () => undefined }

    constructor(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.method = init?.method || 'POST'
      this._headers = new Map(Object.entries({
        'user-agent': 'Mozilla/5.0 (Test)',
        ...(init?.headers || {}),
      }))
      this._body = init?.body ? JSON.parse(init.body) : undefined
      this.cookies = { get: () => undefined }
    }

    get headers() {
      return {
        get: (key: string) => this._headers.get(key) || null,
      }
    }

    async json() {
      return this._body
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockInsert = jest.fn().mockResolvedValue({ data: null, error: null })
const mockGetUser = jest.fn().mockResolvedValue({ data: { user: null }, error: null })
const mockGetAuthUser = jest.fn().mockResolvedValue(null)

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({
      insert: mockInsert,
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    })),
    auth: {
      getUser: mockGetUser,
    },
  })),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { sensitive: { max: 15, window: '1m', prefix: 'sensitive' } },
}))

// Skip CSRF validation in tests
jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  generateCsrfToken: jest.fn().mockReturnValue('test-csrf-token'),
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

// Mock correlation ID module
jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id, fn) => fn()),
  getCorrelationId: jest.fn().mockReturnValue('test-cid'),
}))

// Mock versioning
jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

// Helper to create a feedback request
function createRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return new NextRequest('http://localhost/api/feedback', {
    method: 'POST',
    headers: { 'x-forwarded-for': `${Math.random()}.0.0.1`, ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockInsert.mockResolvedValue({ data: null, error: null })
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    mockGetAuthUser.mockResolvedValue(null)
  })

  // --- Input Validation ---

  it('returns 400 when message is missing', async () => {
    const req = createRequest({})
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Message is required')
  })

  it('returns 400 when message is empty string', async () => {
    const req = createRequest({ message: '' })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Message is required')
  })

  it('returns 400 when message is whitespace only', async () => {
    const req = createRequest({ message: '   ' })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Message is required')
  })

  it('returns 400 when message is not a string', async () => {
    const req = createRequest({ message: 12345 })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Message is required')
  })

  it('returns 400 when message exceeds 5000 characters', async () => {
    const req = createRequest({ message: 'x'.repeat(5001) })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toBe('Message too long')
  })

  // --- Success Case ---

  it('returns ok for valid feedback without auth', async () => {
    const req = createRequest({
      message: 'Great platform!',
      page_url: 'https://arenafi.org/rankings',
      user_agent: 'Mozilla/5.0',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(mockInsert).toHaveBeenCalledWith({
      user_id: null,
      message: 'Great platform!',
      page_url: 'https://arenafi.org/rankings',
      user_agent: 'Mozilla/5.0',
      screenshot_url: null,
    })
  })

  it('trims message whitespace before saving', async () => {
    const req = createRequest({ message: '  Hello world  ' })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hello world' })
    )
  })

  // --- Auth (optional) ---

  it('includes user_id when Bearer token is valid', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'user-123', email: 'test@example.com' })

    const req = createRequest(
      { message: 'Feedback from authed user' },
      { authorization: 'Bearer valid-token-abc' }
    )
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-123' })
    )
  })

  it('sets user_id to null when Bearer token is invalid', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const req = createRequest(
      { message: 'Anonymous feedback' },
      { authorization: 'Bearer bad-token' }
    )
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null })
    )
  })

  // --- Database Error ---

  it('returns 500 when Supabase insert fails', async () => {
    mockInsert.mockResolvedValue({ data: null, error: { message: 'DB error', code: '500' } })

    const req = createRequest({ message: 'This will fail' })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('Failed to save feedback')
  })

  // --- Unexpected Error ---

  it('returns 500 on unexpected exception', async () => {
    mockInsert.mockRejectedValue(new Error('Connection refused'))

    const req = createRequest({ message: 'This will throw' })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    // Middleware sanitizes internal errors to prevent leaking implementation details
    expect(body.error).toBeTruthy()
  })

  // --- Rate Limiting ---

  it('returns 429 when rate limit is exceeded', async () => {
    // Mock checkRateLimitFull to return a 429 response (middleware uses checkRateLimitFull)
    const rateLimit = jest.requireMock('@/lib/utils/rate-limit') as { checkRateLimitFull: jest.Mock }
    const { NextResponse: NR } = jest.requireMock('next/server') as { NextResponse: typeof import('next/server').NextResponse }
    rateLimit.checkRateLimitFull.mockResolvedValueOnce({
      response: NR.json({ error: 'Too many requests' }, { status: 429 }),
      meta: null,
    })

    const req = createRequest({ message: 'Rate limited' })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body.error).toMatch(/Too many/)
  })
})
