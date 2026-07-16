/** @jest-environment node */

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockCanServiceActorReadPost = jest.fn()
const mockUser = { id: '11111111-1111-4111-8111-111111111111' }
let mockPublicUser: typeof mockUser | null = mockUser
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
  withPublic:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockPublicUser, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...args: unknown[]) => mockCanServiceActorReadPost(...args),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}))

import { GET, POST } from '../route'

const POST_ID = '22222222-2222-4222-8222-222222222222'

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'delete', 'insert']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.maybeSingle = jest.fn().mockResolvedValue(result)
  builder.then = jest.fn((resolve: (value: QueryResult) => unknown) =>
    Promise.resolve(result).then(resolve)
  )
  return builder
}

function request(method: 'GET' | 'POST', options?: { auth?: string; body?: unknown }): Request {
  return {
    url: `https://www.arenafi.org/api/posts/${POST_ID}/emoji-react`,
    method,
    headers: new Headers(options?.auth ? { authorization: options.auth } : {}),
    json: async () => options?.body,
  } as Request
}

describe('/api/posts/[id]/emoji-react service audience boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPublicUser = mockUser
    mockCanServiceActorReadPost.mockResolvedValue(true)
    mockRpc.mockResolvedValue({
      data: {
        status: 'added',
        action: 'added',
        emoji: '🔥',
        counts: { '🔥': 1 },
        user_emojis: ['🔥'],
      },
      error: null,
    })
  })

  it('denies aggregate reads before touching reaction children', async () => {
    mockCanServiceActorReadPost.mockResolvedValue(false)

    const response = await GET(request('GET'))

    expect(response.status).toBe(404)
    expect(mockCanServiceActorReadPost).toHaveBeenCalledWith(mockSupabase, POST_ID, mockUser.id)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns only a canonically authorized viewer aggregate', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: [{ emoji: '🔥' }, { emoji: '🔥' }], error: null }))
      .mockReturnValueOnce(query({ data: [{ emoji: '🔥' }], error: null }))

    const response = await GET(request('GET'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ counts: { '🔥': 2 }, userEmojis: ['🔥'] })
  })

  it('rejects an invalid bearer token instead of downgrading child access to anonymous', async () => {
    mockPublicUser = null

    const response = await GET(request('GET', { auth: 'Bearer expired' }))

    expect(response.status).toBe(401)
    expect(mockCanServiceActorReadPost).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses the canonical atomic RPC and does not touch reaction tables directly', async () => {
    const response = await POST(request('POST', { body: { emoji: '🔥' } }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('toggle_post_emoji_reaction_atomic', {
      p_actor_id: mockUser.id,
      p_post_id: POST_ID,
      p_emoji: '🔥',
    })
    expect(body.data).toEqual({
      action: 'added',
      emoji: '🔥',
      counts: { '🔥': 1 },
      userEmojis: ['🔥'],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('denies a mutation when the atomic database audience decision denies', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_found' }, error: null })

    const response = await POST(request('POST', { body: { emoji: '🔥' } }))

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed for a malformed atomic acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: { status: 'added', action: 'added', emoji: '🔥', counts: { '🔥': -1 } },
      error: null,
    })

    const response = await POST(request('POST', { body: { emoji: '🔥' } }))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
