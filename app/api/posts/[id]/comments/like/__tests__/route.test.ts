jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
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
    private readonly body: unknown
    constructor(
      url: string,
      options?: { headers?: Record<string, string>; method?: string; body?: unknown }
    ) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(
        Object.entries({ 'user-agent': 'Jest Test Runner', ...options?.headers })
      )
      this.method = options?.method ?? 'POST'
      this.body = options?.body
    }
    async json() {
      return typeof this.body === 'string' ? JSON.parse(this.body) : this.body
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockRpc = jest.fn()
let mockAuthenticated = true
const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const COMMENT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const REQUEST_ID = '0123456789abcdef0123456789abcdef'
const RESPONSE_TIMESTAMP = '2026-08-03T21:30:00.000Z'
const mockUser = { id: ACTOR_ID, email: 'test@test.com' }

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => async (request: unknown) => {
    if (!mockAuthenticated) {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return handler({
      user: mockUser,
      supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
      request,
      version: { current: 'v1' },
    })
  },
}))

jest.mock('@/lib/api', () => ({
  success: (data: unknown, status = 200, headers: Record<string, string> = {}) => ({
    status,
    _body: { success: true, data, meta: { timestamp: RESPONSE_TIMESTAMP } },
    async json() {
      return this._body
    },
    headers: new Map(Object.entries(headers)),
  }),
}))

jest.mock('@/lib/features', () => ({
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const LIKE_REQUEST = {
  operation: 'set_reaction',
  request_id: REQUEST_ID,
  comment_id: COMMENT_ID,
  desired_reaction: 'like',
} as const

function request(body: unknown, postId = POST_ID) {
  return new NextRequest(`http://localhost/api/posts/${postId}/comments/like`, {
    method: 'POST',
    body,
  })
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    status: 'added',
    action: 'added',
    liked: true,
    disliked: false,
    like_count: 3,
    dislike_count: 1,
    reaction: 'like',
    ...overrides,
  }
}

describe('POST /api/posts/[id]/comments/like desired-state contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthenticated = true
    mockUser.id = ACTOR_ID
    mockRpc.mockResolvedValue({ data: result(), error: null })
  })

  it('requires authentication through the shared write middleware', async () => {
    mockAuthenticated = false

    const response = await POST(request(LIKE_REQUEST))

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('calls the desired-state RPC once and returns an identity-bound receipt', async () => {
    mockRpc.mockResolvedValue({
      data: result({
        status: 'changed',
        action: 'changed',
        liked: false,
        disliked: true,
        like_count: 2,
        dislike_count: 2,
        reaction: 'dislike',
      }),
      error: null,
    })

    const response = await POST(request({ ...LIKE_REQUEST, desired_reaction: 'dislike' as const }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('set_comment_reaction_desired_state_atomic', {
      p_actor_id: ACTOR_ID,
      p_post_id: POST_ID,
      p_comment_id: COMMENT_ID,
      p_desired_reaction: 'dislike',
    })
    expect(await response.json()).toEqual({
      success: true,
      data: {
        actor_id: ACTOR_ID,
        post_id: POST_ID,
        comment_id: COMMENT_ID,
        request_id: REQUEST_ID,
        operation: 'set_reaction',
        desired_reaction: 'dislike',
        action: 'changed',
        reaction: 'dislike',
        liked: false,
        disliked: true,
        like_count: 2,
        dislike_count: 2,
      },
      meta: { timestamp: RESPONSE_TIMESTAMP },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it.each([
    [
      'removes an existing reaction',
      result({
        status: 'removed',
        action: 'removed',
        liked: false,
        reaction: null,
        like_count: 2,
      }),
      'removed',
    ],
    [
      'replays an absent state without toggling',
      result({
        status: 'unchanged',
        action: 'unchanged',
        liked: false,
        reaction: null,
        like_count: 2,
      }),
      'unchanged',
    ],
  ])('%s', async (_name, rpcResult, action) => {
    mockRpc.mockResolvedValue({ data: rpcResult, error: null })

    const response = await POST(request({ ...LIKE_REQUEST, desired_reaction: null }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'set_comment_reaction_desired_state_atomic',
      expect.objectContaining({ p_desired_reaction: null })
    )
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          request_id: REQUEST_ID,
          desired_reaction: null,
          action,
          reaction: null,
        }),
      })
    )
  })

  it.each([
    ['invalid post ID', LIKE_REQUEST, 'not-a-uuid'],
    ['invalid comment ID', { ...LIKE_REQUEST, comment_id: 'not-a-uuid' }, POST_ID],
    ['missing operation', { ...LIKE_REQUEST, operation: undefined }, POST_ID],
    ['legacy toggle body', { comment_id: COMMENT_ID, type: 'like' }, POST_ID],
    ['missing desired state', { ...LIKE_REQUEST, desired_reaction: undefined }, POST_ID],
    ['unknown desired state', { ...LIKE_REQUEST, desired_reaction: 'love' }, POST_ID],
    ['invalid request identity', { ...LIKE_REQUEST, request_id: 'bad' }, POST_ID],
    ['uppercase request identity', { ...LIKE_REQUEST, request_id: 'A'.repeat(32) }, POST_ID],
    ['unexpected body field', { ...LIKE_REQUEST, admin: true }, POST_ID],
    ['non-object body', ['not', 'an', 'object'], POST_ID],
  ])('rejects %s without invoking the RPC', async (_label, body, postId) => {
    const response = await POST(request(body, postId))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON without invoking the RPC', async () => {
    const response = await POST(request('{'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['P0002', 404],
    ['23503', 404],
    ['22023', 400],
    ['23514', 409],
    ['40001', 409],
    ['40P01', 409],
    ['42501', 403],
    ['PGRST202', 500],
    ['42883', 500],
    ['XX000', 500],
  ])('maps database error %s to HTTP %i without direct-write fallback', async (code, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'private detail' } })

    const response = await POST(request(LIKE_REQUEST))

    expect(response.status).toBe(status)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it.each([
    ['not_found', 404],
    ['invalid', 400],
  ])('maps exact %s sentinel to HTTP %i', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request(LIKE_REQUEST))

    expect(response.status).toBe(expectedStatus)
  })

  it.each([
    result({ status: 'changed' }),
    { action: 'added', liked: true },
    result({ liked: true, disliked: true }),
    result({ action: 'removed', status: 'removed', reaction: 'like' }),
    result({ action: 'added', status: 'added', reaction: null, liked: false }),
    result({ action: 'added', status: 'added', reaction: 'dislike' }),
    result({ like_count: -1 }),
    result({ dislike_count: 1.5 }),
    result({ like_count: 0 }),
    { status: 'not_found', invented: true },
    result({ invented: true }),
  ])('fails closed for malformed or contradictory RPC result %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request(LIKE_REQUEST))

    expect(response.status).toBe(500)
  })

  it('rejects a malformed authenticated actor before invoking the RPC', async () => {
    mockUser.id = 'not-a-user-id'

    const response = await POST(request(LIKE_REQUEST))

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
