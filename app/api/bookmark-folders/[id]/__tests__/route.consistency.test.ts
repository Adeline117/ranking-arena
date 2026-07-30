/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockAdminRpc = jest.fn()
const mockCreateUserScopedServerClient = jest.fn()
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockAdminRpc(...args),
}

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: { id: USER_ID }, supabase: mockSupabase, request }),
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: { id: USER_ID }, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/supabase/user-scoped-server', () => ({
  createUserScopedServerClient: (...args: unknown[]) => mockCreateUserScopedServerClient(...args),
}))

class MockTestResponse {
  constructor(
    private readonly body: unknown,
    readonly status: number
  ) {}

  async json() {
    return this.body
  }
}

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown, status = 200) => new MockTestResponse({ success: true, data }, status),
  badRequest: (message: string) =>
    new MockTestResponse({ success: false, error: { message } }, 400),
  conflict: (message: string) => new MockTestResponse({ success: false, error: { message } }, 409),
  forbidden: (message: string) => new MockTestResponse({ success: false, error: { message } }, 403),
  notFound: (message: string) => new MockTestResponse({ success: false, error: { message } }, 404),
  error: (message: string, status: number, code: string) =>
    new MockTestResponse({ success: false, error: { code, message } }, status),
  handleError: () =>
    new MockTestResponse({ success: false, error: { message: 'Internal server error' } }, 500),
}))

import { DELETE, GET, PATCH } from '../route'

function request(
  method: 'GET' | 'PATCH' | 'DELETE' = 'GET',
  body: unknown = { name: 'Renamed' }
): Request {
  return {
    url: `https://www.arenafi.org/api/bookmark-folders/${FOLDER_ID}`,
    method,
    json: async () => body,
  } as Request
}

const context = { params: Promise.resolve({ id: FOLDER_ID }) }
const invalidContext = { params: Promise.resolve({ id: 'not-a-uuid' }) }

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: FOLDER_ID,
    user_id: OWNER_ID,
    name: 'Public list',
    description: null,
    avatar_url: null,
    is_public: true,
    is_default: false,
    post_count: 0,
    subscriber_count: 0,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

function detailFolder(overrides: Record<string, unknown> = {}) {
  return {
    ...folder(),
    owner_handle: 'owner',
    owner_avatar_url: null,
    ...overrides,
  }
}

function detailPost(overrides: Record<string, unknown> = {}) {
  return {
    bookmark_id: '44444444-4444-4444-8444-444444444444',
    bookmarked_at: '2026-07-29T03:00:00Z',
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Visible post',
    content: 'Content',
    author_id: OWNER_ID,
    author_handle: 'owner',
    group_id: null,
    like_count: 1,
    comment_count: 2,
    bookmark_count: 3,
    created_at: '2026-07-29T02:00:00Z',
    ...overrides,
  }
}

function detailAck(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    actor_id: USER_ID,
    folder: detailFolder(),
    posts: [],
    is_owner: false,
    is_subscribed: false,
    pagination: { limit: 20, offset: 0, has_more: false },
    ...overrides,
  }
}

