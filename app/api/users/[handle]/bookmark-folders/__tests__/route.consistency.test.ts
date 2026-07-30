/** @jest-environment node */

const PROFILE_ID = '11111111-1111-4111-8111-111111111111'
const VIEWER_ID = '22222222-2222-4222-8222-222222222222'

const mockFrom = jest.fn()
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
  getSupabaseAdmin: () => ({ from: (...args: unknown[]) => mockFrom(...args) }),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { read: {} },
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

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'order']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.then = jest.fn(
    (resolveResult: (value: QueryResult) => unknown, rejectResult: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolveResult, rejectResult)
  )
  return builder
}

import { GET } from '../route'

const request = {} as never
const context = { params: Promise.resolve({ handle: 'alice' }) }

describe('GET /api/users/[handle]/bookmark-folders consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: VIEWER_ID })
    mockReadAudience.mockResolvedValue({
      status: 'active',
      profile: { id: PROFILE_ID },
    })
  })

  it('fails closed instead of reporting an unavailable folder read as an empty profile', async () => {
    mockFrom.mockReturnValueOnce(
      query({ data: null, error: { code: 'XX000', message: 'folder store unavailable' } })
    )

    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.data?.folders).toBeUndefined()
  })

  it('rejects a null folder payload even when the database omits an error', async () => {
    mockFrom.mockReturnValueOnce(query({ data: null, error: null }))

    const response = await GET(request, context)

    expect(response.status).toBe(500)
  })

  it('keeps a genuine empty array as an authoritative empty profile', async () => {
    const folderQuery = query({ data: [], error: null })
    mockFrom.mockReturnValueOnce(folderQuery)

    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ folders: [], is_own_profile: false })
    expect(folderQuery.eq).toHaveBeenCalledWith('user_id', PROFILE_ID)
    expect(folderQuery.eq).toHaveBeenCalledWith('is_public', true)
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
  })

  it('allows the owner query to include private folders', async () => {
    mockGetAuthUser.mockResolvedValue({ id: PROFILE_ID })
    const folderQuery = query({
      data: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'Private',
          is_public: false,
        },
      ],
      error: null,
    })
    mockFrom.mockReturnValueOnce(folderQuery)

    const response = await GET(request, context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.is_own_profile).toBe(true)
    expect(folderQuery.eq).not.toHaveBeenCalledWith('is_public', true)
  })
})
