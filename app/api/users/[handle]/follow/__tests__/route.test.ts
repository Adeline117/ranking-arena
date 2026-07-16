jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
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
  for (const method of ['select', 'eq', 'in', 'order']) {
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

jest.mock('@/lib/features', () => ({ socialFeatureGuard: jest.fn(() => null) }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const TARGET_ID = '10000000-0000-4000-8000-000000000001'

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    handle: 'alice',
    show_followers: true,
    show_following: true,
    follower_count: 2,
    following_count: 1,
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
    handle: `user-${id.slice(0, 4)}`,
    bio: null,
    avatar_url: null,
    deleted_at: null,
    banned_at: null,
    is_banned: false,
    ban_expires_at: null,
    ...overrides,
  }
}

describe('GET /api/users/[handle]/follow public profile boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMiddlewareUser = null
    mockReadAudience.mockResolvedValue({
      status: 'active',
      profile: activeTarget(),
    })
  })

  it('does not read follow-owned resources for an inactive target', async () => {
    mockReadAudience.mockResolvedValue({
      status: 'inactive',
      profile: activeTarget({ deleted_at: '2026-07-16T00:00:00.000Z' }),
    })

    const response = await GET(
      new NextRequest('http://localhost/api/users/alice/follow?list=followers'),
      { params: Promise.resolve({ handle: 'alice' }) }
    )

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('rechecks target state before reading its follow edges', async () => {
    const targetQuery = makeQuery({
      data: activeTarget({ banned_at: '2026-07-16T00:00:00.000Z' }),
      error: null,
    })
    mockFrom.mockReturnValueOnce(targetQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/users/alice/follow?list=followers'),
      { params: Promise.resolve({ handle: 'alice' }) }
    )

    expect(response.status).toBe(404)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('filters deleted and banned profiles from a freshly read followers list', async () => {
    const activeId = '20000000-0000-4000-8000-000000000001'
    const deletedId = '20000000-0000-4000-8000-000000000002'
    const bannedId = '20000000-0000-4000-8000-000000000003'
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    const edgeQuery = makeQuery({
      data: [
        { id: 'edge-1', follower_id: activeId, created_at: '2026-07-16T00:00:00.000Z' },
        { id: 'edge-2', follower_id: deletedId, created_at: '2026-07-16T00:00:00.000Z' },
        { id: 'edge-3', follower_id: bannedId, created_at: '2026-07-16T00:00:00.000Z' },
      ],
      error: null,
    })
    const profilesQuery = makeQuery({
      data: [
        activeListProfile(activeId),
        activeListProfile(deletedId, { deleted_at: '2026-07-16T00:00:00.000Z' }),
        activeListProfile(bannedId, { is_banned: true, ban_expires_at: null }),
      ],
      error: null,
    })
    mockFrom
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(edgeQuery)
      .mockReturnValueOnce(profilesQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/users/alice/follow?list=followers'),
      { params: Promise.resolve({ handle: 'alice' }) }
    )
    const body = await response.json()

    expect(body.followers).toHaveLength(1)
    expect(body.followers[0].id).toBe(activeId)
    expect(body.count).toBe(1)
    expect(profilesQuery.select).toHaveBeenCalledWith(
      'id, handle, bio, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at'
    )
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('honors the current privacy switch without reading the edge table', async () => {
    const targetQuery = makeQuery({
      data: activeTarget({ show_followers: false }),
      error: null,
    })
    mockFrom.mockReturnValueOnce(targetQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/users/alice/follow?list=followers'),
      { params: Promise.resolve({ handle: 'alice' }) }
    )
    const body = await response.json()

    expect(body).toMatchObject({ followers: [], hidden: true })
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('binds default counts to the currently authorized profile id', async () => {
    const targetQuery = makeQuery({ data: activeTarget(), error: null })
    mockFrom.mockReturnValueOnce(targetQuery)

    const response = await GET(new NextRequest('http://localhost/api/users/ALICE/follow'), {
      params: Promise.resolve({ handle: 'ALICE' }),
    })
    const body = await response.json()

    expect(mockReadAudience).toHaveBeenCalledWith(expect.anything(), 'ALICE')
    expect(targetQuery.eq).toHaveBeenCalledWith('id', TARGET_ID)
    expect(body).toEqual({ followers_count: 2, following_count: 1 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
