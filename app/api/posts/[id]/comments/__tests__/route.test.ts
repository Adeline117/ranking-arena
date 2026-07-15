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
    constructor(
      url: string,
      opts?: { headers?: Record<string, string>; method?: string; body?: unknown }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Jest Test Runner', ...opts?.headers }))
      this.method = opts?.method || 'GET'
      this._body = opts?.body
    }
    async json() {
      // Handle both raw object bodies and JSON.stringify'd bodies (from linter auto-format)
      return typeof this._body === 'string' ? JSON.parse(this._body) : this._body
    }
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

// Mock middleware to pass through to existing mockRequireAuth
jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string; email?: string }
        supabase: ReturnType<typeof mockGetSupabaseAdmin>
        request: unknown
        version: { current: string }
      }) => unknown,
      _opts?: unknown
    ) =>
    async (req: unknown) => {
      try {
        const user = await mockRequireAuth(req)
        if (!user) {
          return {
            status: 401,
            _body: { success: false, error: 'Unauthorized' },
            async json() {
              return this._body
            },
            headers: new Map(),
          }
        }
        return await handler({
          user,
          supabase: mockGetSupabaseAdmin(),
          request: req,
          version: { current: 'v1' },
        })
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode || 500
        const message = err instanceof Error ? err.message : 'Internal error'
        return {
          status: statusCode,
          _body: { success: false, error: message },
          async json() {
            return this._body
          },
          headers: new Map(),
        }
      }
    },
  withPublic:
    (
      handler: (context: {
        supabase: ReturnType<typeof mockGetSupabaseAdmin>
        request: unknown
        version: { current: string }
      }) => unknown,
      _opts?: unknown
    ) =>
    async (req: unknown) =>
      handler({
        supabase: mockGetSupabaseAdmin(),
        request: req,
        version: { current: 'v1' },
      }),
  withApiMiddleware: (handler: (...args: unknown[]) => unknown) => handler,
}))

const mockRpc = jest.fn().mockResolvedValue({ data: null, error: null })
const mockGetSupabaseAdmin = jest.fn(() => ({
  from: (...args: unknown[]) => mockSupabaseFrom(...args),
  rpc: mockRpc,
  auth: {
    getUser: jest.fn().mockImplementation(() => Promise.resolve(mockSupabaseAuth)),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getAuthUser: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
}))

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  ApiError: class MockApiError extends Error {
    statusCode: number
    details?: unknown
    constructor(message: string, options: { statusCode?: number; details?: unknown } = {}) {
      super(message)
      this.statusCode = options.statusCode ?? 500
      this.details = options.details
    }
    static validation(message: string, details?: unknown) {
      return new MockApiError(message, { statusCode: 400, details })
    }
    static notFound(message: string) {
      return new MockApiError(message, { statusCode: 404 })
    }
    static forbidden(message: string) {
      return new MockApiError(message, { statusCode: 403 })
    }
    static internal(message: string) {
      return new MockApiError(message, { statusCode: 500 })
    }
  },
  ErrorCode: { OPERATION_FAILED: 'OPERATION_FAILED', INTERNAL_ERROR: 'INTERNAL_ERROR' },
  success: (data: unknown, status = 200) => ({
    status,
    _body: { success: true, data },
    async json() {
      return this._body
    },
    headers: new Map(),
  }),
  successWithPagination: (data: unknown, pagination: unknown) => ({
    status: 200,
    _body: { success: true, data, meta: { pagination } },
    async json() {
      return this._body
    },
    headers: new Map(),
  }),
  handleError: (error: unknown, _context: string) => {
    const message = error instanceof Error ? error.message : 'Internal error'
    const statusCode = (error as { statusCode?: number })?.statusCode || 500
    return {
      status: statusCode,
      _body: { success: false, error: message },
      async json() {
        return this._body
      },
      headers: new Map(),
    }
  },
  validateNumber: (val: unknown) => {
    if (val === null || val === undefined || val === '') return null
    const n = Number(val)
    return Number.isFinite(n) ? n : null
  },
  getAuthUser: jest.fn(),
  getUserHandle: jest.fn(),
  getUserProfile: jest.fn(),
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { read: {}, write: {} },
}))

const mockGetPostComments = jest.fn()
const mockCreateComment = jest.fn()
const mockUpdateOwnCommentWithRollout = jest.fn()
const mockDeleteOwnCommentWithRollout = jest.fn()

jest.mock('@/lib/data/comments', () => ({
  getPostComments: (...args: unknown[]) => mockGetPostComments(...args),
  createComment: (...args: unknown[]) => mockCreateComment(...args),
}))

jest.mock('@/lib/data/comment-mutation-rollout', () => ({
  CommentMutationRolloutError: class CommentMutationRolloutError extends Error {
    constructor(
      public readonly kind: string,
      public readonly databaseCode?: string
    ) {
      super(`Comment mutation failed: ${kind}`)
    }
  },
  updateOwnCommentWithRollout: (...args: unknown[]) => mockUpdateOwnCommentWithRollout(...args),
  deleteOwnCommentWithRollout: (...args: unknown[]) => mockDeleteOwnCommentWithRollout(...args),
}))

