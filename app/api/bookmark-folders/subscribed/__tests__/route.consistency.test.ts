/** @jest-environment node */

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OWNER_ID = '22222222-2222-4222-8222-222222222222'
const FOLDER_ID = '33333333-3333-4333-8333-333333333333'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: Function) =>
    (request: Request): Promise<Response> =>
      handler({ user: { id: USER_ID }, supabase: mockSupabase, request }),
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
  forbidden: (message: string) => new MockTestResponse({ success: false, error: { message } }, 403),
  error: (message: string, status: number, code: string) =>
    new MockTestResponse({ success: false, error: { code, message } }, status),
  handleError: () =>
    new MockTestResponse({ success: false, error: { message: 'Internal server error' } }, 500),
}))

import { GET } from '../route'

function request(limit = 20): Request {
  return {
    url: `https://www.arenafi.org/api/bookmark-folders/subscribed?limit=${limit}`,
  } as Request
}

function folder(folderId = FOLDER_ID, overrides: Record<string, unknown> = {}) {
  return {
    id: folderId,
    user_id: OWNER_ID,
    name: 'Public list',
    description: null,
    avatar_url: null,
    is_public: true,
    is_default: false,
    post_count: 4,
    subscriber_count: 7,
    created_at: '2026-07-28T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    owner_id: OWNER_ID,
    owner_handle: 'owner',
    owner_avatar_url: null,
    subscribed_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

function snapshot(folders: unknown[], limit = 20, hasMore = false) {
  return {
    status: 'ok',
    actor_id: USER_ID,
    folders,
    pagination: { limit, offset: 0, has_more: hasMore },
  }
}

describe('/api/bookmark-folders/subscribed consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: snapshot([]), error: null })
  })

  it('does not report a missing subscription table as an empty list', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: '42P01', message: 'table missing' },
    })

    const response = await GET(request())

    expect(response.status).toBe(503)
  })

  it('does not publish owner-less folders when the owner lookup fails', async () => {
    mockRpc.mockResolvedValueOnce({
      data: snapshot([folder(FOLDER_ID, { owner_handle: undefined })]),
      error: null,
    })

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('does not fabricate a zero subscriber count on count failure', async () => {
    mockRpc.mockResolvedValueOnce({
      data: snapshot([folder(FOLDER_ID, { subscriber_count: null })]),
      error: null,
    })

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('returns exact subscriber counts and uses a lookahead row for pagination', async () => {
    mockRpc.mockResolvedValueOnce({
      data: snapshot([folder()], 1, true),
      error: null,
    })

    const response = await GET(request(1))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.folders).toHaveLength(1)
    expect(body.data.folders[0]).toMatchObject({
      id: FOLDER_ID,
      subscriber_count: 7,
      owner_handle: 'owner',
    })
    expect(body.data.pagination).toEqual({ limit: 1, offset: 0, has_more: true })
    expect(mockRpc).toHaveBeenCalledWith('read_subscribed_bookmark_folders_snapshot', {
      p_actor_id: USER_ID,
      p_limit: 1,
      p_offset: 0,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed on actor crossover in the snapshot', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { ...snapshot([]), actor_id: OWNER_ID },
      error: null,
    })

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('maps a current inactive actor without falling back to table reads', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'actor_inactive' }, error: null })

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
