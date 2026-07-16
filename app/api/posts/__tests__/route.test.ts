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
const mockCacheGet = jest.fn().mockResolvedValue(null)
const mockCacheSet = jest.fn().mockResolvedValue(undefined)
const mockCacheDel = jest.fn().mockResolvedValue(undefined)

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
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: (...args: unknown[]) => mockCacheSet(...args),
  del: (...args: unknown[]) => mockCacheDel(...args),
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
      mockSupabase.rpc.mockResolvedValueOnce({
        data: { posts: [], following_count: 0, has_more: false, next_cursor: null },
        error: null,
      })

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data).toEqual({
        posts: [],
        following_count: 0,
        viewer_id: 'viewer-1',
        next_cursor: null,
      })
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockGetPosts).not.toHaveBeenCalled()
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('binds filters and a keyset cursor to one atomic RPC page', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      const postId = '11111111-1111-4111-8111-111111111111'
      const rootId = '22222222-2222-4222-8222-222222222222'
      const groupId = '33333333-3333-4333-8333-333333333333'
      const cursorId = '44444444-4444-4444-8444-444444444444'
      const cursorCreatedAt = '2026-07-15T20:00:00.000Z'
      const nextCursor = {
        created_at: '2026-07-15T19:00:00.000Z',
        id: postId,
      }
      mockSupabase.rpc.mockResolvedValueOnce({
        data: {
          posts: [
            {
              id: postId,
              created_at: nextCursor.created_at,
              original_post_id: rootId,
              title: 'Canonical wrapper',
              content: 'Wrapper body',
              author_id: '55555555-5555-4555-8555-555555555555',
              author_handle: 'alice',
              author_avatar_url: null,
              author_is_pro: false,
              author_show_pro_badge: true,
              group_id: groupId,
              group_name: 'Group',
              group_name_en: null,
              poll_enabled: false,
              poll_id: null,
              poll_bull: 0,
              poll_bear: 0,
              poll_wait: 0,
              like_count: 1,
              dislike_count: 0,
              comment_count: 2,
              bookmark_count: 0,
              repost_count: 0,
              view_count: 3,
              hot_score: 1.5,
              is_pinned: false,
              images: null,
              updated_at: '2026-07-15T19:00:00.000Z',
              original_post: {
                id: rootId,
                title: 'Authorized root',
                content: 'Root body',
                author_handle: 'bob',
                author_avatar_url: null,
                author_is_pro: false,
                author_show_pro_badge: true,
                images: null,
                created_at: '2026-07-15T18:00:00.000Z',
              },
              visibility: 'public',
              is_sensitive: false,
              content_warning: null,
              language: 'en',
            },
          ],
          following_count: 7,
          has_more: true,
          next_cursor: nextCursor,
        },
        error: null,
      })
      mockGetUserPostReactions.mockResolvedValue(new Map([[postId, 'up']]))

      const req = new NextRequest(
        'http://localhost/api/posts?sort_by=following&limit=1&group_id=' +
          groupId +
          '&author_handle=alice&language=en&before_created_at=' +
          encodeURIComponent(cursorCreatedAt) +
          '&before_id=' +
          cursorId,
        { headers: { authorization: 'Bearer viewer-token' } }
      )
      const res = await GET(req)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(mockSupabase.rpc).toHaveBeenCalledWith('get_following_posts_page', {
        p_viewer_id: 'viewer-1',
        p_limit: 1,
        p_before_created_at: cursorCreatedAt,
        p_before_id: cursorId,
        p_group_id: groupId,
        p_group_ids: null,
        p_author_handle: 'alice',
        p_language: 'en',
      })
      expect(body.data.posts).toEqual([
        expect.objectContaining({
          id: postId,
          original_post_id: rootId,
          user_reaction: 'up',
        }),
      ])
      expect(body.data.following_count).toBe(7)
      expect(body.data.next_cursor).toEqual(nextCursor)
      expect(body.meta.pagination).toEqual(
        expect.objectContaining({ limit: 1, offset: 0, has_more: true })
      )
      expect(mockGetPosts).not.toHaveBeenCalled()
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('derives the viewer from the token and ignores a requested user id', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'verified-viewer' })
      mockSupabase.rpc.mockResolvedValueOnce({
        data: { posts: [], following_count: 0, has_more: false, next_cursor: null },
        error: null,
      })

      const req = new NextRequest(
        'http://localhost/api/posts?sort_by=following&p_user_id=impersonated-user',
        { headers: { authorization: 'Bearer viewer-token' } }
      )
      await GET(req)

      expect(mockSupabase.rpc).toHaveBeenCalledWith(
        'get_following_posts_page',
        expect.objectContaining({ p_viewer_id: 'verified-viewer' })
      )
    })

    it('fails closed when the atomic following page RPC fails', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      mockSupabase.rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'DB_DOWN', message: 'unavailable' },
      })

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)

      expect(res.status).toBe(500)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockGetPosts).not.toHaveBeenCalled()
    })

    it.each([
      null,
      [],
      { posts: [], following_count: 0, has_more: false },
      { posts: [], following_count: -1, has_more: false, next_cursor: null },
      {
        posts: [{ id: 'not-a-uuid', created_at: 'bad', original_post_id: null }],
        following_count: 1,
        has_more: false,
        next_cursor: null,
      },
      {
        posts: [],
        following_count: 1,
        has_more: true,
        next_cursor: { created_at: 'bad', id: 'not-a-uuid' },
      },
    ])('fails closed on malformed following RPC data %#', async (data) => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      mockSupabase.rpc.mockResolvedValueOnce({ data, error: null })

      const req = new NextRequest('http://localhost/api/posts?sort_by=following', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)

      expect(res.status).toBe(500)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockGetPosts).not.toHaveBeenCalled()
    })

    it.each([
      'offset=1',
      'before_created_at=2026-07-15T20%3A00%3A00.000Z',
      'before_id=44444444-4444-4444-8444-444444444444',
      'group_id=not-a-uuid',
    ])('rejects invalid following page input %s before the RPC', async (query) => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })

      const req = new NextRequest('http://localhost/api/posts?sort_by=following&' + query, {
        headers: { authorization: 'Bearer viewer-token' },
      })
      const res = await GET(req)

      expect(res.status).toBe(400)
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })

    it('never reads or populates the global hot cache for an authenticated viewer', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'viewer-1' })
      mockGetPosts.mockResolvedValue([{ id: 'viewer-post' }])

      const req = new NextRequest('http://localhost/api/posts?sort_by=hot_score', {
        headers: { authorization: 'Bearer viewer-token' },
      })
      await GET(req)

      expect(mockCacheGet).not.toHaveBeenCalled()
      expect(mockCacheSet).not.toHaveBeenCalled()
      expect(mockGetPosts).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ viewer_id: 'viewer-1', limit: 20 })
      )
    })

    it('does not use the retired global hot cache even for anonymous requests', async () => {
      mockGetPosts.mockResolvedValue([{ id: 'public-post' }])

      const req = new NextRequest('http://localhost/api/posts?sort_by=hot_score')
      await GET(req)

      expect(mockCacheGet).not.toHaveBeenCalled()
      expect(mockCacheSet).not.toHaveBeenCalled()
      expect(mockGetPosts).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ viewer_id: undefined, limit: 20 })
      )
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
