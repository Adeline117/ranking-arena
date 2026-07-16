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
type MockQueryResult = { data?: unknown; error?: { code?: string } | null }
const mockTableQueues = new Map<string, MockQueryResult[]>()

function queueTable(table: string, ...results: MockQueryResult[]) {
  mockTableQueues.set(table, results)
}

function queryBuilder(result: MockQueryResult = {}) {
  const resolved = {
    data: Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null,
    error: result.error ?? null,
  }
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'is', 'or', 'limit']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.single = jest.fn().mockResolvedValue(resolved)
  builder.maybeSingle = jest.fn().mockResolvedValue(resolved)
  return builder
}

type MockQueryBuilder = ReturnType<typeof queryBuilder>
const mockIssuedTableQueries = new Map<string, MockQueryBuilder[]>()

function recordTableQuery(table: string, builder: MockQueryBuilder) {
  const issued = mockIssuedTableQueries.get(table) ?? []
  issued.push(builder)
  mockIssuedTableQueries.set(table, issued)
  return builder
}

function issuedTableQueries(table: string): MockQueryBuilder[] {
  return mockIssuedTableQueries.get(table) ?? []
}

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
        user: { id: string } | null
        supabase: ReturnType<typeof mockGetSupabaseAdmin>
        request: unknown
        version: { current: string }
      }) => unknown,
      _opts?: unknown
    ) =>
    async (req: unknown) =>
      handler({
        user: mockSupabaseAuth.data.user,
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
const mockCanServiceActorReadPost = jest.fn()

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

jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...args: unknown[]) => mockCanServiceActorReadPost(...args),
}))

