/**
 * /api/feed/activities route publication-boundary tests.
 *
 * No legacy activity row is structurally attestable yet, including
 * win_streak. The route must return its empty/unavailable contract before
 * auth, follows, or trader_activities can be read.
 */

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
    headers: Map<string, string>
    method: string
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries(opts?.headers || {}))
      this.method = 'GET'
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { read: {}, write: {}, public: {} },
}))

const mockSupabaseFrom = jest.fn()
const mockGetAuthUser = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  })),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  requireAuth: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  fireAndForget: jest.fn(),
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/feed/activities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: 'user-1' })
  })

  it('returns the fail-closed empty contract without querying trader_activities', async () => {
    const response = await GET(new NextRequest('http://localhost/api/feed/activities'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toEqual({
      activities: [],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
      activity_visibility: 'unavailable',
      activity_visibility_reason: 'event_time_publication_evidence_unavailable',
    })
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('keeps pagination parsing but cannot turn filters into a legacy table read', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/feed/activities?limit=10&platform=binance_futures&handle=toptrader&cursor=2026-03-05T12%3A00%3A00Z'
      )
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.activities).toEqual([])
    expect(body.data.pagination).toEqual({ limit: 10, hasMore: false, nextCursor: null })
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })

  it('returns following mode empty/private without reading auth, follows, or activities', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/feed/activities?following=true&limit=5')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.activities).toEqual([])
    expect(body.data.pagination).toEqual({ limit: 5, hasMore: false, nextCursor: null })
    expect(body.data.activity_visibility).toBe('unavailable')
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('hides persisted ranking, unknown, win_streak, and large_trade rows by never opening the query', async () => {
    mockSupabaseFrom.mockImplementation(() => {
      throw new Error('legacy activity table must not be consulted')
    })

    const response = await GET(new NextRequest('http://localhost/api/feed/activities'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.activities).toEqual([])
    expect(JSON.stringify(body)).not.toContain('ROI')
    expect(JSON.stringify(body)).not.toContain('win_streak')
    expect(JSON.stringify(body)).not.toContain('large_trade')
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })
})
