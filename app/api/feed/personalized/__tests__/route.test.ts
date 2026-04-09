/**
 * /api/feed/personalized route tests
 *
 * Tests the personalized feed endpoint: authenticated personalized feed,
 * unauthenticated fallback, pagination, and error handling.
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

const mockGetAuthUser = jest.fn()
const mockRpc = jest.fn()
const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  })),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  requireAuth: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

const mockGetUserPostReactions = jest.fn()
const mockGetUserPostVotes = jest.fn()

jest.mock('@/lib/data/posts', () => ({
  getUserPostReactions: (...args: unknown[]) => mockGetUserPostReactions(...args),
  getUserPostVotes: (...args: unknown[]) => mockGetUserPostVotes(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  fireAndForget: jest.fn(),
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

// Cache layer: bypass by always invoking the factory and returning its result.
jest.mock('@/lib/cache', () => ({
  getOrSet: jest.fn(async (_key: string, factory: () => Promise<unknown>) => factory()),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/feed/personalized', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockGetUserPostReactions.mockResolvedValue(new Map())
    mockGetUserPostVotes.mockResolvedValue(new Map())

    // Default supabase from chain for fallback queries
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], error: null }),
      in: jest.fn().mockResolvedValue({ data: [], error: null }),
    })
  })

  it('returns hot posts for unauthenticated users', async () => {
    const mockPosts = [
      { id: 'p1', title: 'Hot Post', hot_score: 100 },
    ]
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: mockPosts, error: null }),
    })

    const req = new NextRequest('http://localhost/api/feed/personalized')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.posts).toBeDefined()
  })

  it('returns personalized feed for authenticated users', async () => {
    const mockUser = { id: 'user-1' }
    mockGetAuthUser.mockResolvedValue(mockUser)

    // RPC returns post IDs
    mockRpc.mockResolvedValue({
      data: [{ post_id: 'p1' }, { post_id: 'p2' }],
      error: null,
    })

    // Full post fetch
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [
          { id: 'p1', title: 'Post 1' },
          { id: 'p2', title: 'Post 2' },
        ],
        error: null,
      }),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], error: null }),
    })

    const req = new NextRequest('http://localhost/api/feed/personalized')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.posts).toHaveLength(2)
  })

  it('falls back to hot posts when RPC fails', async () => {
    const mockUser = { id: 'user-1' }
    mockGetAuthUser.mockResolvedValue(mockUser)

    mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC error' } })
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({
        data: [{ id: 'fallback-1', title: 'Fallback' }],
        error: null,
      }),
      in: jest.fn().mockResolvedValue({ data: [], error: null }),
    })

    const req = new NextRequest('http://localhost/api/feed/personalized')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.posts).toBeDefined()
  })

  it('respects limit parameter', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], error: null }),
    })

    const req = new NextRequest('http://localhost/api/feed/personalized?limit=5&offset=10')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.meta.pagination.limit).toBe(5)
    expect(body.meta.pagination.offset).toBe(10)
  })

  it('attaches user reactions/votes when authenticated', async () => {
    const mockUser = { id: 'user-1' }
    mockGetAuthUser.mockResolvedValue(mockUser)

    mockRpc.mockResolvedValue({
      data: [{ post_id: 'p1' }],
      error: null,
    })
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      in: jest.fn().mockResolvedValue({
        data: [{ id: 'p1', title: 'Post 1' }],
        error: null,
      }),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], error: null }),
    })
    mockGetUserPostReactions.mockResolvedValue(new Map([['p1', 'up']]))
    mockGetUserPostVotes.mockResolvedValue(new Map([['p1', 'bull']]))

    const req = new NextRequest('http://localhost/api/feed/personalized')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.posts[0].user_reaction).toBe('up')
    expect(body.data.posts[0].user_vote).toBe('bull')
  })

  it('returns empty posts when no data', async () => {
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      range: jest.fn().mockResolvedValue({ data: [], error: null }),
    })

    const req = new NextRequest('http://localhost/api/feed/personalized')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.posts).toEqual([])
    expect(body.meta.pagination.has_more).toBe(false)
  })
})