jest.mock('@/lib/features', () => ({
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: jest.fn(),
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
const OTHER_POST_ID = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f'
const PARENT_COMMENT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const NESTED_PARENT_ID = 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a'
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111'
const POST_AUTHOR_ID = '22222222-2222-4222-8222-222222222222'
const PARENT_AUTHOR_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'
const createContext = (id: string = TEST_POST_ID) => ({ params: Promise.resolve({ id }) })

function readablePost(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_POST_ID,
    author_id: POST_AUTHOR_ID,
    group_id: null,
    title: 'Post title',
    visibility: 'public',
    status: 'active',
    comment_count: 4,
    ...overrides,
  }
}

describe('/api/posts/[id]/comments', () => {
  const mockUser = { id: TEST_USER_ID, email: 'test@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockTableQueues.clear()
    mockIssuedTableQueries.clear()
    mockRequireAuth.mockResolvedValue(mockUser)
    mockCanServiceActorReadPost.mockResolvedValue(true)
    mockSupabaseAuth = { data: { user: null }, error: null }
    mockGetPostComments.mockResolvedValue([])
    mockCreateComment.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      content: 'Nice post!',
      post_id: TEST_POST_ID,
    })
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
    mockSupabaseFrom.mockImplementation((table: string) => {
      const queued = mockTableQueues.get(table)
      let result = queued?.length ? queued.shift() : undefined

      if (!result && table === 'posts') {
        result = { data: readablePost() }
      }
      if (!result && table === 'comments') {
        result = {
          data: {
            id: PARENT_COMMENT_ID,
            post_id: TEST_POST_ID,
            parent_id: null,
            user_id: PARENT_AUTHOR_ID,
          },
        }
      }
      return recordTableQuery(table, queryBuilder(result))
    })
  })

  // --- GET: List Comments ---

  describe('GET /api/posts/[id]/comments', () => {
    it('returns authoritative absence for an invalid post id', async () => {
      const req = new NextRequest('http://localhost/api/posts/not-a-uuid/comments')

      await expect(GET(req, createContext('not-a-uuid'))).rejects.toMatchObject({
        statusCode: 404,
      })
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockGetPostComments).not.toHaveBeenCalled()
    })

    it('returns 401 for an invalid bearer token instead of degrading to anonymous access', async () => {
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        headers: { authorization: 'Bearer expired-token' },
      })

      const res = await GET(req, createContext())

      expect(res.status).toBe(401)
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockGetPostComments).not.toHaveBeenCalled()
    })

    it('returns comments for a post with default pagination', async () => {
      const mockComments = [{ id: 'c1', content: 'Great post!', author_id: 'user-2' }]
      mockGetPostComments.mockResolvedValue(mockComments)

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      const res = await GET(req, createContext())
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.success).toBe(true)
      expect(body.data.comments).toHaveLength(1)
      expect(body.data.post).toEqual({ comment_count: 4 })
      expect(mockGetPostComments).toHaveBeenCalledWith(
        expect.anything(),
        TEST_POST_ID,
        expect.objectContaining({ limit: 51, offset: 0, sort: 'best', userId: undefined })
      )
      expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(
        expect.anything(),
        TEST_POST_ID,
        null
      )
    })

    it('fails closed before reading comment children when canonical audience denies', async () => {
      mockCanServiceActorReadPost.mockResolvedValue(false)
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)

      await expect(GET(req, createContext())).rejects.toMatchObject({ statusCode: 404 })

      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockGetPostComments).not.toHaveBeenCalled()
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

    it('uses a look-ahead row so has_more is exact', async () => {
      mockGetPostComments.mockResolvedValue(
        Array.from({ length: 11 }, (_, index) => ({ id: `comment-${index}` }))
      )

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments?limit=10`)
      const res = await GET(req, createContext())
      const body = await res.json()

      expect(body.data.comments).toHaveLength(10)
      expect(body.meta.pagination.has_more).toBe(true)
      expect(mockGetPostComments).toHaveBeenCalledWith(
        expect.anything(),
        TEST_POST_ID,
        expect.objectContaining({ limit: 11 })
      )
    })

    it.each([
      ['missing', null],
      ['deleted', readablePost({ status: 'deleted' })],
      ['follower-only', readablePost({ visibility: 'followers' })],
      ['group-only', readablePost({ visibility: 'group', group_id: GROUP_ID })],
    ])('returns authoritative absence for an anonymous %s post', async (_label, post) => {
      queueTable('posts', { data: post })

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      await expect(GET(req, createContext())).rejects.toMatchObject({ statusCode: 404 })
      expect(mockGetPostComments).not.toHaveBeenCalled()
    })

    it('allows a current follower and passes the authenticated viewer to the data layer', async () => {
      mockSupabaseAuth = { data: { user: mockUser }, error: null }
      queueTable('posts', { data: readablePost({ visibility: 'followers' }) })
      queueTable('blocked_users', { data: null })
      queueTable('user_follows', { data: { following_id: POST_AUTHOR_ID } })
      mockGetPostComments.mockResolvedValue([{ id: 'follower-comment' }])

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      const res = await GET(req, createContext())
      const body = await res.json()

      expect(body.data.comments).toEqual([{ id: 'follower-comment' }])
      expect(mockGetPostComments).toHaveBeenCalledWith(
        expect.anything(),
        TEST_POST_ID,
        expect.objectContaining({ userId: mockUser.id })
      )
    })

    it('allows a current group member to read group-only comments', async () => {
      mockSupabaseAuth = { data: { user: mockUser }, error: null }
      queueTable('posts', { data: readablePost({ visibility: 'group', group_id: GROUP_ID }) })
      queueTable('blocked_users', { data: null })
      queueTable('group_members', { data: { user_id: mockUser.id } })
      mockGetPostComments.mockResolvedValue([{ id: 'group-comment' }])

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      const res = await GET(req, createContext())
      const body = await res.json()

      expect(body.data.comments).toEqual([{ id: 'group-comment' }])
    })

    it.each([
      { blocker_id: mockUser.id, blocked_id: POST_AUTHOR_ID },
      { blocker_id: POST_AUTHOR_ID, blocked_id: mockUser.id },
    ])('returns authoritative absence for a block in either direction: %o', async (block) => {
      mockSupabaseAuth = { data: { user: mockUser }, error: null }
      queueTable('posts', { data: readablePost() })
      queueTable('blocked_users', { data: block })

      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)
      await expect(GET(req, createContext())).rejects.toMatchObject({ statusCode: 404 })
      expect(mockGetPostComments).not.toHaveBeenCalled()
    })

    it('fails closed when a readable post has an invalid canonical count', async () => {
      queueTable('posts', { data: readablePost({ comment_count: -1 }) })
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`)

      await expect(GET(req, createContext())).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  // --- POST: Create Comment ---

  describe('POST /api/posts/[id]/comments', () => {
    const activePost = (overrides: Record<string, unknown> = {}) => ({
      id: TEST_POST_ID,
      author_id: POST_AUTHOR_ID,
      group_id: null,
      title: 'Post title',
      visibility: 'public',
      status: 'active',
      ...overrides,
    })

    const parentComment = (overrides: Record<string, unknown> = {}) => ({
      id: PARENT_COMMENT_ID,
      post_id: TEST_POST_ID,
      parent_id: null,
      user_id: PARENT_AUTHOR_ID,
      ...overrides,
    })

    const request = (body: unknown, postId = TEST_POST_ID) =>
      new NextRequest(`http://localhost/api/posts/${postId}/comments`, {
        method: 'POST',
        body,
      })

    function queueGroupPostAudience(options: {
      group?: MockQueryResult
      membership?: MockQueryResult
      ban?: MockQueryResult
    }) {
      queueTable('posts', {
        data: activePost({ group_id: GROUP_ID, visibility: 'public' }),
      })
      queueTable('blocked_users', { data: null })
      queueTable('groups', options.group ?? { data: { id: GROUP_ID, dissolved_at: null } })
      queueTable(
        'group_members',
        options.membership ?? { data: { user_id: mockUser.id, muted_until: null } }
      )
      queueTable('group_bans', options.ban ?? { data: null })
    }

    it('returns error when not authenticated', async () => {
      mockRequireAuth.mockRejectedValue(
        Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      )

      const res = await POST(request({ content: 'Nice post!' }), createContext())
      const body = await res.json()

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(body.success).not.toBe(true)
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it('rejects an invalid URL post UUID before parsing or querying', async () => {
      const res = await POST(request({ content: 'Nice post!' }, 'not-a-uuid'), createContext())

      expect(res.status).toBe(400)
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it.each([
      ['missing content', {}],
      ['an unexpected body field', { content: 'Nice post!', admin: true }],
      ['an invalid parent UUID', { content: 'Nice post!', parent_id: 'not-a-uuid' }],
      ['a non-object body', ['Nice post!']],
      ['oversized raw content', { content: 'x'.repeat(2001) }],
      ['content emptied by sanitization', { content: '<script>alert(1)</script>' }],
    ])('rejects %s without querying or inserting', async (_label, body) => {
      const res = await POST(request(body), createContext())

      expect(res.status).toBe(400)
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it('rejects malformed JSON without querying or inserting', async () => {
      const res = await POST(request('{'), createContext())

      expect(res.status).toBe(400)
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it('sanitizes content and binds a public root comment to the active URL post', async () => {
      queueTable('posts', { data: activePost() })
      queueTable('blocked_users', { data: null })

      const res = await POST(request({ content: '  <b>Nice post!</b>  ' }), createContext())

      expect(res.status).toBe(201)
      expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(
        expect.anything(),
        TEST_POST_ID,
        mockUser.id
      )
      expect(mockCreateComment).toHaveBeenCalledWith(expect.anything(), mockUser.id, {
        post_id: TEST_POST_ID,
        content: 'Nice post!',
        parent_id: undefined,
      })

      const [postQuery] = issuedTableQueries('posts')
      expect(postQuery.select).toHaveBeenCalledWith(
        'id, group_id, author_id, title, visibility, status'
      )
      expect(postQuery.eq).toHaveBeenCalledWith('id', TEST_POST_ID)
      expect(postQuery.is).toHaveBeenCalledWith('deleted_at', null)
      expect(postQuery.maybeSingle).toHaveBeenCalledTimes(1)

      const [blockQuery] = issuedTableQueries('blocked_users')
      const blockFilter = blockQuery.or.mock.calls[0]?.[0] as string
      expect(blockFilter).toContain(
        `and(blocker_id.eq.${mockUser.id},blocked_id.eq.${POST_AUTHOR_ID})`
      )
      expect(blockFilter).toContain(
        `and(blocker_id.eq.${POST_AUTHOR_ID},blocked_id.eq.${mockUser.id})`
      )
      expect(blockQuery.limit).toHaveBeenCalledWith(1)
      expect(blockQuery.maybeSingle).toHaveBeenCalledTimes(1)
    })

    it('binds an active top-level parent and checks both parent block directions', async () => {
      queueTable('posts', { data: activePost() })
      queueTable('comments', { data: parentComment() })
      queueTable('blocked_users', { data: null }, { data: null })

      const res = await POST(
        request({ content: 'Reply!', parent_id: PARENT_COMMENT_ID }),
        createContext()
      )

      expect(res.status).toBe(201)
      expect(mockCreateComment).toHaveBeenCalledWith(expect.anything(), mockUser.id, {
        post_id: TEST_POST_ID,
        content: 'Reply!',
        parent_id: PARENT_COMMENT_ID,
      })

      const [parentQuery] = issuedTableQueries('comments')
      expect(parentQuery.select).toHaveBeenCalledWith('id, post_id, parent_id, user_id')
      expect(parentQuery.eq).toHaveBeenCalledWith('id', PARENT_COMMENT_ID)
      expect(parentQuery.is).toHaveBeenCalledWith('deleted_at', null)
      expect(parentQuery.maybeSingle).toHaveBeenCalledTimes(1)

      const targetBlockQuery = issuedTableQueries('blocked_users')[1]
      const targetBlockFilter = targetBlockQuery.or.mock.calls[0]?.[0] as string
      expect(targetBlockFilter).toContain(
        `and(blocker_id.eq.${mockUser.id},blocked_id.eq.${PARENT_AUTHOR_ID})`
      )
      expect(targetBlockFilter).toContain(
        `and(blocker_id.eq.${PARENT_AUTHOR_ID},blocked_id.eq.${mockUser.id})`
      )
      expect(targetBlockQuery.limit).toHaveBeenCalledWith(1)
    })

    it('rejects a reply when either direction blocks the parent author', async () => {
      queueTable('posts', { data: activePost() })
      queueTable('comments', { data: parentComment() })
      queueTable('blocked_users', { data: null }, { data: { blocker_id: PARENT_AUTHOR_ID } })

      const res = await POST(
        request({ content: 'Blocked reply', parent_id: PARENT_COMMENT_ID }),
        createContext()
      )

      expect(res.status).toBe(403)
      expect(mockCreateComment).not.toHaveBeenCalled()

      const targetBlockQuery = issuedTableQueries('blocked_users')[1]
      const targetBlockFilter = targetBlockQuery.or.mock.calls[0]?.[0] as string
      expect(targetBlockFilter).toContain(
        `and(blocker_id.eq.${mockUser.id},blocked_id.eq.${PARENT_AUTHOR_ID})`
      )
      expect(targetBlockFilter).toContain(
        `and(blocker_id.eq.${PARENT_AUTHOR_ID},blocked_id.eq.${mockUser.id})`
      )
    })

    it.each([
      ['missing', { data: null }, 404],
      ['deleted', { data: null }, 404],
      ['locked', { data: activePost({ status: 'locked' }) }, 409],
      ['deleted-status', { data: activePost({ status: 'deleted' }) }, 409],
    ])('rejects a %s post before insertion', async (_label, postResult, status) => {
      queueTable('posts', postResult)

      const res = await POST(request({ content: 'No write' }), createContext())

      expect(res.status).toBe(status)
      expect(mockCreateComment).not.toHaveBeenCalled()

      const [postQuery] = issuedTableQueries('posts')
      expect(postQuery.eq).toHaveBeenCalledWith('id', TEST_POST_ID)
      expect(postQuery.is).toHaveBeenCalledWith('deleted_at', null)
    })

    it.each([
      ['missing', { data: null }, 404],
      ['cross-post', { data: parentComment({ post_id: OTHER_POST_ID }) }, 404],
      ['nested', { data: parentComment({ parent_id: NESTED_PARENT_ID }) }, 400],
    ])('rejects a %s reply target before insertion', async (_label, parentResult, status) => {
      queueTable('posts', { data: activePost() })
      queueTable('comments', parentResult)

      const res = await POST(
        request({ content: 'Invalid reply', parent_id: PARENT_COMMENT_ID }),
        createContext()
      )

      expect(res.status).toBe(status)
      expect(mockCreateComment).not.toHaveBeenCalled()

      const [parentQuery] = issuedTableQueries('comments')
      expect(parentQuery.eq).toHaveBeenCalledWith('id', PARENT_COMMENT_ID)
      expect(parentQuery.is).toHaveBeenCalledWith('deleted_at', null)
    })

    it.each([
      'post',
      'parent',
      'post-block',
      'parent-block',
      'group',
      'membership',
      'ban',
      'follow',
    ])('fails closed when the %s permission query fails', async (stage) => {
      let body: Record<string, unknown> = { content: 'Fail closed' }

      if (stage === 'post') {
        queueTable('posts', { error: { code: 'XX001' } })
      } else if (stage === 'parent') {
        queueTable('posts', { data: activePost() })
        queueTable('comments', { error: { code: 'XX002' } })
        body = { ...body, parent_id: PARENT_COMMENT_ID }
      } else if (stage === 'post-block') {
        queueTable('posts', { data: activePost() })
        queueTable('blocked_users', { error: { code: 'XX003' } })
      } else if (stage === 'parent-block') {
        queueTable('posts', { data: activePost() })
        queueTable('comments', { data: parentComment() })
        queueTable('blocked_users', { data: null }, { error: { code: 'XX004' } })
        body = { ...body, parent_id: PARENT_COMMENT_ID }
      } else if (stage === 'follow') {
        queueTable('posts', { data: activePost({ visibility: 'followers' }) })
        queueTable('blocked_users', { data: null })
        queueTable('user_follows', { error: { code: 'XX008' } })
      } else {
        queueGroupPostAudience({
          ...(stage === 'group' ? { group: { error: { code: 'XX005' } } } : {}),
          ...(stage === 'membership' ? { membership: { error: { code: 'XX006' } } } : {}),
          ...(stage === 'ban' ? { ban: { error: { code: 'XX007' } } } : {}),
        })
      }

      const res = await POST(request(body), createContext())

      expect(res.status).toBe(500)
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it.each([
      ['missing group', { group: { data: null } }],
      [
        'dissolved group',
        { group: { data: { id: GROUP_ID, dissolved_at: '2026-07-15T00:00:00.000Z' } } },
      ],
      ['banned member', { ban: { data: { user_id: mockUser.id } } }],
      ['missing membership', { membership: { data: null } }],
      [
        'muted member',
        {
          membership: {
            data: { user_id: mockUser.id, muted_until: '2999-07-15T00:00:00.000Z' },
          },
        },
      ],
    ])('rejects a %s on every group-linked post', async (_label, options) => {
      queueGroupPostAudience(options)

      const res = await POST(request({ content: 'No group write' }), createContext())

      expect(res.status).toBe(403)
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it('allows an active, unbanned, unmuted member and binds every group query', async () => {
      queueGroupPostAudience({
        membership: {
          data: { user_id: mockUser.id, muted_until: '2000-07-15T00:00:00.000Z' },
        },
      })

      const res = await POST(request({ content: 'Group comment' }), createContext())

      expect(res.status).toBe(201)
      const [groupQuery] = issuedTableQueries('groups')
      expect(groupQuery.select).toHaveBeenCalledWith('id, dissolved_at')
      expect(groupQuery.eq).toHaveBeenCalledWith('id', GROUP_ID)
      expect(groupQuery.maybeSingle).toHaveBeenCalledTimes(1)

      const [membershipQuery] = issuedTableQueries('group_members')
      expect(membershipQuery.select).toHaveBeenCalledWith('user_id, muted_until')
      expect(membershipQuery.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
      expect(membershipQuery.eq).toHaveBeenCalledWith('user_id', mockUser.id)
      expect(membershipQuery.maybeSingle).toHaveBeenCalledTimes(1)

      const [banQuery] = issuedTableQueries('group_bans')
      expect(banQuery.select).toHaveBeenCalledWith('user_id')
      expect(banQuery.eq).toHaveBeenCalledWith('group_id', GROUP_ID)
      expect(banQuery.eq).toHaveBeenCalledWith('user_id', mockUser.id)
      expect(banQuery.maybeSingle).toHaveBeenCalledTimes(1)
    })

    it('rejects a bidirectional post-author block before insertion', async () => {
      queueTable('posts', { data: activePost() })
      queueTable('blocked_users', { data: { blocker_id: POST_AUTHOR_ID } })

      const res = await POST(request({ content: 'Blocked' }), createContext())

      expect(res.status).toBe(403)
      expect(mockCreateComment).not.toHaveBeenCalled()
      const [blockQuery] = issuedTableQueries('blocked_users')
      const blockFilter = blockQuery.or.mock.calls[0]?.[0] as string
      expect(blockFilter).toContain(
        `and(blocker_id.eq.${mockUser.id},blocked_id.eq.${POST_AUTHOR_ID})`
      )
      expect(blockFilter).toContain(
        `and(blocker_id.eq.${POST_AUTHOR_ID},blocked_id.eq.${mockUser.id})`
      )
    })

    it('rejects a non-follower and binds the follower edge query', async () => {
      queueTable('posts', { data: activePost({ visibility: 'followers' }) })
      queueTable('blocked_users', { data: null })
      queueTable('user_follows', { data: null })

      const res = await POST(request({ content: 'Not following' }), createContext())

      expect(res.status).toBe(403)
      expect(mockCreateComment).not.toHaveBeenCalled()

      const [followQuery] = issuedTableQueries('user_follows')
      expect(followQuery.select).toHaveBeenCalledWith('following_id')
      expect(followQuery.eq).toHaveBeenCalledWith('follower_id', mockUser.id)
      expect(followQuery.eq).toHaveBeenCalledWith('following_id', POST_AUTHOR_ID)
      expect(followQuery.maybeSingle).toHaveBeenCalledTimes(1)
    })

    it('allows a current follower through the same bound edge', async () => {
      queueTable('posts', { data: activePost({ visibility: 'followers' }) })
      queueTable('blocked_users', { data: null })
      queueTable('user_follows', { data: { following_id: POST_AUTHOR_ID } })

      const res = await POST(request({ content: 'Follower comment' }), createContext())

      expect(res.status).toBe(201)
      expect(mockCreateComment).toHaveBeenCalledTimes(1)
    })

    it('rejects a group visibility value without a group resource', async () => {
      queueTable('posts', { data: activePost({ visibility: 'group', group_id: null }) })
      queueTable('blocked_users', { data: null })

      const res = await POST(request({ content: 'Unavailable group comment' }), createContext())

      expect(res.status).toBe(403)
      expect(mockCreateComment).not.toHaveBeenCalled()
    })

    it.each([
      ['42501', 403],
      ['23503', 404],
      ['23514', 409],
      ['P0002', 409],
      ['XX001', 500],
    ])('maps a canonical create failure %s to HTTP %i', async (code, status) => {
      queueTable('posts', { data: activePost() })
      queueTable('blocked_users', { data: null })
      mockCreateComment.mockRejectedValue(Object.assign(new Error('create failed'), { code }))

      const res = await POST(request({ content: 'Race-safe comment' }), createContext())

      expect(res.status).toBe(status)
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
      expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(
        expect.anything(),
        TEST_POST_ID,
        mockUser.id
      )
      expect(body.success).toBe(true)
      expect(mockDeleteOwnCommentWithRollout).toHaveBeenCalledWith(expect.anything(), {
        commentId,
        postId: TEST_POST_ID,
        userId: mockUser.id,
      })
      expect(body.data).toMatchObject({ deleted_count: 2, comment_count: 7 })
    })

    it('does not reveal or mutate an owned comment after post access expires', async () => {
      mockCanServiceActorReadPost.mockResolvedValue(false)
      const req = new NextRequest(`http://localhost/api/posts/${TEST_POST_ID}/comments`, {
        method: 'DELETE',
        body: { comment_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' },
      })

      const res = await DELETE(req, createContext())

      expect(res.status).toBe(404)
      expect(mockDeleteOwnCommentWithRollout).not.toHaveBeenCalled()
      expect(mockSupabaseFrom).not.toHaveBeenCalled()
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
