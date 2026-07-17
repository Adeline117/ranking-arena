/**
 * /api/feed/personalized current-hydration contract
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

type QueryResult = { data: unknown; error: unknown }
type QueryCall = { table: string; method: string; args: unknown[] }

const mockGetAuthUser = jest.fn()
const mockRpc = jest.fn()
const mockSupabaseFrom = jest.fn()
const mockQueryCalls: QueryCall[] = []
const mockTableQueues = new Map<string, QueryResult[]>()

function queueTableResult(table: string, ...results: QueryResult[]) {
  mockTableQueues.set(table, [...(mockTableQueues.get(table) || []), ...results])
}

function createQueryBuilder(table: string) {
  const result = mockTableQueues.get(table)?.shift() ?? { data: [], error: null }
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'neq', 'is', 'order', 'range']) {
    builder[method] = jest.fn((...args: unknown[]) => {
      mockQueryCalls.push({ table, method, args })
      return builder
    })
  }
  builder.then = (resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return builder
}

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

const mockFilterServiceReadablePostRows = jest.fn()

jest.mock('@/lib/data/service-post-audience', () => ({
  filterServiceReadablePostRows: (...args: unknown[]) => mockFilterServiceReadablePostRows(...args),
}))

const mockGetOrSet = jest.fn()

jest.mock('@/lib/cache', () => ({
  getOrSet: (...args: unknown[]) => mockGetOrSet(...args),
}))

const mockLogRpcError = jest.fn()

jest.mock('@/lib/data/serving/log-rpc-error', () => ({
  logRpcError: (...args: unknown[]) => mockLogRpcError(...args),
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

const USER_A = '10000000-0000-4000-8000-000000000001'
const USER_B = '10000000-0000-4000-8000-000000000002'
const AUTHOR_ID = '20000000-0000-4000-8000-000000000001'
const GROUP_ID = '30000000-0000-4000-8000-000000000001'

function postId(index: number): string {
  return `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function currentPost(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Current ${id}`,
    author_id: AUTHOR_ID,
    author_handle: 'historical-handle',
    group_id: null,
    group: null,
    visibility: 'public',
    ...overrides,
  }
}

function currentProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: AUTHOR_ID,
    handle: 'current-handle',
    avatar_url: 'https://current.example/avatar.png',
    ...overrides,
  }
}

describe('GET /api/feed/personalized', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockTableQueues.clear()
    mockQueryCalls.length = 0
    mockSupabaseFrom.mockImplementation((table: string) => createQueryBuilder(table))
    mockGetAuthUser.mockResolvedValue(null)
    mockGetUserPostReactions.mockResolvedValue(new Map())
    mockGetUserPostVotes.mockResolvedValue(new Map())
    mockFilterServiceReadablePostRows.mockImplementation(
      async (_supabase: unknown, rows: unknown[]) => rows
    )
    mockGetOrSet.mockImplementation(async (_key: string, factory: () => Promise<unknown>) =>
      factory()
    )
    mockRpc.mockResolvedValue({ data: [], error: null })
  })

  it('caches only ordered hot IDs and rebuilds current post, author, and group fields', async () => {
    const id = postId(1)
    let candidatePayload: unknown
    mockGetOrSet.mockImplementation(
      async (_key: string, factory: () => Promise<unknown>, options: { schema?: unknown }) => {
        expect(options.schema).toBeDefined()
        candidatePayload = await factory()
        return candidatePayload
      }
    )
    queueTableResult(
      'posts',
      { data: [{ id }], error: null },
      {
        data: [
          currentPost(id, {
            title: 'Current title',
            group_id: GROUP_ID,
            group: {
              id: GROUP_ID,
              name: 'Current group',
              name_en: 'Current group EN',
              avatar_url: 'https://current.example/group.png',
            },
          }),
        ],
        error: null,
      }
    )
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(candidatePayload).toEqual([id])
    expect(body.data.posts).toEqual([
      expect.objectContaining({
        id,
        title: 'Current title',
        author_handle: 'current-handle',
        author: currentProfile(),
        group: {
          id: GROUP_ID,
          name: 'Current group',
          name_en: 'Current group EN',
          avatar_url: 'https://current.example/group.png',
        },
      }),
    ])
    const postSelects = mockQueryCalls.filter(
      (call) => call.table === 'posts' && call.method === 'select'
    )
    expect(postSelects[0].args).toEqual(['id'])
    expect(String(postSelects[1].args[0])).toContain('group:groups!posts_group_id_fkey')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(res.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(mockGetAuthUser).toHaveBeenCalledWith(expect.anything())
  })

  it('reflects current post, author, and group edits on the next hit of the same ID cache', async () => {
    const id = postId(1)
    mockGetOrSet.mockResolvedValue([id])
    queueTableResult(
      'posts',
      {
        data: [
          currentPost(id, {
            title: 'Before edit',
            group_id: GROUP_ID,
            group: {
              id: GROUP_ID,
              name: 'Before group edit',
              name_en: null,
              avatar_url: 'https://before.example/group.png',
            },
          }),
        ],
        error: null,
      },
      {
        data: [
          currentPost(id, {
            title: 'After edit',
            group_id: GROUP_ID,
            group: {
              id: GROUP_ID,
              name: 'After group edit',
              name_en: null,
              avatar_url: 'https://after.example/group.png',
            },
          }),
        ],
        error: null,
      }
    )
    queueTableResult(
      'user_profiles',
      {
        data: [
          currentProfile({
            handle: 'before-handle',
            avatar_url: 'https://before.example/avatar.png',
          }),
        ],
        error: null,
      },
      {
        data: [
          currentProfile({
            handle: 'after-handle',
            avatar_url: 'https://after.example/avatar.png',
          }),
        ],
        error: null,
      }
    )

    const before = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const after = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const beforePost = (await before.json()).data.posts[0]
    const afterPost = (await after.json()).data.posts[0]

    expect(beforePost).toEqual(
      expect.objectContaining({
        title: 'Before edit',
        author_handle: 'before-handle',
        group: expect.objectContaining({ name: 'Before group edit' }),
      })
    )
    expect(afterPost).toEqual(
      expect.objectContaining({
        title: 'After edit',
        author_handle: 'after-handle',
        author: expect.objectContaining({ avatar_url: 'https://after.example/avatar.png' }),
        group: expect.objectContaining({
          name: 'After group edit',
          avatar_url: 'https://after.example/group.png',
        }),
      })
    )
  })

  it('preserves personalized RPC order after the unordered current-row read', async () => {
    const first = postId(1)
    const second = postId(2)
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockRpc.mockResolvedValue({
      data: [{ post_id: second }, { post_id: first }],
      error: null,
    })
    queueTableResult('posts', {
      data: [currentPost(first), currentPost(second)],
      error: null,
    })
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const body = await res.json()

    expect(body.data.posts.map((post: { id: string }) => post.id)).toEqual([second, first])
    expect(mockGetOrSet).toHaveBeenCalledWith(
      `feed:personalized:v3:ids:${USER_A}:0`,
      expect.any(Function),
      expect.objectContaining({ ttl: 60, schema: expect.anything() })
    )
    expect(mockFilterServiceReadablePostRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      USER_A
    )
  })

  it('rechecks the exact actor on every hit and removes a now-unreadable candidate', async () => {
    const id = postId(1)
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockGetOrSet.mockResolvedValue([id])
    queueTableResult(
      'posts',
      { data: [currentPost(id)], error: null },
      { data: [currentPost(id)], error: null }
    )
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })
    mockFilterServiceReadablePostRows
      .mockImplementationOnce(async (_supabase: unknown, rows: unknown[]) => rows)
      .mockResolvedValueOnce([])

    const first = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const second = await GET(new NextRequest('http://localhost/api/feed/personalized'))

    expect((await first.json()).data.posts).toHaveLength(1)
    expect((await second.json()).data.posts).toEqual([])
    expect(mockFilterServiceReadablePostRows).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.any(Array),
      USER_A
    )
    expect(mockFilterServiceReadablePostRows).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.any(Array),
      USER_A
    )
  })

  it('drops a cached candidate that is deleted before current hydration', async () => {
    const id = postId(1)
    mockGetOrSet.mockResolvedValue([id])
    queueTableResult('posts', { data: [], error: null })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const body = await res.json()

    expect(body.data.posts).toEqual([])
    expect(mockFilterServiceReadablePostRows).not.toHaveBeenCalled()
  })

  it('backfills from the next cached ID batch when the first batch is unreadable', async () => {
    const hiddenIds = Array.from({ length: 100 }, (_, index) => postId(index + 1))
    const visibleId = postId(101)
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockGetOrSet.mockImplementation(async (key: string) =>
      key.endsWith(':0') ? hiddenIds : [visibleId]
    )
    queueTableResult(
      'posts',
      { data: hiddenIds.map((id) => currentPost(id)), error: null },
      { data: [currentPost(visibleId)], error: null }
    )
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })
    mockFilterServiceReadablePostRows
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async (_supabase: unknown, rows: unknown[]) => rows)

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized?limit=1'))
    const body = await res.json()

    expect(body.data.posts.map((post: { id: string }) => post.id)).toEqual([visibleId])
    expect(mockGetOrSet).toHaveBeenNthCalledWith(
      2,
      `feed:personalized:v3:ids:${USER_A}:100`,
      expect.any(Function),
      expect.any(Object)
    )
  })

  it('uses one current look-ahead row for exact has_more', async () => {
    const ids = Array.from({ length: 21 }, (_, index) => postId(index + 1))
    mockGetOrSet.mockResolvedValue(ids)
    queueTableResult('posts', { data: ids.map((id) => currentPost(id)), error: null })
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized?limit=20'))
    const body = await res.json()

    expect(body.data.posts).toHaveLength(20)
    expect(body.meta.pagination.has_more).toBe(true)
  })

  it('attaches current user reaction and vote state after hydration', async () => {
    const id = postId(1)
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockGetOrSet.mockResolvedValue([id])
    queueTableResult('posts', { data: [currentPost(id)], error: null })
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })
    mockGetUserPostReactions.mockResolvedValue(new Map([[id, 'up']]))
    mockGetUserPostVotes.mockResolvedValue(new Map([[id, 'bull']]))

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const body = await res.json()

    expect(body.data.posts[0]).toEqual(
      expect.objectContaining({ user_reaction: 'up', user_vote: 'bull' })
    )
  })

  it('falls back to ID-only hot candidates when the personalized RPC is unavailable', async () => {
    const id = postId(1)
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc unavailable' } })
    queueTableResult(
      'posts',
      { data: [{ id }], error: null },
      { data: [currentPost(id)], error: null }
    )
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const body = await res.json()

    expect(body.data.posts.map((post: { id: string }) => post.id)).toEqual([id])
    expect(mockLogRpcError).toHaveBeenCalledWith(
      'get_personalized_feed',
      expect.objectContaining({ message: 'rpc unavailable' })
    )
    expect(mockGetOrSet.mock.calls.map((call) => call[0])).toEqual([
      `feed:personalized:v3:ids:${USER_A}:0`,
      'feed:personalized:v3:ids:hot:0',
    ])
  })

  it('fails closed on an old full-payload cache entry', async () => {
    mockGetOrSet.mockResolvedValue({
      posts: [{ id: postId(1), title: 'stale title' }],
      hasMore: false,
    })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))

    expect(res.status).toBe(500)
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
    expect(mockFilterServiceReadablePostRows).not.toHaveBeenCalled()
  })

  it('fails closed on malformed personalized rows instead of widening to hot', async () => {
    mockGetAuthUser.mockResolvedValue({ id: USER_A })
    mockRpc.mockResolvedValue({ data: [{ post_id: 'not-a-uuid' }], error: null })

    const res = await GET(new NextRequest('http://localhost/api/feed/personalized'))

    expect(res.status).toBe(500)
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
    expect(mockGetOrSet).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the current post or author read fails', async () => {
    const id = postId(1)
    mockGetOrSet.mockResolvedValue([id])
    queueTableResult('posts', { data: null, error: { message: 'post read failed' } })

    const postFailure = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    expect(postFailure.status).toBe(500)

    queueTableResult('posts', { data: [currentPost(id)], error: null })
    queueTableResult('user_profiles', {
      data: null,
      error: { message: 'profile read failed' },
    })
    const profileFailure = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    expect(profileFailure.status).toBe(500)
  })

  it.each(['offset=1.5', 'offset=10001', 'limit=1.5'])(
    'rejects unsafe pagination value %s',
    async (query) => {
      const res = await GET(new NextRequest(`http://localhost/api/feed/personalized?${query}`))

      expect(res.status).toBe(400)
      expect(mockGetOrSet).not.toHaveBeenCalled()
    }
  )

  it('binds the same cached ID to each current actor decision independently', async () => {
    const id = postId(1)
    mockGetAuthUser.mockResolvedValueOnce({ id: USER_A }).mockResolvedValueOnce({ id: USER_B })
    mockGetOrSet.mockResolvedValue([id])
    queueTableResult(
      'posts',
      { data: [currentPost(id)], error: null },
      { data: [currentPost(id)], error: null }
    )
    queueTableResult('user_profiles', { data: [currentProfile()], error: null })
    mockFilterServiceReadablePostRows.mockImplementation(
      async (_supabase: unknown, rows: unknown[], actorId: string) =>
        actorId === USER_A ? rows : []
    )

    const allowed = await GET(new NextRequest('http://localhost/api/feed/personalized'))
    const denied = await GET(new NextRequest('http://localhost/api/feed/personalized'))

    expect((await allowed.json()).data.posts).toHaveLength(1)
    expect((await denied.json()).data.posts).toEqual([])
  })
})
