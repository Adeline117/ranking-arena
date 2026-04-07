/**
 * /api/posts route tests
 *
 * Tests listing posts (GET) and creating posts (POST),
 * including parameter validation, auth, caching, and error handling.
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
      this.method = opts?.method || 'GET'
      this._body = opts?.body
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { read: {}, write: {}, public: {} },
}))

const mockGetAuthUser = jest.fn()
const mockRequireAuth = jest.fn()
const mockGetUserHandle = jest.fn()
// Chainable mock for Supabase client (select/eq/maybeSingle return PromiseLike)
const mockChain = () => {
  const chain: Record<string, unknown> = {}
  chain.select = jest.fn().mockReturnValue(chain)
  chain.eq = jest.fn().mockReturnValue(chain)
  chain.neq = jest.fn().mockReturnValue(chain)
  chain.in = jest.fn().mockReturnValue(chain)
  chain.or = jest.fn().mockReturnValue(chain)
  chain.is = jest.fn().mockReturnValue(chain)
  chain.not = jest.fn().mockReturnValue(chain)
  chain.ilike = jest.fn().mockReturnValue(chain)
  chain.order = jest.fn().mockReturnValue(chain)
  chain.range = jest.fn().mockReturnValue(chain)
  chain.limit = jest.fn().mockReturnValue(chain)
  chain.maybeSingle = jest.fn().mockReturnValue(chain)
  chain.single = jest.fn().mockReturnValue(chain)
  chain.then = jest.fn((cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: null, error: null })))
  chain.catch = jest.fn().mockReturnValue(chain)
  return chain
}
const mockSupabase = { from: jest.fn().mockReturnValue(mockChain()), rpc: jest.fn().mockResolvedValue({ data: null, error: null }) }
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabase),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getUserHandle: (...args: unknown[]) => mockGetUserHandle(...args),
  getUserProfile: jest.fn(),
}))

const mockGetPosts = jest.fn()
const mockCreatePost = jest.fn()
const mockGetUserPostReactions = jest.fn()
const mockGetUserPostVotes = jest.fn()

jest.mock('@/lib/data/posts', () => ({
  getPosts: (...args: unknown[]) => mockGetPosts(...args),
  createPost: (...args: unknown[]) => mockCreatePost(...args),
  getUserPostReactions: (...args: unknown[]) => mockGetUserPostReactions(...args),
  getUserPostVotes: (...args: unknown[]) => mockGetUserPostVotes(...args),
}))

jest.mock('@/lib/data/posts-weighted', () => ({
  getWeightedPosts: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/lib/utils/server-cache', () => ({
  getServerCache: jest.fn().mockReturnValue(null),
  setServerCache: jest.fn(),
  deleteServerCacheByPrefix: jest.fn(),
  CacheTTL: { SHORT: 60, MEDIUM: 300 },
}))

jest.mock('@/lib/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))

jest.mock('@/lib/data/hashtags', () => ({
  extractAndSyncHashtags: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: jest.fn(),
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET, POST } from '../route'

describe('/api/posts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockGetPosts.mockResolvedValue([])
    mockGetUserPostReactions.mockResolvedValue(new Map())
    mockGetUserPostVotes.mockResolvedValue(new Map())
  })

  // --- GET: List Posts ---

  describe('GET /api/posts', () => {
    it('returns posts list with default pagination', async () => {
      const mockPosts = [
        { id: 'post-1', title: 'Test', content: 'Hello', author: { handle: 'user1' } },
      ]
      mockGetPosts.mockResolvedValue(mockPosts)

      const req = new NextRequest('http://localhost/api/posts')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.posts).toBeDefined()
    })

    it('returns posts with pagination params', async () => {
      mockGetPosts.mockResolvedValue([])

      const req = new NextRequest('http://localhost/api/posts?limit=5&offset=10')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.meta.pagination.limit).toBe(5)
      expect(body.meta.pagination.offset).toBe(10)
    })

    it('returns posts sorted by hot_score', async () => {
      mockGetPosts.mockResolvedValue([])

      const req = new NextRequest('http://localhost/api/posts?sort_by=hot_score&sort_order=desc')
      const res = await GET(req)

      expect(res.status).toBe(200)
    })

    it('attaches user reactions when user is authenticated', async () => {
      const mockPosts = [{ id: 'post-1', title: 'Test', content: 'Hello' }]
      mockGetPosts.mockResolvedValue(mockPosts)
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' })
      mockGetUserPostReactions.mockResolvedValue(new Map([['post-1', 'up']]))
      mockGetUserPostVotes.mockResolvedValue(new Map([['post-1', 'bull']]))

      const req = new NextRequest('http://localhost/api/posts')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.posts[0].user_reaction).toBe('up')
      expect(body.data.posts[0].user_vote).toBe('bull')
    })

    it('returns posts without user state when not authenticated', async () => {
      const mockPosts = [{ id: 'post-1', title: 'Test', content: 'Hello' }]
      mockGetPosts.mockResolvedValue(mockPosts)

      const req = new NextRequest('http://localhost/api/posts')
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.posts[0].user_reaction).toBeNull()
      expect(body.data.posts[0].user_vote).toBeNull()
    })

    it('handles group_id filter', async () => {
      mockGetPosts.mockResolvedValue([])

      const req = new NextRequest('http://localhost/api/posts?group_id=group-1')
      const res = await GET(req)

      expect(res.status).toBe(200)
      expect(mockGetPosts).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ group_id: 'group-1' })
      )
    })
  })

  // --- POST: Create Post ---

  describe('POST /api/posts', () => {
    it('returns 401 when not authenticated', async () => {
      mockRequireAuth.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      )

      const req = new NextRequest('http://localhost/api/posts', {
        method: 'POST',
        body: { title: 'Test', content: 'Hello world' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('returns 400 when title is missing', async () => {
      mockRequireAuth.mockResolvedValue({ id: 'user-1', email: 'test@test.com' })
      mockGetUserHandle.mockResolvedValue('testuser')

      const req = new NextRequest('http://localhost/api/posts', {
        method: 'POST',
        body: { content: 'Hello world' },
      })
      const res = await POST(req)
      const body = await res.json()

      // validateString with required:true throws ApiError which handleError converts to 400
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
    })

    it('returns 400 when content is missing', async () => {
      mockRequireAuth.mockResolvedValue({ id: 'user-1', email: 'test@test.com' })
      mockGetUserHandle.mockResolvedValue('testuser')

      const req = new NextRequest('http://localhost/api/posts', {
        method: 'POST',
        body: { title: 'Test Title' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
    })

    it('creates post successfully with valid input', async () => {
      const mockPost = { id: 'post-new', title: 'My Post', content: 'Great content' }
      mockRequireAuth.mockResolvedValue({ id: 'user-1', email: 'test@test.com' })
      mockGetUserHandle.mockResolvedValue('testuser')
      mockCreatePost.mockResolvedValue(mockPost)

      const req = new NextRequest('http://localhost/api/posts', {
        method: 'POST',
        body: { title: 'My Post', content: 'Great content' },
      })
      const res = await POST(req)
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.success).toBe(true)
      expect(body.data.post.id).toBe('post-new')
    })
  })
})
