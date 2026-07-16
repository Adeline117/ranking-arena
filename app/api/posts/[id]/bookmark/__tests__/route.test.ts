/** @jest-environment node */

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockCanServiceActorReadPost = jest.fn()
const mockUser = { id: '11111111-1111-4111-8111-111111111111' }
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
  withApiMiddleware:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: mockUser, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  canServiceActorReadPost: (...args: unknown[]) => mockCanServiceActorReadPost(...args),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  apiLogger: { error: jest.fn() },
}))

import { GET, POST } from '../route'

const POST_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'
const context = { params: Promise.resolve({ id: POST_ID }) }

function request(method: 'GET' | 'POST', body?: unknown): Parameters<typeof GET>[0] {
  return {
    method,
    url: `https://www.arenafi.org/api/posts/${POST_ID}/bookmark`,
    json: async () => body,
  } as unknown as Parameters<typeof GET>[0]
}

describe('/api/posts/[id]/bookmark service audience boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCanServiceActorReadPost.mockResolvedValue(true)
    mockRpc.mockResolvedValue({
      data: {
        status: 'added',
        action: 'added',
        bookmarked: true,
        bookmark_count: 1,
        folder_id: FOLDER_ID,
      },
      error: null,
    })
  })

  it('does not query bookmark children when canonical read access is denied', async () => {
    mockCanServiceActorReadPost.mockResolvedValue(false)

    const response = await GET(request('GET'), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ bookmarked: false })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('toggles only through the actor-bound atomic RPC', async () => {
    const response = await POST(request('POST', { folder_id: FOLDER_ID }), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('toggle_post_bookmark_atomic', {
      p_actor_id: mockUser.id,
      p_post_id: POST_ID,
      p_folder_id: FOLDER_ID,
    })
    expect(body).toEqual({
      action: 'added',
      bookmarked: true,
      bookmark_count: 1,
      folder_id: FOLDER_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('maps an atomic audience denial to authoritative absence', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'not_found' }, error: null })

    const response = await POST(request('POST'), context)

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed for a malformed atomic acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: {
        status: 'added',
        action: 'added',
        bookmarked: true,
        bookmark_count: -1,
        folder_id: FOLDER_ID,
      },
      error: null,
    })

    const response = await POST(request('POST'), context)

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
