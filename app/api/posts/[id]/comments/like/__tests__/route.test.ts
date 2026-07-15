/**
 * /api/posts/[id]/comments/like rolling reaction route tests.
 */

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
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() {
      return typeof this._body === 'string' ? JSON.parse(this._body) : this._body
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

type QueryResult = {
  data?: unknown
  error?: { code?: string; message?: string } | null
  count?: number | null
}

type QueryBuilder = {
  select: jest.Mock
  eq: jest.Mock
  or: jest.Mock
  limit: jest.Mock
  is: jest.Mock
  delete: jest.Mock
  update: jest.Mock
  insert: jest.Mock
  maybeSingle: jest.Mock
  single: jest.Mock
  then: Promise<QueryResult>['then']
}

function createQuery(result: QueryResult = {}): QueryBuilder {
  const resolved: QueryResult = {
    data: Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null,
    error: result.error ?? null,
    ...(Object.prototype.hasOwnProperty.call(result, 'count') ? { count: result.count } : {}),
  }
  const promise = Promise.resolve(resolved)
  const builder = {} as QueryBuilder

  builder.select = jest.fn(() => builder)
  builder.eq = jest.fn(() => builder)
  builder.or = jest.fn(() => builder)
  builder.limit = jest.fn(() => builder)
  builder.is = jest.fn(() => builder)
  builder.delete = jest.fn(() => builder)
  builder.update = jest.fn(() => builder)
  builder.insert = jest.fn(() => builder)
  builder.maybeSingle = jest.fn(() => promise)
  builder.single = jest.fn(() => promise)
  builder.then = promise.then.bind(promise)

  return builder
}

const queryQueues = new Map<string, QueryBuilder[]>()
const mockFrom = jest.fn((table: string) => {
  const builder = queryQueues.get(table)?.shift()
  if (!builder) throw new Error(`Unexpected query for ${table}`)
  return builder
})
const mockRpc = jest.fn()
let mockAuthenticated = true
const mockUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'test@test.com',
}

function queueQuery(table: string, result: QueryResult = {}) {
  const builder = createQuery(result)
  const queue = queryQueues.get(table) ?? []
  queue.push(builder)
  queryQueues.set(table, queue)
  return builder
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: typeof mockUser
        supabase: { rpc: typeof mockRpc; from: typeof mockFrom }
        request: unknown
        version: { current: string }
      }) => unknown
    ) =>
    async (request: unknown) => {
      if (!mockAuthenticated) {
        return {
          status: 401,
          _body: { success: false, error: 'Unauthorized' },
          async json() {
            return this._body
          },
          headers: new Map(),
        }
      }
      return handler({
        user: mockUser,
        supabase: {
          rpc: (...args: unknown[]) => mockRpc(...args),
          from: (...args: unknown[]) => mockFrom(...args),
        },
        request,
        version: { current: 'v1' },
      })
    },
}))

jest.mock('@/lib/api', () => ({
  success: (data: unknown, status = 200) => ({
    status,
    _body: { success: true, data },
    async json() {
      return this._body
    },
    headers: new Map(),
  }),
}))

