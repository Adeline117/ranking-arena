/**
 * /api/feed/activities route tests
 *
 * Tests the public activity feed endpoint: pagination,
 * filters (platform, handle, cursor), and error handling.
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
  // Build a persistent chain mock that captures all calls
  let queryChain: Record<string, jest.Mock>
  let queryResult: { data: unknown[] | null; error: unknown }

  function resetQueryChain(
    result: { data: unknown[] | null; error: unknown } = { data: [], error: null }
  ) {
    queryResult = result
    queryChain = {} as Record<string, jest.Mock>
    queryChain.select = jest.fn(() => queryChain)
    queryChain.order = jest.fn(() => queryChain)
    queryChain.eq = jest.fn(() => queryChain)
    queryChain.in = jest.fn(() => queryChain)
    queryChain.lt = jest.fn(() => queryChain)
    // limit() returns the chain (thenable), not a raw Promise.
    // The chain is awaited later by the route, so we make it thenable.
    queryChain.limit = jest.fn(() => queryChain)
    // Make the chain thenable so `await query` resolves to the result
    queryChain.then = jest.fn((resolve: (v: unknown) => void) => resolve(queryResult)) as jest.Mock
    // Make from() always return the same chain
    mockSupabaseFrom.mockReturnValue(queryChain)
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    resetQueryChain()
  })

  it('returns activities with default limit', async () => {
    const activities = [
      {
        id: 'a1',
        source: 'binance_futures',
        handle: 'trader1',
        activity_type: 'roi_milestone',
        occurred_at: '2026-03-06T00:00:00Z',
      },
    ]
    resetQueryChain({ data: activities, error: null })

    const req = new NextRequest('http://localhost/api/feed/activities')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.activities).toHaveLength(1)
    expect(body.data.pagination).toBeDefined()
  })

  it('returns empty activities list', async () => {
    const req = new NextRequest('http://localhost/api/feed/activities')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.activities).toEqual([])
    expect(body.data.pagination.hasMore).toBe(false)
  })

  it('respects limit parameter', async () => {
    resetQueryChain({ data: [], error: null })

    const req = new NextRequest('http://localhost/api/feed/activities?limit=10')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.pagination.limit).toBe(10)
  })

  it('filters by platform', async () => {
    resetQueryChain({ data: [], error: null })

    const req = new NextRequest('http://localhost/api/feed/activities?platform=binance_futures')
    await GET(req)

    expect(queryChain.eq).toHaveBeenCalledWith('source', 'binance_futures')
  })

  it('filters by handle', async () => {
    resetQueryChain({ data: [], error: null })

    const req = new NextRequest('http://localhost/api/feed/activities?handle=toptrader')
    await GET(req)

    expect(queryChain.eq).toHaveBeenCalledWith('handle', 'toptrader')
  })

  it('supports cursor-based pagination', async () => {
    resetQueryChain({ data: [], error: null })

    const cursor = '2026-03-05T12:00:00Z'
    const req = new NextRequest(`http://localhost/api/feed/activities?cursor=${cursor}`)
    await GET(req)

    expect(queryChain.lt).toHaveBeenCalledWith('occurred_at', cursor)
  })

  it('detects hasMore when extra item fetched', async () => {
    // When limit is 5, route fetches 6 items. If 6 returned, hasMore=true.
    const activities = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      source: 'binance_futures',
      handle: `trader${i}`,
      activity_type: 'roi_milestone',
      occurred_at: `2026-03-0${6 - i}T00:00:00Z`,
    }))
    resetQueryChain({ data: activities, error: null })

    const req = new NextRequest('http://localhost/api/feed/activities?limit=5')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.activities).toHaveLength(5)
    expect(body.data.pagination.hasMore).toBe(true)
    expect(body.data.pagination.nextCursor).toBeDefined()
  })

  it('handles database error gracefully', async () => {
    resetQueryChain({ data: null, error: { message: 'DB query failed' } })

    const req = new NextRequest('http://localhost/api/feed/activities')
    const res = await GET(req)
    const body = await res.json()

    // handleError returns a structured error response
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(body.success).toBe(false)
  })

  it('binds a following feed to the exact source and trader ID pair', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'user-1' })

    const followResult = {
      data: [{ trader_id: 'shared-id', source: 'bybit' }],
      error: null,
    }
    const activityResult = {
      data: [
        {
          id: 'allowed',
          source: 'bybit',
          source_trader_id: 'shared-id',
          handle: 'Bybit trader',
          avatar_url: null,
          activity_type: 'roi_milestone',
          activity_text: 'Allowed activity',
          metric_value: 10,
          metric_label: 'ROI',
          occurred_at: '2026-07-16T02:00:00.000Z',
        },
        {
          id: 'cross-platform',
          source: 'binance_futures',
          source_trader_id: 'shared-id',
          handle: 'Unfollowed trader',
          avatar_url: null,
          activity_type: 'roi_milestone',
          activity_text: 'Must not escape',
          metric_value: 20,
          metric_label: 'ROI',
          occurred_at: '2026-07-16T03:00:00.000Z',
        },
      ],
      error: null,
    }

    const followChain = {} as Record<string, jest.Mock>
    for (const method of ['select', 'eq', 'limit']) {
      followChain[method] = jest.fn(() => followChain)
    }
    followChain.then = jest.fn((resolve: (value: unknown) => void) => resolve(followResult))

    const activityChain = {} as Record<string, jest.Mock>
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'lt']) {
      activityChain[method] = jest.fn(() => activityChain)
    }
    activityChain.then = jest.fn((resolve: (value: unknown) => void) => resolve(activityResult))

    mockSupabaseFrom.mockImplementation((table: string) =>
      table === 'trader_follows' ? followChain : activityChain
    )

    const response = await GET(
      new NextRequest('http://localhost/api/feed/activities?following=1&limit=5')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(followChain.select).toHaveBeenCalledWith('trader_id, source')
    expect(followChain.limit).toHaveBeenCalledWith(500)
    expect(activityChain.eq).toHaveBeenCalledWith('source', 'bybit')
    expect(activityChain.in).toHaveBeenCalledWith('source_trader_id', ['shared-id'])
    expect(body.data.activities).toEqual([expect.objectContaining({ id: 'allowed' })])
    expect(JSON.stringify(body)).not.toContain('Must not escape')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('returns an anonymous following request empty with private no-store headers', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await GET(
      new NextRequest('http://localhost/api/feed/activities?following=true')
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.activities).toEqual([])
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
