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
const INTENT_SEQUENCE = '42'
const EXPIRES_AT = '2026-08-03T21:35:00.000Z'
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

const INTENT_REQUEST = {
  operation: 'reserve_reaction_intent',
  request_id: REQUEST_ID,
  comment_id: COMMENT_ID,
  desired_reaction: 'like',
} as const

function request(body: unknown, postId = POST_ID) {
  return new NextRequest(`http://localhost/api/posts/${postId}/comments/like/intents`, {
    method: 'POST',
    body,
  })
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    status: 'issued',
    intent_sequence: INTENT_SEQUENCE,
    expires_at: EXPIRES_AT,
    ...overrides,
  }
}

describe('POST /api/posts/[id]/comments/like/intents', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAuthenticated = true
    mockUser.id = ACTOR_ID
    mockRpc.mockResolvedValue({ data: result(), error: null })
  })

  it('requires authentication before reserving an intent', async () => {
    mockAuthenticated = false
    const response = await POST(request(INTENT_REQUEST))
    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['issued', false],
    ['replayed', true],
  ] as const)('returns an exact identity-bound %s receipt', async (status, replayed) => {
    mockRpc.mockResolvedValue({ data: result({ status }), error: null })

    const response = await POST(request(INTENT_REQUEST))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('reserve_comment_reaction_intent_atomic', {
      p_actor_id: ACTOR_ID,
      p_post_id: POST_ID,
      p_comment_id: COMMENT_ID,
      p_request_id: REQUEST_ID,
      p_desired_reaction: 'like',
    })
    expect(await response.json()).toEqual({
      success: true,
      data: {
        actor_id: ACTOR_ID,
        post_id: POST_ID,
        comment_id: COMMENT_ID,
        request_id: REQUEST_ID,
        operation: 'reserve_reaction_intent',
        desired_reaction: 'like',
        status,
        intent_sequence: INTENT_SEQUENCE,
        expires_at: EXPIRES_AT,
        replayed,
      },
      meta: { timestamp: RESPONSE_TIMESTAMP },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it.each([
    ['bad post id', INTENT_REQUEST, 'bad'],
    ['bad comment id', { ...INTENT_REQUEST, comment_id: 'bad' }, POST_ID],
    ['bad request id', { ...INTENT_REQUEST, request_id: 'bad' }, POST_ID],
    ['wrong operation', { ...INTENT_REQUEST, operation: 'set_reaction' }, POST_ID],
    ['missing desired state', { ...INTENT_REQUEST, desired_reaction: undefined }, POST_ID],
    ['extra field', { ...INTENT_REQUEST, intent_sequence: '1' }, POST_ID],
  ])('rejects %s without RPC', async (_label, body, postId) => {
    const response = await POST(request(body, postId))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['stale', 409, 'COMMENT_REACTION_STALE'],
    ['expired', 410, 'COMMENT_REACTION_EXPIRED'],
    ['unknown_ticket', 409, 'COMMENT_REACTION_UNKNOWN_TICKET'],
    ['operation_conflict', 409, 'COMMENT_REACTION_OPERATION_CONFLICT'],
    ['too_many_pending', 429, 'COMMENT_REACTION_TOO_MANY_PENDING'],
    ['invalid', 400, 'COMMENT_REACTION_INVALID'],
    ['not_found', 404, 'COMMENT_REACTION_NOT_FOUND'],
  ])('maps exact %s sentinel to a strict machine failure', async (sentinel, status, code) => {
    mockRpc.mockResolvedValue({ data: { status: sentinel }, error: null })
    const response = await POST(request(INTENT_REQUEST))
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ success: false, code, error: expect.any(String) })
  })

  it.each([
    result({ invented: true }),
    result({ status: 'unknown' }),
    result({ intent_sequence: '0' }),
    result({ intent_sequence: 42 }),
    result({ expires_at: '2026-08-03T21:35:00+00:00' }),
    { status: 'stale', invented: true },
  ])('fails closed for malformed RPC result %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })
    const response = await POST(request(INTENT_REQUEST))
    expect(response.status).toBe(500)
  })

  it.each([
    ['P0002', 404],
    ['23503', 404],
    ['22023', 400],
    ['23514', 409],
    ['40001', 409],
    ['40P01', 409],
    ['42501', 403],
    ['42883', 500],
  ])('maps database error %s without fallback', async (code, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: 'private' } })
    const response = await POST(request(INTENT_REQUEST))
    expect(response.status).toBe(status)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