describe('/api/bookmark-folders/[id] consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateUserScopedServerClient.mockReturnValue({ rpc: mockRpc })
    mockRpc.mockResolvedValue({ data: null, error: null })
    mockAdminRpc.mockResolvedValue({ data: null, error: null })
  })

  it.each([
    ['GET', GET],
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as const)('rejects an invalid folder id before a %s database call', async (method, handler) => {
    const response = await handler(request(method), invalidContext)

    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('distinguishes a database failure from a missing folder', async () => {
    mockAdminRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'database unavailable' },
    })

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('keeps a genuine no-row result as not found', async () => {
    mockAdminRpc.mockResolvedValueOnce({ data: { status: 'folder_not_found' }, error: null })

    const response = await GET(request(), context)

    expect(response.status).toBe(404)
  })

  it('does not turn an unavailable subscriber count into zero', async () => {
    mockAdminRpc.mockResolvedValueOnce({
      data: detailAck({ folder: detailFolder({ subscriber_count: null }) }),
      error: null,
    })

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('does not turn a subscription lookup failure into not subscribed', async () => {
    mockAdminRpc.mockResolvedValueOnce({
      data: detailAck({
        folder: detailFolder({ subscriber_count: 0 }),
        is_subscribed: true,
      }),
      error: null,
    })

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('does not turn a bookmark page failure into an empty folder', async () => {
    mockAdminRpc.mockResolvedValueOnce({
      data: detailAck({ posts: null }),
      error: null,
    })

    const response = await GET(request(), context)

    expect(response.status).toBe(500)
  })

  it('reads one audience-filtered snapshot without touching raw service-role tables', async () => {
    mockAdminRpc.mockResolvedValueOnce({
      data: detailAck({
        folder: detailFolder({ post_count: 1 }),
        posts: [detailPost()],
      }),
      error: null,
    })

    const response = await GET(request(), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.posts).toEqual([detailPost()])
    expect(body.data.pagination).toEqual({ limit: 20, offset: 0, has_more: false })
    expect(mockAdminRpc).toHaveBeenCalledWith('read_bookmark_folder_detail_snapshot', {
      p_actor_id: USER_ID,
      p_folder_id: FOLDER_ID,
      p_limit: 20,
      p_offset: 0,
    })
    expect(mockAdminRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()

    const source = readFileSync(
      resolve(process.cwd(), 'app/api/bookmark-folders/[id]/route.ts'),
      'utf8'
    )
    const getHandler = source.slice(
      source.indexOf('export async function GET'),
      source.indexOf('// 更新收藏夹信息')
    )
    expect(getHandler).not.toContain('.from(')
    expect(getHandler).toContain(".rpc('read_bookmark_folder_detail_snapshot'")
  })

  it('returns 503 when the detail snapshot authority is not deployed', async () => {
    mockAdminRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    })

    const response = await GET(request(), context)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it.each([
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as const)(
    'does not report a %s authority failure as folder-not-found',
    async (method, handler) => {
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'XX000', message: 'database unavailable' },
      })

      const response = await handler(request(method), context)

      expect(response.status).toBe(500)
    }
  )

  it('updates only fields that were explicitly present', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        user_id: USER_ID,
        folder: folder({ user_id: USER_ID, description: 'Updated description' }),
      },
      error: null,
    })

    const mutationRequest = request('PATCH', { description: 'Updated description' })
    const response = await PATCH(mutationRequest, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.folder.description).toBe('Updated description')
    expect(mockCreateUserScopedServerClient).toHaveBeenCalledWith(mutationRequest)
    expect(mockRpc).toHaveBeenCalledWith('mutate_bookmark_folder_atomic', {
      p_action: 'update',
      p_folder_id: FOLDER_ID,
      p_name: null,
      p_description: 'Updated description',
      p_avatar_url: null,
      p_is_public: null,
      p_set_name: false,
      p_set_description: true,
      p_set_avatar_url: false,
      p_set_is_public: false,
    })
    expect(mockAdminRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('preserves explicit null as a request to clear a nullable field', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        user_id: USER_ID,
        folder: folder({ user_id: USER_ID, description: null }),
      },
      error: null,
    })

    const response = await PATCH(request('PATCH', { description: null }), context)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'mutate_bookmark_folder_atomic',
      expect.objectContaining({
        p_description: null,
        p_set_description: true,
        p_set_name: false,
      })
    )
  })

  it.each([{}, { ignored: true }])('rejects a PATCH without supported fields: %p', async (body) => {
    const response = await PATCH(request('PATCH', body), context)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([null, [], 'folder'])('rejects a non-object PATCH body: %p', async (body) => {
    const response = await PATCH(request('PATCH', body), context)

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('does not treat an omitted name as an explicit null name', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        user_id: USER_ID,
        folder: folder({ user_id: USER_ID, is_public: false }),
      },
      error: null,
    })

    const response = await PATCH(request('PATCH', { is_public: false }), context)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'mutate_bookmark_folder_atomic',
      expect.objectContaining({ p_name: null, p_set_name: false, p_is_public: false })
    )
  })

  it.each([
    ['account_inactive', 403],
    ['folder_not_found', 404],
    ['folder_forbidden', 403],
    ['default_protected', 400],
    ['name_conflict', 409],
  ])('maps PATCH authority status %s to HTTP %i', async (status, expectedStatus) => {
    mockRpc.mockResolvedValueOnce({ data: { status }, error: null })

    const response = await PATCH(request('PATCH'), context)

    expect(response.status).toBe(expectedStatus)
  })

  it.each([
    ['account_inactive', 403],
    ['folder_not_found', 404],
    ['folder_forbidden', 403],
    ['default_protected', 400],
  ])('maps DELETE authority status %s to HTTP %i', async (status, expectedStatus) => {
    mockRpc.mockResolvedValueOnce({ data: { status }, error: null })

    const response = await DELETE(request('DELETE'), context)

    expect(response.status).toBe(expectedStatus)
  })

  it.each([
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as const)('returns 503 when the %s authority is not deployed', async (method, handler) => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    })

    const response = await handler(request(method), context)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it.each([
    ['PATCH', PATCH],
    ['DELETE', DELETE],
  ] as const)(
    'fails closed if %s reaches the post-auth handler without a verified bearer',
    async (method, handler) => {
      mockCreateUserScopedServerClient.mockImplementationOnce(() => {
        throw new Error('A verified bearer token is required for an RLS-scoped query')
      })

      const response = await handler(request(method), context)

      expect(response.status).toBe(500)
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockAdminRpc).not.toHaveBeenCalled()
    }
  )

  it('fails closed when an update acknowledgement names another actor or folder', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        user_id: USER_ID,
        folder: folder({ id: OWNER_ID, user_id: USER_ID }),
      },
      error: null,
    })

    const response = await PATCH(request('PATCH'), context)

    expect(response.status).toBe(500)
  })

  it('fails closed when an acknowledgement contains unexpected keys', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        status: 'updated',
        user_id: USER_ID,
        folder: folder({ user_id: USER_ID }),
        injected: true,
      },
      error: null,
    })

    const response = await PATCH(request('PATCH'), context)

    expect(response.status).toBe(500)
  })

  it('deletes through one atomic authority call and validates the exact acknowledgement', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { status: 'deleted', user_id: USER_ID, folder_id: FOLDER_ID },
      error: null,
    })

    const response = await DELETE(request('DELETE'), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.message).toBe('Folder deleted')
    expect(mockRpc).toHaveBeenCalledWith('mutate_bookmark_folder_atomic', {
      p_action: 'delete',
      p_folder_id: FOLDER_ID,
      p_name: null,
      p_description: null,
      p_avatar_url: null,
      p_is_public: null,
      p_set_name: false,
      p_set_description: false,
      p_set_avatar_url: false,
      p_set_is_public: false,
    })
    expect(mockAdminRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when delete acknowledgement identity does not match the request', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { status: 'deleted', user_id: USER_ID, folder_id: OWNER_ID },
      error: null,
    })

    const response = await DELETE(request('DELETE'), context)

    expect(response.status).toBe(500)
  })
})