jest.mock('@/lib/features', () => ({
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const POST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const OTHER_POST_ID = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f'
const COMMENT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const AUTHOR_ID = '22222222-2222-4222-8222-222222222222'
const GROUP_ID = '33333333-3333-4333-8333-333333333333'
const COMMENT_AUTHOR_ID = '44444444-4444-4444-8444-444444444444'

const ACTIVE_PUBLIC_POST = {
  id: POST_ID,
  author_id: AUTHOR_ID,
  visibility: 'public',
  group_id: null,
  status: 'active',
  deleted_at: null,
}

function request(body: unknown, postId = POST_ID) {
  return new NextRequest(`http://localhost/api/posts/${postId}/comments/like`, {
    method: 'POST',
    body,
  })
}

type FallbackOptions = {
  post?: QueryResult
  blocked?: QueryResult
  group?: QueryResult
  ban?: QueryResult
  membership?: QueryResult
  follow?: QueryResult
  comment?: QueryResult
  existing?: QueryResult
  mutation?: QueryResult
  likeRecount?: QueryResult
  dislikeRecount?: QueryResult
  counter?: QueryResult
  finalSource?: QueryResult
}

function arrangeFallback(options: FallbackOptions = {}) {
  const postResult = options.post ?? { data: ACTIVE_PUBLIC_POST }
  const post = (postResult.data ?? null) as typeof ACTIVE_PUBLIC_POST | null

  const builders = {
    post: queueQuery('posts', postResult),
    blocked: queueQuery('blocked_users', options.blocked ?? { data: null }),
    group: undefined as QueryBuilder | undefined,
    ban: undefined as QueryBuilder | undefined,
    membership: undefined as QueryBuilder | undefined,
    follow: undefined as QueryBuilder | undefined,
    comment: undefined as QueryBuilder | undefined,
    existing: undefined as QueryBuilder | undefined,
    mutation: undefined as QueryBuilder | undefined,
    likeRecount: undefined as QueryBuilder | undefined,
    dislikeRecount: undefined as QueryBuilder | undefined,
    counter: undefined as QueryBuilder | undefined,
    finalSource: undefined as QueryBuilder | undefined,
  }

  if (post?.group_id) {
    builders.group = queueQuery(
      'groups',
      options.group ?? { data: { id: post.group_id, dissolved_at: null } }
    )
    builders.ban = queueQuery('group_bans', options.ban ?? { data: null })
    builders.membership = queueQuery(
      'group_members',
      options.membership ?? { data: { user_id: mockUser.id } }
    )
  } else if (post?.visibility === 'followers' && post.author_id !== mockUser.id) {
    builders.follow = queueQuery(
      'user_follows',
      options.follow ?? { data: { follower_id: mockUser.id } }
    )
  }

  builders.comment = queueQuery(
    'comments',
    options.comment ?? {
      data: {
        id: COMMENT_ID,
        post_id: POST_ID,
        user_id: COMMENT_AUTHOR_ID,
        deleted_at: null,
      },
    }
  )
  builders.existing = queueQuery('comment_likes', options.existing ?? { data: null })
  builders.mutation = queueQuery('comment_likes', options.mutation ?? {})
  builders.likeRecount = queueQuery('comment_likes', options.likeRecount ?? { count: 3 })
  builders.dislikeRecount = queueQuery('comment_likes', options.dislikeRecount ?? { count: 1 })
  builders.counter = queueQuery(
    'comments',
    options.counter ?? {
      data: { id: COMMENT_ID, like_count: 3, dislike_count: 1 },
    }
  )
  builders.finalSource = queueQuery(
    'comment_likes',
    options.finalSource ?? { data: { reaction_type: 'like' } }
  )

  return builders
}

describe('POST /api/posts/[id]/comments/like', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queryQueues.clear()
    mockAuthenticated = true
    mockRpc.mockResolvedValue({
      data: {
        liked: true,
        disliked: false,
        like_count: 3,
        dislike_count: 1,
        reaction: 'like',
      },
      error: null,
    })
  })

  it('requires authentication through the shared write middleware', async () => {
    mockAuthenticated = false

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('uses the atomic RPC first and preserves its strict response contract', async () => {
    mockRpc.mockResolvedValue({
      data: {
        liked: false,
        disliked: true,
        like_count: 2,
        dislike_count: 2,
        reaction: 'dislike',
      },
      error: null,
    })

    const res = await POST(request({ comment_id: COMMENT_ID, type: 'dislike' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('toggle_comment_reaction', {
      p_post_id: POST_ID,
      p_comment_id: COMMENT_ID,
      p_user_id: mockUser.id,
      p_reaction_type: 'dislike',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(body).toEqual({
      success: true,
      data: {
        liked: false,
        disliked: true,
        like_count: 2,
        dislike_count: 2,
        reaction: 'dislike',
      },
    })
  })

  it('keeps omitted type backwards-compatible as a like', async () => {
    await POST(request({ comment_id: COMMENT_ID }))

    expect(mockRpc).toHaveBeenCalledWith(
      'toggle_comment_reaction',
      expect.objectContaining({ p_reaction_type: 'like' })
    )
  })

  it.each([
    ['invalid post ID', { comment_id: COMMENT_ID }, 'not-a-uuid'],
    ['invalid comment ID', { comment_id: 'not-a-uuid' }, POST_ID],
    ['unknown reaction type', { comment_id: COMMENT_ID, type: 'love' }, POST_ID],
    ['unexpected body field', { comment_id: COMMENT_ID, admin: true }, POST_ID],
    ['non-object body', ['not', 'an', 'object'], POST_ID],
  ])('rejects %s without invoking the database', async (_label, body, postId) => {
    const res = await POST(request(body, postId))

    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON without invoking the database', async () => {
    const res = await POST(request('{'))

    expect(res.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['P0002', 404],
    ['23503', 404],
    ['22023', 400],
    ['23514', 409],
    ['40001', 409],
    ['40P01', 409],
    ['42501', 403],
    ['PGRST205', 500],
    ['XX000', 500],
  ])('never falls back for atomic RPC error %s', async (code, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'private detail' } })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(status)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [
      'contradictory flags',
      {
        liked: true,
        disliked: false,
        like_count: 3,
        dislike_count: 1,
        reaction: null,
      },
      'like',
    ],
    [
      'the opposite reaction',
      {
        liked: true,
        disliked: false,
        like_count: 3,
        dislike_count: 1,
        reaction: 'like',
      },
      'dislike',
    ],
    [
      'a missing reaction acknowledgement',
      {
        liked: true,
        disliked: false,
        like_count: 3,
        dislike_count: 1,
      },
      'like',
    ],
  ])('fails closed when the RPC returns %s', async (_label, data, type) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const res = await POST(request({ comment_id: COMMENT_ID, type }))

    expect(res.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each(['PGRST202', '42883'])(
    'uses the strict legacy bridge only when RPC is objectively missing (%s)',
    async (code) => {
      mockRpc.mockResolvedValue({ data: null, error: { code, message: 'missing' } })
      const builders = arrangeFallback()

      const res = await POST(request({ comment_id: COMMENT_ID }))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toEqual({
        success: true,
        data: {
          liked: true,
          disliked: false,
          like_count: 3,
          dislike_count: 1,
          reaction: 'like',
        },
      })
      expect(builders.mutation?.insert).toHaveBeenCalledWith({
        comment_id: COMMENT_ID,
        user_id: mockUser.id,
        reaction_type: 'like',
      })
      expect(builders.likeRecount?.select).toHaveBeenCalledWith('id', {
        count: 'exact',
        head: true,
      })
      expect(builders.dislikeRecount?.select).toHaveBeenCalledWith('id', {
        count: 'exact',
        head: true,
      })
      expect(builders.counter?.update).toHaveBeenCalledWith({
        like_count: 3,
        dislike_count: 1,
      })
      expect(builders.finalSource?.maybeSingle).toHaveBeenCalledTimes(1)
    }
  )

  it('strictly acknowledges a legacy switch from like to dislike', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    const builders = arrangeFallback({
      existing: { data: { id: 'reaction-1', reaction_type: 'like' } },
      likeRecount: { count: 2 },
      dislikeRecount: { count: 2 },
      counter: { data: { id: COMMENT_ID, like_count: 2, dislike_count: 2 } },
      finalSource: { data: { reaction_type: 'dislike' } },
    })

    const res = await POST(request({ comment_id: COMMENT_ID, type: 'dislike' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(builders.mutation?.update).toHaveBeenCalledWith({ reaction_type: 'dislike' })
    expect(body.data).toEqual({
      liked: false,
      disliked: true,
      like_count: 2,
      dislike_count: 2,
      reaction: 'dislike',
    })
  })

  it('strictly acknowledges a legacy toggle-off, including a legacy null-like row', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
    const builders = arrangeFallback({
      existing: { data: { id: 'reaction-1', reaction_type: null } },
      likeRecount: { count: 2 },
      counter: { data: { id: COMMENT_ID, like_count: 2, dislike_count: 1 } },
      finalSource: { data: null },
    })

    const res = await POST(request({ comment_id: COMMENT_ID, type: 'like' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(builders.mutation?.delete).toHaveBeenCalledTimes(1)
    expect(body.data).toEqual({
      liked: false,
      disliked: false,
      like_count: 2,
      dislike_count: 1,
      reaction: null,
    })
  })

  it.each([
    ['post read', { post: { error: { code: 'XX001' } } }],
    ['block read', { blocked: { error: { code: 'XX002' } } }],
    ['comment read', { comment: { error: { code: 'XX003' } } }],
    ['source read', { existing: { error: { code: 'XX004' } } }],
    ['like recount', { likeRecount: { error: { code: 'XX005' } } }],
    ['dislike recount', { dislikeRecount: { error: { code: 'XX006' } } }],
    ['counter update', { counter: { error: { code: 'XX007' } } }],
    ['final source ACK', { finalSource: { error: { code: 'XX008' } } }],
  ])('fails closed on legacy %s error', async (_label, options) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback(options)

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(500)
  })

  it.each([
    [null, { data: null }],
    ['deleted', { data: { ...ACTIVE_PUBLIC_POST, deleted_at: '2026-07-15T00:00:00Z' } }],
    ['locked', { data: { ...ACTIVE_PUBLIC_POST, status: 'locked' } }],
  ])('rejects a %s post before legacy mutation', async (_label, post) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
    arrangeFallback({ post })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(404)
  })

  it.each([
    ['missing', { data: null }],
    ['wrong-post', { data: { id: COMMENT_ID, post_id: OTHER_POST_ID, deleted_at: null } }],
    ['deleted', { data: { id: COMMENT_ID, post_id: POST_ID, deleted_at: '2026-07-15T00:00:00Z' } }],
  ])('rejects a %s comment before legacy mutation', async (_label, comment) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback({ comment })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(404)
  })

  it('enforces block relationships in the legacy bridge', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback({ blocked: { data: { blocker_id: mockUser.id } } })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(403)
  })

  it('checks both the post author and comment author before adding a reaction', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    const builders = arrangeFallback()

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(200)
    expect(builders.blocked.or).toHaveBeenCalledWith(
      expect.stringContaining(`blocked_id.eq.${COMMENT_AUTHOR_ID}`)
    )
    expect(builders.blocked.or).toHaveBeenCalledWith(
      expect.stringContaining(`blocker_id.eq.${COMMENT_AUTHOR_ID}`)
    )
  })

  it('allows a pure removal even when a block was added after the reaction', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
    const builders = arrangeFallback({
      blocked: { data: { blocker_id: COMMENT_AUTHOR_ID } },
      existing: { data: { id: 'reaction-1', reaction_type: 'like' } },
      likeRecount: { count: 2 },
      counter: { data: { id: COMMENT_ID, like_count: 2, dislike_count: 1 } },
      finalSource: { data: null },
    })

    const res = await POST(request({ comment_id: COMMENT_ID, type: 'like' }))

    expect(res.status).toBe(200)
    expect(builders.blocked.or).not.toHaveBeenCalled()
    expect(builders.mutation?.delete).toHaveBeenCalledTimes(1)
  })

  it('allows a pure removal after group membership is lost', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    const builders = arrangeFallback({
      post: { data: { ...ACTIVE_PUBLIC_POST, group_id: GROUP_ID, visibility: 'group' } },
      group: {
        data: { id: GROUP_ID, dissolved_at: '2026-07-15T00:00:00.000Z' },
      },
      membership: { data: null },
      existing: { data: { id: 'reaction-1', reaction_type: 'like' } },
      likeRecount: { count: 2 },
      counter: { data: { id: COMMENT_ID, like_count: 2, dislike_count: 1 } },
      finalSource: { data: null },
    })

    const res = await POST(request({ comment_id: COMMENT_ID, type: 'like' }))

    expect(res.status).toBe(200)
    expect(builders.group?.maybeSingle).not.toHaveBeenCalled()
    expect(builders.membership?.maybeSingle).not.toHaveBeenCalled()
  })

  it.each([
    ['missing group', { group: { data: null } }, 403],
    [
      'dissolved group',
      { group: { data: { id: GROUP_ID, dissolved_at: '2026-07-15T00:00:00.000Z' } } },
      403,
    ],
    ['group lookup error', { group: { error: { code: 'XX100' } } }, 500],
    ['banned member', { ban: { data: { user_id: mockUser.id } } }, 403],
    ['non-member', { membership: { data: null } }, 403],
    ['ban lookup error', { ban: { error: { code: 'XX101' } } }, 500],
    ['membership lookup error', { membership: { error: { code: 'XX102' } } }, 500],
  ])('enforces group audience for a %s', async (_label, audience, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback({
      post: { data: { ...ACTIVE_PUBLIC_POST, group_id: GROUP_ID, visibility: 'group' } },
      ...audience,
    })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(status)
  })

  it('allows a valid group member through the legacy bridge', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
    arrangeFallback({
      post: { data: { ...ACTIVE_PUBLIC_POST, group_id: GROUP_ID, visibility: 'group' } },
    })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(200)
  })

  it.each([
    ['non-follower', { follow: { data: null } }, 403],
    ['follow lookup error', { follow: { error: { code: 'XX201' } } }, 500],
  ])('enforces followers audience for a %s', async (_label, audience, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback({
      post: { data: { ...ACTIVE_PUBLIC_POST, visibility: 'followers' } },
      ...audience,
    })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(status)
  })

  it('allows the author to react to a followers-only post without a follow edge', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
    arrangeFallback({
      post: {
        data: { ...ACTIVE_PUBLIC_POST, author_id: mockUser.id, visibility: 'followers' },
      },
    })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(200)
    expect(mockFrom).not.toHaveBeenCalledWith('user_follows')
  })

  it('rejects an unknown or malformed audience', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback({ post: { data: { ...ACTIVE_PUBLIC_POST, visibility: 'group' } } })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(403)
  })

  it.each([
    ['insert', { existing: { data: null }, mutation: { error: { code: 'XX301' } } }, 'like', 500],
    [
      'update',
      {
        existing: { data: { id: 'reaction-1', reaction_type: 'like' } },
        mutation: { error: { code: 'XX302' } },
      },
      'dislike',
      500,
    ],
    [
      'delete',
      {
        existing: { data: { id: 'reaction-1', reaction_type: 'like' } },
        mutation: { error: { code: 'XX303' } },
      },
      'like',
      500,
    ],
    [
      'concurrent insert',
      { existing: { data: null }, mutation: { error: { code: '23505' } } },
      'like',
      409,
    ],
  ])('never swallows a legacy %s mutation error', async (_label, options, type, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback(options)

    const res = await POST(request({ comment_id: COMMENT_ID, type }))

    expect(res.status).toBe(status)
  })

  it.each([
    ['null like count', { likeRecount: { count: null } }],
    ['negative dislike count', { dislikeRecount: { count: -1 } }],
    ['missing counter ACK row', { counter: { data: null } }],
    [
      'mismatched counter ACK',
      { counter: { data: { id: COMMENT_ID, like_count: 2, dislike_count: 1 } } },
    ],
  ])('fails closed on %s', async (_label, options) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '42883' } })
    arrangeFallback(options)

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(500)
  })

  it('returns conflict instead of a false ACK when the final source row lost a race', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    arrangeFallback({ finalSource: { data: null } })

    const res = await POST(request({ comment_id: COMMENT_ID }))

    expect(res.status).toBe(409)
  })
})
