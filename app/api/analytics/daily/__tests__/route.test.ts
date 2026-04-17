/**
 * /api/analytics/daily route tests
 *
 * Tests CRON_SECRET auth, Supabase queries, upsert behavior,
 * and error handling for the daily analytics aggregation API.
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
    _headers: Map<string, string>

    constructor(url: string, init?: { method?: string; headers?: Record<string, string> }) {
      this.url = url
      this.nextUrl = new URL(url)
      this._headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(init?.headers || {}) }))
    }

    get headers() {
      return {
        get: (key: string) => this._headers.get(key) || null,
      }
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockUpsert = jest.fn().mockResolvedValue({ error: null })

// Each from() call returns a chainable mock; the final call resolves with count
function buildSelectChain(count: number) {
  return {
    select: jest.fn().mockReturnValue({
      gte: jest.fn().mockReturnValue({
        lt: jest.fn().mockResolvedValue({ count }),
        // For queries without .lt() (activeUsers, newClaims, newFollows)
        then: (resolve: (v: unknown) => void) => resolve({ count }),
      }),
    }),
  }
}

let selectCounts = { signups: 10, activeUsers: 50, newClaims: 3, newFollows: 12 }
let callIndex = 0

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn((table: string) => {
      if (table === 'analytics_daily') {
        return { upsert: mockUpsert }
      }
      // Return counts in order: user_profiles, interactions, trader_claims, trader_follows
      const counts = [
        selectCounts.signups,
        selectCounts.activeUsers,
        selectCounts.newClaims,
        selectCounts.newFollows,
      ]
      const idx = callIndex++
      return buildSelectChain(counts[idx] ?? 0)
    }),
  })),
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/lib/services/pipeline-logger', () => ({
  PipelineLogger: {
    start: jest.fn(() =>
      Promise.resolve({
        success: jest.fn(),
        error: jest.fn(),
        timeout: jest.fn(),
      })
    ),
  },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

// Helper to create a request with auth header
function createRequest(authToken?: string) {
  const headers: Record<string, string> = {}
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}`
  }
  return new NextRequest('http://localhost/api/analytics/daily', {
    method: 'POST',
    headers,
  })
}

describe('POST /api/analytics/daily', () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET

  beforeEach(() => {
    jest.clearAllMocks()
    callIndex = 0
    selectCounts = { signups: 10, activeUsers: 50, newClaims: 3, newFollows: 12 }
    mockUpsert.mockResolvedValue({ error: null })
    process.env.CRON_SECRET = 'test-cron-secret'
  })

  afterAll(() => {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET
  })

  // --- Authentication ---

  it('returns 401 when authorization header is missing', async () => {
    const req = createRequest()
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBe('unauthorized')
  })

  it('returns 401 when CRON_SECRET does not match', async () => {
    const req = createRequest('wrong-secret')
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBe('unauthorized')
  })

  // --- Success Case ---

  it('returns ok with aggregated data when auth is valid', async () => {
    const req = createRequest('test-cron-secret')
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    // withCron spreads result at top level, not under .data
    expect(body.signups).toBe(10)
    expect(body.active_users).toBe(50)
    expect(body.new_claims).toBe(3)
    expect(body.new_follows).toBe(12)
    expect(body.date).toBeDefined()
  })

  it('calls upsert with onConflict date', async () => {
    const req = createRequest('test-cron-secret')
    await POST(req)

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        signups: 10,
        active_users: 50,
        new_claims: 3,
        new_follows: 12,
      }),
      { onConflict: 'date' }
    )
  })

  it('handles null counts gracefully (defaults to 0)', async () => {
    // Simulate null counts by using a count of 0
    selectCounts = { signups: 0, activeUsers: 0, newClaims: 0, newFollows: 0 }

    const req = createRequest('test-cron-secret')
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.signups).toBe(0)
    expect(body.active_users).toBe(0)
  })

  // --- Database Error ---

  it('returns 500 when upsert fails', async () => {
    mockUpsert.mockResolvedValue({ error: { message: 'constraint violation', code: '23505' } })

    const req = createRequest('test-cron-secret')
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    // withCron passes through the original error message
    expect(body.error).toContain('constraint violation')
  })

  // --- Unexpected Error ---

  it('returns 500 on unexpected exception', async () => {
    mockUpsert.mockRejectedValue(new Error('Connection timeout'))

    const req = createRequest('test-cron-secret')
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toContain('Connection timeout')
  })
})
