/**
 * /api/posts/[id]/comments route tests
 *
 * Tests listing comments (GET), creating comments (POST),
 * and deleting comments (DELETE) with auth and validation.
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
  RateLimitPresets: { read: {}, write: {} },
}))

const mockRequireAuth = jest.fn()
let mockSupabaseAuth = { data: { user: null as { id: string } | null }, error: null }
const mockSupabaseFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    auth: {
      getUser: jest.fn().mockImplementation(() => Promise.resolve(mockSupabaseAuth)),
    },
  })),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthUser: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

const mockGetPostComments = jest.fn()
const mockCreateComment = jest.fn()
const mockDeleteComment = jest.fn()

jest.mock('@/lib/data/comments', () => ({
  getPostComments: (...args: unknown[]) => mockGetPostComments(...args),
  createComment: (...args: unknown[]) => mockCreateComment(...args),
  deleteComment: (...args: unknown[]) => mockDeleteComment(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  fireAndForget: jest.fn(),
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { GET, POST, DELETE } from '../route'

const createContext = (id: string) => ({ params: Promise.resolve({ id }) })

describe('/api/posts/[id]/comments', () => {
  const mockUser = { id: 'user-1', email: 'test@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue(mockUser)
    mockSupabaseAuth = { data: { user: null }, error: null }
    mockGetPostComments.mockResolvedValue([])
    mockSupabaseFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    })
  })

  // --- GET: List Comments ---

  describe('GET /api/posts/[id]/comments', () => {
    it('returns comments for a post with default pagination', async () => {
      const mockComments = [
        { id: 'c1', content: 'Great post!', author_id: 'user-2' },
      ]
      mockGetPostComments.mockResolvedValue(mockComments)

      const req = new NextRequest('http://localhost/api/posts/post-1/comments')
      const res = await GET(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.comments).toHaveLength(1)
    })

    it('returns paginated comments', async () => {
      mockGetPostComments.mockResolvedValue([])

      const req = new NextRequest('http://localhost/api/posts/post-1/comments?limit=10&offset=5')
      const res = await GET(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.meta.pagination.limit).toBe(10)
      expect(body.meta.pagination.offset).toBe(5)
    })

    it('returns empty comments for a post with no comments', async () => {
      mockGetPostComments.mockResolvedValue([])

      const req = new NextRequest('http://localhost/api/posts/post-1/comments')
      const res = await GET(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data.comments).toEqual([])
      expect(body.meta.pagination.has_more).toBe(false)
    })
  })

  // --- POST: Create Comment ---

  describe('POST /api/posts/[id]/comments', () => {
    it('returns error when not authenticated', async () => {
      mockRequireAuth.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      )

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'POST',
        body: { content: 'Nice post!' },
      })
      const res = await POST(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('returns 400 when content is missing', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'POST',
        body: {},
      })
      const res = await POST(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('creates comment successfully', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)
      const mockComment = { id: 'c-new', content: 'Nice post!', post_id: 'post-1' }
      mockCreateComment.mockResolvedValue(mockComment)

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'POST',
        body: { content: 'Nice post!' },
      })
      const res = await POST(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.success).toBe(true)
      expect(body.data.comment.id).toBe('c-new')
    })

    it('supports parent_id for nested replies', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)
      const mockComment = { id: 'c-reply', content: 'Reply!', parent_id: 'c1' }
      mockCreateComment.mockResolvedValue(mockComment)

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'POST',
        body: { content: 'Reply!', parent_id: 'c1' },
      })
      const res = await POST(req, createContext('post-1'))
      const body = await res.json()

      // Debug
      if (res.status !== 201) console.log('parent_id test body:', JSON.stringify(body), 'status:', res.status)

      expect(res.status).toBe(201)
      expect(body.data.comment.parent_id).toBe('c1')
    })
  })

  // --- DELETE: Delete Comment ---

  describe('DELETE /api/posts/[id]/comments', () => {
    it('returns error when not authenticated', async () => {
      mockRequireAuth.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      )

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'DELETE',
        body: { comment_id: 'c1' },
      })
      const res = await DELETE(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('returns 400 when comment_id is missing', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'DELETE',
        body: {},
      })
      const res = await DELETE(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).toBe(false)
    })

    it('deletes comment successfully', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)
      mockDeleteComment.mockResolvedValue(undefined)

      const req = new NextRequest('http://localhost/api/posts/post-1/comments', {
        method: 'DELETE',
        body: { comment_id: 'c1' },
      })
      const res = await DELETE(req, createContext('post-1'))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
    })
  })
})
