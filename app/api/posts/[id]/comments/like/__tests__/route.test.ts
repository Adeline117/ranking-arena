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
const mockUser = { id: 'user-1', email: 'test@test.com' }

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

import { NextRequest } from 'next/server'
import { POST } from '../route'

const POST_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const COMMENT_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

function request(body: unknown, postId = POST_ID) {
  return new NextRequest(`http://localhost/api/posts/${postId}/comments/like`, {
    method: 'POST',
    body,
  })
}

describe('POST /api/posts/[id]/comments/like canonical contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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

    const response = await POST(request({ comment_id: COMMENT_ID }))

    expect(response.status).toBe(401)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('calls the atomic RPC exactly once and preserves its strict result', async () => {
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

    const response = await POST(request({ comment_id: COMMENT_ID, type: 'dislike' }))

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('toggle_comment_reaction', {
      p_post_id: POST_ID,
      p_comment_id: COMMENT_ID,
      p_user_id: mockUser.id,
      p_reaction_type: 'dislike',
    })
    expect(await response.json()).toEqual({
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

  it('keeps omitted reaction type backwards-compatible as a like', async () => {
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

    const response = await POST(request({ comment_id: COMMENT_ID }))

    expect(response.status).toBe(status)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    { liked: true },
    {
      liked: true,
      disliked: true,
      like_count: 3,
      dislike_count: 1,
      reaction: 'like',
    },
    {
      liked: true,
      disliked: false,
      like_count: 3,
      dislike_count: 1,
      reaction: null,
    },
    {
      liked: false,
      disliked: true,
      like_count: 2,
      dislike_count: 2,
      reaction: 'dislike',
    },
    {
      liked: true,
      disliked: false,
      like_count: 3,
      dislike_count: 1,
    },
  ])('fails closed for malformed or contradictory RPC result %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request({ comment_id: COMMENT_ID }))

    expect(response.status).toBe(500)
  })
})
