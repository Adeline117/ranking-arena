import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Map<string, string>
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {}
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const POST_ID = '22222222-2222-4222-8222-222222222222'
const mockSupabase = { marker: 'canonical-admin-client' }
let mockMiddlewareResponse: NextResponse | null = null

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string; email: string }
        supabase: typeof mockSupabase
        request: NextRequest
      }) => Promise<NextResponse>
    ) =>
    async (request: NextRequest) => {
      if (mockMiddlewareResponse) return mockMiddlewareResponse
      return handler({
        user: { id: ACTOR_ID, email: 'actor@example.test' },
        supabase: mockSupabase,
        request,
      })
    },
}))

jest.mock('@/lib/data/posts', () => {
  class PostInteractionMutationError extends Error {
    constructor(public readonly kind: 'not_found' | 'invalid' | 'invalid_ack') {
      super(kind)
    }
  }
  return {
    togglePostReaction: jest.fn(),
    getPostById: jest.fn(),
    PostInteractionMutationError,
  }
})
jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))
jest.mock('@/lib/utils/server-cache', () => ({ deleteServerCacheByPrefix: jest.fn() }))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: jest.fn().mockReturnValue(null) }))
jest.mock('@/lib/supabase/server', () => ({
  getUserHandle: jest.fn().mockResolvedValue('actor'),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: jest.fn(),
  createLogger: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

const { togglePostReaction, getPostById, PostInteractionMutationError } =
  jest.requireMock('@/lib/data/posts')

function request(body: unknown, raw = false): NextRequest {
  return {
    method: 'POST',
    json: async () => {
      if (raw) throw new SyntaxError('Invalid JSON body')
      return body
    },
  } as NextRequest
}

async function invoke(body: unknown, postId = POST_ID, raw = false) {
  const { POST } = await import('../route')
  return POST(request(body, raw), { params: Promise.resolve({ id: postId }) })
}

describe('POST /api/posts/[id]/like canonical receipt', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMiddlewareResponse = null
    togglePostReaction.mockResolvedValue({
      action: 'added',
      reaction: 'up',
      like_count: 5,
      dislike_count: 1,
    })
    getPostById.mockResolvedValue({
      id: POST_ID,
      author_id: '33333333-3333-4333-8333-333333333333',
      title: 'Test Post',
    })
  })

  it('returns the exact actor, post and requested-reaction receipt', async () => {
    const response = await invoke({ reaction_type: 'up' })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['data', 'meta', 'success'])
    expect(Object.keys(body.data).sort()).toEqual(
      [
        'action',
        'actor_id',
        'dislike_count',
        'like_count',
        'post_id',
        'reaction',
        'requested_reaction',
      ].sort()
    )
    expect(body).toMatchObject({
      success: true,
      data: {
        actor_id: ACTOR_ID,
        post_id: POST_ID,
        requested_reaction: 'up',
        action: 'added',
        reaction: 'up',
        like_count: 5,
        dislike_count: 1,
      },
      meta: { timestamp: expect.any(String) },
    })
    expect(togglePostReaction).toHaveBeenCalledWith(mockSupabase, POST_ID, ACTOR_ID, 'up')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('binds a down-reaction change to the submitted desired toggle', async () => {
    togglePostReaction.mockResolvedValue({
      action: 'changed',
      reaction: 'down',
      like_count: 4,
      dislike_count: 2,
    })

    const response = await invoke({ reaction_type: 'down' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      data: {
        actor_id: ACTOR_ID,
        post_id: POST_ID,
        requested_reaction: 'down',
        action: 'changed',
        reaction: 'down',
        like_count: 4,
        dislike_count: 2,
      },
    })
    expect(togglePostReaction).toHaveBeenCalledWith(mockSupabase, POST_ID, ACTOR_ID, 'down')
  })

  it.each([
    ['a missing reaction', {}],
    ['a null body', null],
    ['an unknown reaction', { reaction_type: 'love' }],
    ['an extra field', { reaction_type: 'up', post_id: POST_ID }],
  ])('rejects %s without mutating', async (_name, body) => {
    const response = await invoke(body)

    expect(response.status).toBe(400)
    expect(togglePostReaction).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('rejects non-JSON without mutating', async () => {
    const response = await invoke('{broken', POST_ID, true)

    expect(response.status).toBe(400)
    expect(togglePostReaction).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('rejects an invalid post identity before parsing the body or mutating', async () => {
    const response = await invoke({ reaction_type: 'up' }, 'post-1')

    expect(response.status).toBe(400)
    expect(togglePostReaction).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it.each([
    ['not_found', 404, 'Post not found'],
    ['invalid', 400, 'Invalid reaction request'],
  ] as const)(
    'maps the atomic %s result without issuing a receipt',
    async (kind, status, error) => {
      togglePostReaction.mockRejectedValue(new PostInteractionMutationError(kind))

      const response = await invoke({ reaction_type: 'up' })

      expect(response.status).toBe(status)
      await expect(response.json()).resolves.toEqual({ success: false, error })
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    }
  )

  it('marks a rate-limited response private and non-cacheable', async () => {
    mockMiddlewareResponse = NextResponse.json(
      { success: false, error: 'Slow down' },
      { status: 429 }
    )

    const response = await invoke({ reaction_type: 'up' })

    expect(response.status).toBe(429)
    expect(togglePostReaction).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })
})