jest.mock('@/lib/features', () => ({
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  fireAndForget: jest.fn(),
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { CommentMutationRolloutError } from '@/lib/data/comment-mutation-rollout'
import { GET, POST, PUT, DELETE } from '../route'

const TEST_POST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const createContext = (id: string = TEST_POST_ID) => ({ params: Promise.resolve({ id }) })

describe('/api/posts/[id]/comments', () => {
  const mockUser = { id: 'user-1', email: 'test@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue(mockUser)
    mockSupabaseAuth = { data: { user: null }, error: null }
    mockGetPostComments.mockResolvedValue([])
    mockUpdateOwnCommentWithRollout.mockResolvedValue({
      id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      post_id: TEST_POST_ID,
      user_id: mockUser.id,
      content: 'Updated comment',
      deleted_at: null,
      updated_at: '2026-07-15T20:00:00.000Z',
    })
    mockDeleteOwnCommentWithRollout.mockResolvedValue({
      deleted_count: 2,
      comment_count: 7,
    })
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
      const mockComments = [{ id: 'c1', content: 'Great post!', author_id: 'user-2' }]
      mockGetPostComments.mockResolvedValue(mockComments)

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      const res = await GET(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.comments).toHaveLength(1)
    })

    it('returns paginated comments', async () => {
      mockGetPostComments.mockResolvedValue([])

      const req = new NextRequest(
        `http://localhost/api/posts/${TEST_POST_ID}/comments?limit=10&offset=5`
      )
      const res = await GET(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(200)
      // Pagination params passed through; verify response has pagination meta
      expect(body.meta?.pagination || body.data?.length !== undefined).toBeTruthy()
    })

    it('returns empty comments for a post with no comments', async () => {
      mockGetPostComments.mockResolvedValue([])

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      const res = await GET(req, createContext())
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

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'POST',
        body: { content: 'Nice post!' },
      })
      const res = await POST(req, createContext())
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
    })

    it('returns 400 when content is missing', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'POST',
        body: {},
      })
      const res = await POST(req, createContext())
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
    })

    it('creates comment successfully', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)
      const mockComment = { id: 'c-new', content: 'Nice post!', post_id: 'post-1' }
      mockCreateComment.mockResolvedValue(mockComment)

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'POST',
        body: { content: 'Nice post!' },
      })
      const res = await POST(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.success).toBe(true)
      expect(body.data.comment.id).toBe('c-new')
    })

    it('supports parent_id for nested replies', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)
      const parentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
      const mockComment = { id: 'c-reply', content: 'Reply!', parent_id: parentId }
      mockCreateComment.mockResolvedValue(mockComment)

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: 'Reply!', parent_id: parentId }),
        headers: { 'Content-Type': 'application/json' },
      })
      const res = await POST(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(201)
      expect(body.data.comment.parent_id).toBe(parentId)
    })
  })

  // --- PUT: Edit Comment ---

  describe('PUT /api/posts/[id]/comments', () => {
    it('updates through the rollout bridge with the URL-bound post', async () => {
      const commentId = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'PUT',
        body: { comment_id: commentId, content: 'Updated comment' },
      })

      const res = await PUT(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(mockUpdateOwnCommentWithRollout).toHaveBeenCalledWith(expect.anything(), {
        commentId,
        postId: TEST_POST_ID,
        userId: mockUser.id,
        content: 'Updated comment',
      })
      expect(body.data.comment).toMatchObject({ id: commentId, post_id: TEST_POST_ID })
    })

    it('rejects an invalid URL post id before invoking the bridge', async () => {
      const req = new NextRequest('http://localhost/api/posts/not-a-uuid/comments', {
        method: 'PUT',
        body: {
          comment_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
          content: 'Updated comment',
        },
      })

      const res = await PUT(req, createContext())

      expect(res.status).toBe(400)
      expect(mockUpdateOwnCommentWithRollout).not.toHaveBeenCalled()
    })

    it.each([
      ['forbidden', 403],
      ['conflict', 409],
      ['database', 500],
    ] as const)('maps a %s bridge failure to HTTP %i', async (kind, status) => {
      mockUpdateOwnCommentWithRollout.mockRejectedValue(new CommentMutationRolloutError(kind))
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'PUT',
        body: {
          comment_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
          content: 'Updated comment',
        },
      })

      const res = await PUT(req, createContext())

      expect(res.status).toBe(status)
    })
  })

  // --- DELETE: Delete Comment ---

  describe('DELETE /api/posts/[id]/comments', () => {
    it('returns error when not authenticated', async () => {
      mockRequireAuth.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      )

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'DELETE',
        body: { comment_id: 'c1' },
      })
      const res = await DELETE(req, createContext())
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
    })

    it('returns 400 when comment_id is missing', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'DELETE',
        body: {},
      })
      const res = await DELETE(req, createContext())
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
    })

    it('deletes comment successfully', async () => {
      mockRequireAuth.mockResolvedValue(mockUser)
      const commentId = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'DELETE',
        body: { comment_id: commentId },
      })
      const res = await DELETE(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(mockDeleteOwnCommentWithRollout).toHaveBeenCalledWith(expect.anything(), {
        commentId,
        postId: TEST_POST_ID,
        userId: mockUser.id,
      })
      expect(body.data).toMatchObject({ deleted_count: 2, comment_count: 7 })
    })

    it('maps a missing delete target to 404', async () => {
      mockDeleteOwnCommentWithRollout.mockRejectedValue(
        new CommentMutationRolloutError('not_found')
      )
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'DELETE',
        body: { comment_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' },
      })

      const res = await DELETE(req, createContext())

      expect(res.status).toBe(404)
    })
  })
})
