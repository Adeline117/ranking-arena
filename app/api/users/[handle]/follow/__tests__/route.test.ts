jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers = new Headers()
    method = 'GET'

    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

type QueryResult = { data: unknown; error: unknown }
type QueryChain = Record<string, jest.Mock> & { then: Promise<QueryResult>['then'] }

function makeQuery(result: QueryResult): QueryChain {
  const chain = {} as QueryChain
  for (const method of ['select', 'eq', 'in', 'order', 'or']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.limit = jest.fn(async () => result)
  chain.maybeSingle = jest.fn(async () => result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const mockFrom = jest.fn()
let mockMiddlewareUser: { id: string } | null = null
const mockReadAudience = jest.fn()
const mockFeatureGuard = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => async (request: unknown) =>
      handler({
        user: mockMiddlewareUser,
        supabase: { from: mockFrom },
        request,
        version: {},
      }),
}))

jest.mock('@/lib/profile/public-audience', () => {
  const actual = jest.requireActual('@/lib/profile/public-audience')
  return {
    ...actual,
    readPublicProfileAudienceByHandle: (...args: unknown[]) => mockReadAudience(...args),
  }
})

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => mockFeatureGuard() }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args) }),
}))

import { NextRequest, NextResponse } from 'next/server'
import { GET } from '../route'
import { FOLLOW_LIST_PAGE_SIZE } from '@/lib/follows/follow-list-client-contract'

const TARGET_ID = '10000000-0000-4000-8000-000000000001'
const VIEWER_ID = '10000000-0000-4000-8000-000000000002'
const ACTIVE_ID = '20000000-0000-4000-8000-000000000001'
const DELETED_ID = '20000000-0000-4000-8000-000000000002'
const EDGE_ID = '30000000-0000-4000-8000-000000000001'
const CREATED_AT = '2026-08-03T12:00:00.000Z'

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    handle: 'Alice',
    show_followers: true,
    show_following: true,
    deleted_at: null,
    banned_at: null,
    is_banned: false,
    ban_expires_at: null,
    ...overrides,
  }
}

function activeListProfile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    handle: `user_${id.slice(0, 4)}`,
    bio: null,
    avatar_url: null,
    deleted_at: null,
    banned_at: null,
    is_banned: false,
    ban_expires_at: null,
    ...overrides,
  }
}

function edge(
  relatedUserId = ACTIVE_ID,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: EDGE_ID,
    created_at: CREATED_AT,
    follower_id: relatedUserId,
    following_id: TARGET_ID,
    ...overrides,
  }
}

function request(path = '/api/users/alice/follow?list=followers') {
  return new NextRequest(`http://localhost${path}`)
}

async function bodyOf(response: { json: () => Promise<unknown> }) {
  return (await response.json()) as Record<string, unknown>
}

