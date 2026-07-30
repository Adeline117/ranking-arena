/** @jest-environment node */

const PROFILE_ID = '11111111-1111-4111-8111-111111111111'
const VIEWER_ID = '22222222-2222-4222-8222-222222222222'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockGetAuthUser = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockReadAudience = jest.fn()

class MockResponse {
  readonly headers: Headers

  constructor(
    private readonly body: unknown,
    readonly status: number,
    headers: Record<string, string> = {}
  ) {
    this.headers = new Headers(headers)
  }

  async json() {
    return this.body
  }
}

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
  ErrorCode: { SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE' },
  forbidden: (message: string) => new MockResponse({ success: false, error: { message } }, 403),
  error: (message: string, status: number, code: string) =>
    new MockResponse({ success: false, error: { code, message } }, status),
  success: (data: unknown, status = 200, headers?: Record<string, string>) =>
    new MockResponse({ success: true, data }, status, headers),
  handleError: () =>
    new MockResponse({ success: false, error: { message: 'Internal server error' } }, 500, {
      'Cache-Control': 'private, no-store, max-age=0',
    }),
}))

jest.mock('@/lib/profile/public-audience', () => ({
  readPublicProfileAudienceByHandle: (...args: unknown[]) => mockReadAudience(...args),
}))

import { GET } from '../route'

const request = {} as never
const context = { params: Promise.resolve({ handle: 'alice' }) }

function folder(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: PROFILE_ID,
    name: 'Public',
    description: null,
    avatar_url: null,
    is_public: true,
    is_default: false,
    post_count: 2,
    subscriber_count: 3,
    created_at: '2026-07-29T00:00:00Z',
    updated_at: '2026-07-29T00:00:00Z',
    ...overrides,
  }
}

function snapshot(folders: unknown[], actorId: string | null = VIEWER_ID, includePrivate = false) {
  return {
    status: 'ok',
    actor_id: actorId,
    profile_id: PROFILE_ID,
    include_private: includePrivate,
    folders,
  }
}

describe('GET /api/users/[handle]/bookmark-folders consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: VIEWER_ID })
    mockReadAudience.mockResolvedValue({
      status: 'active',
      profile: { id: PROFILE_ID },
    })
    mockRpc.mockResolvedValue({ data: snapshot([]), error: null })
  })

  it('fails closed instead of reporting an unavailable folder read as an empty profile', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX000', message: 'folder store unavailable' },
    })

    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.data?.folders).toBeUndefined()
  })

  it('rejects a null folder payload even when the database omits an error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null })

    const response = await GET(request, context)

    expect(response.status).toBe(500)
  })

  it('keeps a genuine empty array as an authoritative empty profile', async () => {
    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ folders: [], is_own_profile: false })
    expect(mockRpc).toHaveBeenCalledWith('read_profile_bookmark_folders_snapshot', {
      p_actor_id: VIEWER_ID,
      p_profile_id: PROFILE_ID,
      p_include_private: false,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('does not read folder storage for an inactive profile', async () => {
    mockReadAudience.mockResolvedValue({
      status: 'inactive',
      profile: { id: PROFILE_ID },
    })

    const response = await GET(request, context)

    expect(response.status).toBe(404)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('allows the owner query to include private folders', async () => {
    mockGetAuthUser.mockResolvedValue({ id: PROFILE_ID })
    mockRpc.mockResolvedValueOnce({
      data: snapshot([folder({ name: 'Private', is_public: false })], PROFILE_ID, true),
      error: null,
    })

    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.is_own_profile).toBe(true)
    expect(mockRpc).toHaveBeenCalledWith('read_profile_bookmark_folders_snapshot', {
      p_actor_id: PROFILE_ID,
      p_profile_id: PROFILE_ID,
      p_include_private: true,
    })
  })

  it('rechecks the target profile in the folder snapshot', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'profile_not_found' }, error: null })

    const response = await GET(request, context)

    expect(response.status).toBe(404)
  })

  it('returns 503 when the profile snapshot authority is unavailable', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    })

    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
  })
})
