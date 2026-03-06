/**
 * /api/activity route tests
 *
 * Tests the activity logging endpoint (POST only),
 * including auth, input validation, batch size limits, and error handling.
 */

// --- Mocks ---

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
      this.headers = new Map(Object.entries(opts?.headers || {}))
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { read: {}, write: {} },
}))

const mockGetAuthUser = jest.fn()
let mockInsertResult: { data: unknown; error: unknown } = { data: null, error: null }

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => ({
      insert: jest.fn().mockImplementation(() => Promise.resolve(mockInsertResult)),
    })),
  })),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

describe('POST /api/activity', () => {
  const mockUser = { id: 'user-1', email: 'test@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockInsertResult = { data: null, error: null }
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: { events: [{ action: 'page_view' }] },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBeDefined()
  })

  // --- Input Validation ---

  it('returns 400 when events array is missing', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: {},
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/invalid/i)
  })

  it('returns 400 when events is empty array', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: { events: [] },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
  })

  it('returns 400 when events exceed max 100', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const events = Array.from({ length: 101 }, (_, i) => ({ action: 'page_view', metadata: { page: `p${i}` } }))

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: { events },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/100/i)
  })

  it('returns 400 when all events have invalid actions', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: { events: [{ action: 'invalid_action' }] },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toMatch(/valid/i)
  })

  // --- Successful Cases ---

  it('logs valid activity events', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: {
        events: [
          { action: 'page_view', metadata: { page: '/rankings' } },
          { action: 'search', metadata: { query: 'bitcoin' } },
        ],
      },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.count).toBe(2)
  })

  it('filters out invalid actions from mixed batch', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: {
        events: [
          { action: 'page_view' },
          { action: 'invalid_one' },
          { action: 'follow' },
        ],
      },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.count).toBe(2) // Only page_view and follow are valid
  })

  it('accepts all valid action types', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)

    const validActions = ['page_view', 'search', 'follow', 'unfollow', 'like', 'post', 'compare', 'library_view', 'trade_copy']
    const events = validActions.map(action => ({ action }))

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: { events },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.count).toBe(validActions.length)
  })

  // --- Error Handling ---

  it('returns 500 when database insert fails', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockInsertResult = { data: null, error: { message: 'DB insert failed' } }

    const req = new NextRequest('http://localhost/api/activity', {
      method: 'POST',
      body: { events: [{ action: 'page_view' }] },
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toMatch(/save failed/i)
  })
})
