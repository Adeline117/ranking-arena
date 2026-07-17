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

    async json() {
      return this._body
    }
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
      this._headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Test)', ...(opts?.headers || {}) })
      )
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
type QueryResult = { data: unknown; error: unknown }
let mockDefaultQueryResult: QueryResult = { data: [], error: null }
let mockQueryResults = new Map<string, QueryResult>()

function buildChainMock(table: string): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) =>
          resolve(mockQueryResults.get(table) ?? mockDefaultQueryResult)
      }
      if (prop === 'catch' || prop === 'finally') return undefined
      return jest.fn(() => new Proxy({}, handler))
    },
  }
  return new Proxy({}, handler)
}

const mockSupabaseFrom = jest.fn((table: string) => buildChainMock(table))

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: jest.fn(() => ({
    from: (table: string) => mockSupabaseFrom(table),
  })),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ response: null, meta: null }),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: {
    authenticated: { limit: 60, window: 60 },
    public: { limit: 100, window: 60 },
  },
}))

jest.mock('@/lib/utils/logger', () => {
  const inst = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    apiError: jest.fn(),
    dbError: jest.fn(),
  }
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
import { GET, invalidateFollowingCache } from '../route'

describe('GET /api/following', () => {
  const mockUser = { id: 'user-123', email: 'test@example.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockTieredGet.mockResolvedValue({ data: null })
    mockTieredSet.mockResolvedValue(undefined)
    mockDefaultQueryResult = { data: [], error: null }
    mockQueryResults = new Map()
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

  it('caches only edge candidates and excludes mutable profile fields', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockQueryResults.set('trader_follows', {
      data: [
        {
          trader_id: 'trader-1',
          source: 'bybit',
          created_at: '2026-07-16T00:00:00.000Z',
        },
      ],
      error: null,
    })
    mockQueryResults.set('user_follows', {
      data: [
        {
          following_id: 'user-2',
          created_at: '2026-07-16T00:01:00.000Z',
        },
      ],
      error: null,
    })
    mockQueryResults.set('user_profiles', {
      data: [
        {
          id: 'user-2',
          handle: 'Current user',
          bio: 'Mutable bio',
          avatar_url: 'https://example.com/current.png',
          deleted_at: null,
          banned_at: null,
          is_banned: false,
          ban_expires_at: null,
        },
      ],
      error: null,
    })
    mockQueryResults.set('leaderboard_ranks', {
      data: [
        {
          source_trader_id: 'trader-1',
          source: 'bybit',
          handle: 'Current trader',
          avatar_url: null,
          roi: 10,
          pnl: null,
          win_rate: null,
          followers: null,
          arena_score: 60,
        },
      ],
      error: null,
    })

    const response = await GET(new NextRequest('http://localhost/api/following?userId=user-123'))

    expect(response.status).toBe(200)
    expect(mockTieredSet).toHaveBeenCalledWith(
      'following:v2:candidates:user-123',
      {
        traders: [
          {
            traderId: 'trader-1',
            source: 'bybit',
            followedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
        users: [{ userId: 'user-2', followedAt: '2026-07-16T00:01:00.000Z' }],
      },
      'hot',
      ['following']
    )
    expect(JSON.stringify(mockTieredSet.mock.calls)).not.toContain('Mutable bio')
    expect(JSON.stringify(mockTieredSet.mock.calls)).not.toContain('Current trader')
  })

  it('uses cached edges but re-materializes current trader fields', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockTieredGet.mockResolvedValue({
      data: {
        traders: [
          {
            traderId: 'trader1',
            source: 'bybit',
            followedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
        users: [],
      },
    })
    mockQueryResults.set('leaderboard_ranks', {
      data: [
        {
          source_trader_id: 'trader1',
          source: 'bybit',
          handle: 'Current handle',
          avatar_url: null,
          roi: 42.5,
          pnl: 10,
          win_rate: 60,
          followers: 4,
          arena_score: 80,
        },
      ],
      error: null,
    })

    const req = new NextRequest('http://localhost/api/following?userId=user-123')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].handle).toBe('Current handle')
    expect(body.count).toBe(1)
    expect(body.traderCount).toBe(1)
    expect(mockSupabaseFrom).toHaveBeenCalledWith('leaderboard_ranks')
  })

  it('applies pagination with limit and offset', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    const traders = Array.from({ length: 10 }, (_, i) => ({
      traderId: `t${i}`,
      source: 'bybit',
      followedAt: new Date(Date.UTC(2026, 6, 16, 0, 0, 10 - i)).toISOString(),
    }))
    mockTieredGet.mockResolvedValue({
      data: { traders, users: [] },
    })
    mockQueryResults.set('leaderboard_ranks', {
      data: traders.map((candidate, i) => ({
        source_trader_id: candidate.traderId,
        source: candidate.source,
        handle: `Trader${i}`,
        avatar_url: null,
        roi: i * 10,
        pnl: null,
        win_rate: null,
        followers: null,
        arena_score: 50 + i,
      })),
      error: null,
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
      data: { traders: [], users: [] },
    })

    const req = new NextRequest('http://localhost/api/following?userId=user-123&limit=500')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.limit).toBe(200)
  })

  it('drops a cached user edge when the current profile is inactive', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockTieredGet.mockResolvedValue({
      data: {
        traders: [],
        users: [{ userId: 'inactive-user', followedAt: '2026-07-16T00:00:00.000Z' }],
      },
    })
    mockQueryResults.set('user_profiles', {
      data: [
        {
          id: 'inactive-user',
          handle: 'cached-name-must-not-escape',
          bio: null,
          avatar_url: null,
          deleted_at: '2026-07-16T01:00:00.000Z',
          banned_at: null,
          is_banned: false,
          ban_expires_at: null,
        },
      ],
      error: null,
    })

    const response = await GET(new NextRequest('http://localhost/api/following?userId=user-123'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.items).toEqual([])
    expect(body.userCount).toBe(0)
    expect(JSON.stringify(body)).not.toContain('cached-name-must-not-escape')
  })

  it('binds reused trader IDs to their exact source', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockTieredGet.mockResolvedValue({
      data: {
        traders: [
          { traderId: 'shared-id', source: 'bybit' },
          { traderId: 'shared-id', source: 'binance_futures' },
        ],
        users: [],
      },
    })
    mockQueryResults.set('leaderboard_ranks', {
      data: [
        {
          source_trader_id: 'shared-id',
          source: 'binance_futures',
          handle: 'Binance trader',
          avatar_url: null,
          roi: 20,
          pnl: null,
          win_rate: null,
          followers: null,
          arena_score: 70,
        },
        {
          source_trader_id: 'shared-id',
          source: 'bybit',
          handle: 'Bybit trader',
          avatar_url: null,
          roi: 10,
          pnl: null,
          win_rate: null,
          followers: null,
          arena_score: 60,
        },
      ],
      error: null,
    })

    const response = await GET(new NextRequest('http://localhost/api/following?userId=user-123'))
    const body = await response.json()

    expect(body.items).toEqual([
      expect.objectContaining({ id: 'shared-id', source: 'bybit', handle: 'Bybit trader' }),
      expect.objectContaining({
        id: 'shared-id',
        source: 'binance_futures',
        handle: 'Binance trader',
      }),
    ])
  })

  it('fails closed when current profile materialization fails', async () => {
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockTieredGet.mockResolvedValue({
      data: { traders: [], users: [{ userId: 'user-2' }] },
    })
    mockQueryResults.set('user_profiles', {
      data: null,
      error: new Error('profiles unavailable'),
    })

    const response = await GET(new NextRequest('http://localhost/api/following?userId=user-123'))

    expect(response.status).toBe(500)
  })

  it('invalidates both candidate and legacy payload namespaces', async () => {
    mockTieredDel.mockResolvedValue(undefined)

    await invalidateFollowingCache('user-123')

    expect(mockTieredDel).toHaveBeenCalledWith('following:v2:candidates:user-123')
    expect(mockTieredDel).toHaveBeenCalledWith('following:user-123')
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
