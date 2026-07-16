/**
 * /api/posts route tests
 *
 * Tests listing posts (GET) and creating posts (POST),
 * including parameter validation, auth, caching, and error handling.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
    headers: Map<string, string>
    method: string
    _body: unknown
    cookies: { get: () => undefined }
    constructor(
      url: string,
      opts?: { headers?: Record<string, string>; method?: string; body?: unknown }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(
        Object.entries({ 'user-agent': 'Mozilla/5.0 (Jest Test Runner)', ...(opts?.headers || {}) })
      )
      this.method = opts?.method || 'GET'
      this._body = opts?.body
      this.cookies = { get: () => undefined }
    }
    async json() {
      return this._body
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
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
  chain.then = jest.fn((cb: (v: unknown) => unknown) =>
    Promise.resolve(cb({ data: null, error: null }))
  )
  chain.catch = jest.fn().mockReturnValue(chain)
  return chain
}
const mockQueryResult = (data: unknown, error: unknown = null) => {
  const chain = mockChain()
  chain.then = jest.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve(resolve({ data, error }))
  )
  return chain
}
const mockSupabase = {
  from: jest.fn().mockReturnValue(mockChain()),
  rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
}
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
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', isDeprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
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
      expect(res.headers.get('Cache-Control')).toBe(
        'public, s-maxage=30, stale-while-revalidate=120'
      )
      expect(res.headers.get('Vary')).toContain('Authorization')
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

      const req = new NextRequest('http://localhost/api/posts', {
        headers: { authorization: 'Bearer test-token' },
      })
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.posts[0].user_reaction).toBe('up')
      expect(body.data.posts[0].user_vote).toBe('bull')
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
      expect(res.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
      expect(res.headers.get('Vary')).toContain('Authorization')
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

    it('rejects an anonymous following feed without falling back to hot posts', async () => {
      const req = new NextRequest('http://localhost/api/posts?sort_by=following')
      const res = await GET(req)

      expect(res.status).toBe(401)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(res.headers.get('Vary')).toContain('Authorization')
      expect(mockGetPosts).not.toHaveBeenCalled()
      expect(mockSupabase.from).not.toHaveBeenCalledWith('user_follows')
    })

    it('rejects an invalid bearer token for the following feed', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer invalid-token' },
      })
      const res = await GET(req)

      expect(res.status).toBe(401)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockGetPosts).not.toHaveBeenCalled()
    })

    it('returns an authoritative empty feed when the viewer follows nobody', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      mockSupabase.from.mockReturnValueOnce(mockQueryResult([]))

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data).toEqual({ posts: [], following_count: 0 })
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockGetPosts).not.toHaveBeenCalled()
    })

    it('keeps an empty canonical result empty instead of substituting hot posts', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      mockSupabase.from.mockReturnValueOnce(mockQueryResult([{ following_id: 'followed-1' }]))
      mockGetPosts.mockResolvedValue([])

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data).toEqual({ posts: [], following_count: 1 })
      expect(mockGetPosts).toHaveBeenCalledTimes(1)
      expect(mockGetPosts).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          author_ids: ['followed-1'],
          viewer_id: 'viewer-1',
          sort_by: 'created_at',
        })
      )
    })

    it('derives the viewer from the token and ignores a requested user id', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'verified-viewer' })
      const followQuery = mockQueryResult([])
      mockSupabase.from.mockReturnValueOnce(followQuery)

      const req = new NextRequest(
        'http://localhost/api/posts?sort_by=following&p_user_id=impersonated-user',
        { headers: { authorization: 'Bearer viewer-token' } }
      )
      await GET(req)

      expect(followQuery.eq).toHaveBeenCalledWith('follower_id', 'verified-viewer')
    })

    it('fails closed when the following relationship query fails', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      mockSupabase.from.mockReturnValueOnce(
        mockQueryResult(null, { code: 'DB_DOWN', message: 'unavailable' })
      )

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)

      expect(res.status).toBe(500)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockGetPosts).not.toHaveBeenCalled()
    })

    it('has no deployment-wide shared cache override for the posts route', () => {
      const vercelConfig = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')) as {
        headers?: Array<{ source?: string }>
      }

      expect(vercelConfig.headers?.find((entry) => entry.source === '/api/posts')).toBeUndefined()
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
      mockGetAuthUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' })
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
      mockGetAuthUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' })
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
      mockGetAuthUser.mockResolvedValue({ id: 'user-1', email: 'test@test.com' })
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