describe('GET /api/users/[handle]/follow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMiddlewareUser = null
    mockFeatureGuard.mockReturnValue(null)
    mockReadAudience.mockResolvedValue({
      status: 'active',
      profile: activeTarget(),
    })
  })

  it('rejects missing, duplicated, unknown, or malformed query input before data reads', async () => {
    for (const path of [
      '/api/users/alice/follow',
      '/api/users/alice/follow?list=followers&list=following',
      '/api/users/alice/follow?list=followers&limit=100',
      '/api/users/alice/follow?list=followers&cursor=%25%25bad',
    ]) {
      const response = await GET(request(path), { params: { handle: 'alice' } })
      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    }

    const invalidHandle = await GET(request(), { params: { handle: 'bad%2Fhandle' } })
    expect(invalidHandle.status).toBe(400)
    expect(mockReadAudience).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not read profile-owned resources for an inactive target', async () => {
    mockReadAudience.mockResolvedValue({
      status: 'inactive',
      profile: activeTarget({ deleted_at: CREATED_AT }),
    })

    const response = await GET(request(), { params: Promise.resolve({ handle: 'alice' }) })

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  })

  it('returns one exact anonymous identity-bound page and filters inactive profiles', async () => {
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    const edgeQuery = makeQuery({
      data: [edge(), edge(DELETED_ID, { id: '30000000-0000-4000-8000-000000000000' })],
      error: null,
    })
    const profilesQuery = makeQuery({
      data: [
        activeListProfile(ACTIVE_ID, { handle: 'bob', bio: 'bio' }),
        activeListProfile(DELETED_ID, { deleted_at: CREATED_AT }),
      ],
      error: null,
    })
    const recheckQuery = makeQuery({ data: activeTarget(), error: null })
    mockFrom
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(edgeQuery)
      .mockReturnValueOnce(profilesQuery)
      .mockReturnValueOnce(recheckQuery)

    const response = await GET(request(), { params: { handle: 'alice' } })
    const body = await bodyOf(response)

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: {
        viewer_id: null,
        target_user_id: TARGET_ID,
        target_handle: 'Alice',
        list: 'followers',
        hidden: false,
        users: [
          {
            id: ACTIVE_ID,
            handle: 'bob',
            bio: 'bio',
            avatar_url: null,
            followed_at: CREATED_AT,
            is_following: false,
          },
        ],
        pagination: { limit: FOLLOW_LIST_PAGE_SIZE, has_more: false, next_cursor: null },
      },
      meta: { timestamp: expect.any(String) },
    })
    expect(edgeQuery.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false })
    expect(edgeQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
    expect(edgeQuery.limit).toHaveBeenCalledWith(FOLLOW_LIST_PAGE_SIZE + 1)
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('binds follow status to the authenticated viewer', async () => {
    mockMiddlewareUser = { id: VIEWER_ID }
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    const edgeQuery = makeQuery({ data: [edge()], error: null })
    const profilesQuery = makeQuery({ data: [activeListProfile(ACTIVE_ID)], error: null })
    const statusQuery = makeQuery({
      data: [{ follower_id: VIEWER_ID, following_id: ACTIVE_ID }],
      error: null,
    })
    const recheckQuery = makeQuery({ data: activeTarget(), error: null })
    mockFrom
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(edgeQuery)
      .mockReturnValueOnce(profilesQuery)
      .mockReturnValueOnce(statusQuery)
      .mockReturnValueOnce(recheckQuery)

    const response = await GET(request(), { params: { handle: 'alice' } })
    const body = await bodyOf(response)
    const data = body.data as Record<string, unknown>
    const users = data.users as Array<Record<string, unknown>>

    expect(data.viewer_id).toBe(VIEWER_ID)
    expect(users[0]?.is_following).toBe(true)
    expect(statusQuery.eq).toHaveBeenCalledWith('follower_id', VIEWER_ID)
    expect(statusQuery.in).toHaveBeenCalledWith('following_id', [ACTIVE_ID])
  })

  it.each([
    ['followers', { show_followers: false }],
    ['following', { show_following: null }],
  ] as const)('returns an exact hidden %s page without reading edges', async (list, privacy) => {
    const targetQuery = makeQuery({ data: activeTarget(privacy), error: null })
    mockFrom.mockReturnValueOnce(targetQuery)

    const response = await GET(request(`/api/users/alice/follow?list=${list}`), {
      params: { handle: 'alice' },
    })
    const body = await bodyOf(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      data: {
        viewer_id: null,
        target_user_id: TARGET_ID,
        list,
        hidden: true,
        users: [],
        pagination: { has_more: false, next_cursor: null },
      },
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('lets the authenticated owner read a private list', async () => {
    mockMiddlewareUser = { id: TARGET_ID }
    const privateTarget = activeTarget({ show_following: false })
    const targetQuery = makeQuery({ data: privateTarget, error: null })
    const edgeQuery = makeQuery({ data: [], error: null })
    const recheckQuery = makeQuery({ data: privateTarget, error: null })
    mockFrom
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(edgeQuery)
      .mockReturnValueOnce(recheckQuery)

    const response = await GET(request('/api/users/alice/follow?list=following'), {
      params: { handle: 'alice' },
    })
    const body = await bodyOf(response)

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ data: { viewer_id: TARGET_ID, hidden: false, users: [] } })
    expect(edgeQuery.eq).toHaveBeenCalledWith('follower_id', TARGET_ID)
  })

  it('discards a materialized page if the privacy switch closes during the read', async () => {
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    const edgeQuery = makeQuery({ data: [edge()], error: null })
    const profilesQuery = makeQuery({ data: [activeListProfile(ACTIVE_ID)], error: null })
    const recheckQuery = makeQuery({ data: activeTarget({ show_followers: false }), error: null })
    mockFrom
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(edgeQuery)
      .mockReturnValueOnce(profilesQuery)
      .mockReturnValueOnce(recheckQuery)

    const response = await GET(request(), { params: { handle: 'alice' } })
    const body = await bodyOf(response)

    expect(body).toMatchObject({ data: { hidden: true, users: [] } })
  })

  it('uses a deterministic cursor and rejects it on another list', async () => {
    const edges = Array.from({ length: FOLLOW_LIST_PAGE_SIZE + 1 }, (_, index) => {
      const suffix = (FOLLOW_LIST_PAGE_SIZE + 1 - index).toString(16).padStart(12, '0')
      return edge(`20000000-0000-4000-8000-${suffix}`, {
        id: `30000000-0000-4000-8000-${suffix}`,
        created_at: `2026-08-03T11:${String(59 - index).padStart(2, '0')}:00.000Z`,
      })
    })
    const profiles = edges
      .slice(0, FOLLOW_LIST_PAGE_SIZE)
      .map((item) => activeListProfile(String(item.follower_id)))
    mockFrom
      .mockReturnValueOnce(makeQuery({ data: activeTarget(), error: null }))
      .mockReturnValueOnce(makeQuery({ data: edges, error: null }))
      .mockReturnValueOnce(makeQuery({ data: profiles, error: null }))
      .mockReturnValueOnce(makeQuery({ data: activeTarget(), error: null }))

    const firstResponse = await GET(request(), { params: { handle: 'alice' } })
    const firstBody = await bodyOf(firstResponse)
    const firstData = firstBody.data as Record<string, unknown>
    const pagination = firstData.pagination as Record<string, unknown>
    const cursor = String(pagination.next_cursor)
    expect(pagination.has_more).toBe(true)
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))).toEqual({
      version: 1,
      target_user_id: TARGET_ID,
      list: 'followers',
      created_at: edges[FOLLOW_LIST_PAGE_SIZE - 1]?.created_at,
      edge_id: edges[FOLLOW_LIST_PAGE_SIZE - 1]?.id,
    })

    mockFrom.mockReset()
    mockFrom.mockReturnValueOnce(makeQuery({ data: activeTarget(), error: null }))
    const wrongListResponse = await GET(
      request(`/api/users/alice/follow?list=following&cursor=${encodeURIComponent(cursor)}`),
      { params: { handle: 'alice' } }
    )
    expect(wrongListResponse.status).toBe(400)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('applies a valid next-page cursor to the total edge ordering', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        target_user_id: TARGET_ID,
        list: 'followers',
        created_at: CREATED_AT,
        edge_id: EDGE_ID,
      })
    ).toString('base64url')
    const nextEdge = edge(ACTIVE_ID, {
      id: '30000000-0000-4000-8000-000000000000',
      created_at: CREATED_AT,
    })
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    const edgeQuery = makeQuery({ data: [nextEdge], error: null })
    const profileQuery = makeQuery({ data: [activeListProfile(ACTIVE_ID)], error: null })
    const recheckQuery = makeQuery({ data: activeTarget(), error: null })
    mockFrom
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(edgeQuery)
      .mockReturnValueOnce(profileQuery)
      .mockReturnValueOnce(recheckQuery)

    const response = await GET(
      request(`/api/users/alice/follow?list=followers&cursor=${encodeURIComponent(cursor)}`),
      { params: { handle: 'alice' } }
    )

    expect(response.status).toBe(200)
    expect(edgeQuery.or).toHaveBeenCalledWith(
      `created_at.lt.${CREATED_AT},and(created_at.eq.${CREATED_AT},id.lt.${EDGE_ID})`
    )
  })

  it('fails closed on malformed edge ordering or malformed authenticated identity', async () => {
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    const badEdgeQuery = makeQuery({
      data: [
        edge(ACTIVE_ID),
        edge(DELETED_ID, {
          id: '30000000-0000-4000-8000-000000000002',
          created_at: '2026-08-03T12:00:01.000Z',
        }),
      ],
      error: null,
    })
    mockFrom.mockReturnValueOnce(targetQuery).mockReturnValueOnce(badEdgeQuery)

    const malformed = await GET(request(), { params: { handle: 'alice' } })
    expect(malformed.status).toBe(500)

    jest.clearAllMocks()
    mockMiddlewareUser = { id: 'not-a-uuid' }
    const unauthorized = await GET(request(), { params: { handle: 'alice' } })
    expect(unauthorized.status).toBe(401)
    expect(mockReadAudience).not.toHaveBeenCalled()
  })

  it('fails closed when an edge acknowledgement is bound to another target', async () => {
    mockFrom
      .mockReturnValueOnce(makeQuery({ data: activeTarget(), error: null }))
      .mockReturnValueOnce(
        makeQuery({
          data: [edge(ACTIVE_ID, { following_id: '50000000-0000-4000-8000-000000000001' })],
          error: null,
        })
      )

    const response = await GET(request(), { params: { handle: 'alice' } })

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('adds no-store headers to a feature-guard response', async () => {
    mockFeatureGuard.mockReturnValue(NextResponse.json({ error: 'disabled' }, { status: 503 }))

    const response = await GET(request(), { params: { handle: 'alice' } })

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
