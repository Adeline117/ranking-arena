jest.mock('next/server', () => {
  class MockNextResponse {
    readonly headers: Headers
    readonly status: number
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }

    async json() {
      return this.body
    }
  }

  class MockNextRequest {
    readonly headers: Headers
    readonly method = 'GET'
    readonly nextUrl: URL

    constructor(
      readonly url: string,
      init: { headers?: Record<string, string> } = {}
    ) {
      this.nextUrl = new URL(url)
      this.headers = new Headers(init.headers)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetPostsByHashtag = jest.fn()
const mockGetTrendingHashtags = jest.fn()

class MockApiError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

function mockJsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  const { NextResponse } = jest.requireMock<typeof import('next/server')>('next/server')
  return NextResponse.json(body, { status, headers })
}

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { public: { name: 'public-test-policy' } },
  success: (data: unknown) =>
    mockJsonResponse({ success: true, data }, 200, { Vary: 'Accept-Encoding' }),
  successWithPagination: (data: unknown, pagination: unknown) =>
    mockJsonResponse({ success: true, data, meta: { pagination } }, 200, {
      Vary: 'Accept-Encoding',
    }),
  unauthorized: (message: string) => mockJsonResponse({ success: false, error: { message } }, 401),
  validationError: (message: string) =>
    mockJsonResponse({ success: false, error: { message } }, 400),
  handleError: (error: unknown) =>
    mockJsonResponse(
      {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Internal server error' },
      },
      error instanceof MockApiError ? error.statusCode : 500
    ),
  validateNumber: (
    value: unknown,
    options: { min?: number; max?: number; integer?: boolean; fieldName?: string }
  ) => {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    if (
      !Number.isFinite(parsed) ||
      (options.integer && !Number.isInteger(parsed)) ||
      (options.min !== undefined && parsed < options.min) ||
      (options.max !== undefined && parsed > options.max)
    ) {
      throw new MockApiError(`Invalid ${options.fieldName ?? 'number'}`, 400)
    }
    return parsed
  },
  validateEnum: (value: unknown, allowed: readonly string[]) => {
    if (value === null || value === undefined || value === '') return null
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new MockApiError('Invalid enum', 400)
    }
    return value
  },
}))

jest.mock('@/lib/data/hashtags', () => ({
  HashtagViewerRejectedError: class HashtagViewerRejectedError extends Error {
    constructor() {
      super('Hashtag viewer is no longer active')
      this.name = 'HashtagViewerRejectedError'
    }
  },
  canonicalizeHashtag: (tag: string) => {
    const canonical = tag.trim().toLowerCase()
    if (!canonical || Array.from(canonical).length > 30 || !/^[\p{L}\p{N}_]+$/u.test(canonical)) {
      throw new TypeError('Invalid hashtag')
    }
    return canonical
  },
  getPostsByHashtag: (...args: unknown[]) => mockGetPostsByHashtag(...args),
  getTrendingHashtags: (...args: unknown[]) => mockGetTrendingHashtags(...args),
}))

import { NextRequest, NextResponse } from 'next/server'
import { GET as getHashtagPage } from '../[tag]/route'
import { GET as getTrending } from '../trending/route'

function tagRequest(query = '', headers?: Record<string, string>) {
  return new NextRequest(`http://localhost/api/hashtags/btc${query}`, { headers })
}

function tagParams(tag = 'btc') {
  return { params: Promise.resolve({ tag }) }
}

function expectPrivateNoStore(response: NextResponse) {
  expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vary')).toContain('Authorization')
}

describe('GET /api/hashtags/[tag]', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({ marker: 'admin-client' })
    mockGetAuthUser.mockResolvedValue(null)
    mockGetPostsByHashtag.mockResolvedValue({
      posts: [{ id: 'post-1' }],
      tag: 'btc',
      total: 1,
      has_more: false,
      next_cursor: null,
    })
  })

  it('binds anonymous and authenticated reads to the exact RPC viewer', async () => {
    const anonymous = await getHashtagPage(tagRequest(), tagParams(' BTC '))
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockGetPostsByHashtag).toHaveBeenNthCalledWith(1, { marker: 'admin-client' }, 'btc', {
      limit: 20,
      offset: 0,
      sort_by: 'created_at',
      viewer_id: null,
    })
    expectPrivateNoStore(anonymous)

    mockGetAuthUser.mockResolvedValueOnce({ id: VIEWER_ID })
    const authenticated = await getHashtagPage(
      tagRequest('?limit=10&offset=2&sort_by=hot_score', { Authorization: 'Bearer valid' }),
      tagParams()
    )
    expect(mockGetPostsByHashtag).toHaveBeenNthCalledWith(2, { marker: 'admin-client' }, 'btc', {
      limit: 10,
      offset: 2,
      sort_by: 'hot_score',
      viewer_id: VIEWER_ID,
    })
    expectPrivateNoStore(authenticated)
  })

  it.each(['', 'Basic token', 'Bearer malformed'])(
    'rejects a supplied invalid credential without querying hashtag data: %p',
    async (authorization) => {
      const response = await getHashtagPage(
        tagRequest('', { Authorization: authorization }),
        tagParams()
      )

      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      expectPrivateNoStore(response)
      expect(mockGetPostsByHashtag).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['?limit=1.5', 'btc'],
    ['?offset=10001', 'btc'],
    ['?sort_by=private_rank', 'btc'],
    ['', 'bad tag!'],
  ])('maps invalid public input to 400 before the RPC: %s / %s', async (query, tag) => {
    const response = await getHashtagPage(tagRequest(query), tagParams(tag))

    expect(response.status).toBe(400)
    expectPrivateNoStore(response)
    expect(mockGetPostsByHashtag).not.toHaveBeenCalled()
  })

  it('uses the authoritative has_more even when a page is full', async () => {
    mockGetPostsByHashtag.mockResolvedValueOnce({
      posts: [{ id: 'post-1' }],
      tag: 'btc',
      total: 1,
      has_more: false,
      next_cursor: null,
    })
    const response = await getHashtagPage(tagRequest('?limit=1'), tagParams())

    await expect(response.json()).resolves.toMatchObject({
      data: { posts: [{ id: 'post-1' }], tag: 'btc', total: 1 },
      meta: { pagination: { limit: 1, offset: 0, has_more: false, total: 1 } },
    })
  })

  it('fails closed and marks dependency errors no-store', async () => {
    mockGetPostsByHashtag.mockRejectedValueOnce(new Error('read authority unavailable'))
    const response = await getHashtagPage(tagRequest(), tagParams())

    expect(response.status).toBe(500)
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { message: 'read authority unavailable' },
    })
  })

  it('maps an atomically rejected stale viewer to refreshable 401', async () => {
    const { HashtagViewerRejectedError } = jest.requireMock<{
      HashtagViewerRejectedError: new () => Error
    }>('@/lib/data/hashtags')
    mockGetAuthUser.mockResolvedValueOnce({ id: VIEWER_ID })
    mockGetPostsByHashtag.mockRejectedValueOnce(new HashtagViewerRejectedError())

    const response = await getHashtagPage(
      tagRequest('', { Authorization: 'Bearer stale-active-cache' }),
      tagParams()
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expectPrivateNoStore(response)
  })

  it('marks rate-limit responses no-store and preserves existing Vary fields', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(
      mockJsonResponse({ success: false, error: 'rate limited' }, 429, { Vary: 'Origin' })
    )
    const response = await getHashtagPage(tagRequest(), tagParams())

    expect(response.status).toBe(429)
    expectPrivateNoStore(response)
    expect(response.headers.get('Vary')).toContain('Origin')
  })
})

describe('GET /api/hashtags/trending', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetSupabaseAdmin.mockReturnValue({ marker: 'admin-client' })
    mockGetAuthUser.mockResolvedValue(null)
    mockGetTrendingHashtags.mockResolvedValue([{ id: 'hashtag-1', tag: 'btc', post_count: 3 }])
  })

  it('always reads the anonymous contract and never replays a server cache', async () => {
    const first = await getTrending(new NextRequest('http://localhost/api/hashtags/trending'))
    const second = await getTrending(new NextRequest('http://localhost/api/hashtags/trending'))

    expect(mockGetTrendingHashtags).toHaveBeenNthCalledWith(1, { marker: 'admin-client' }, 20)
    expect(mockGetTrendingHashtags).toHaveBeenNthCalledWith(2, { marker: 'admin-client' }, 20)
    expectPrivateNoStore(first)
    expectPrivateNoStore(second)
  })

  it('validates a supplied bearer but keeps the trending audience anonymous', async () => {
    mockGetAuthUser.mockResolvedValueOnce({ id: VIEWER_ID })
    const response = await getTrending(
      new NextRequest('http://localhost/api/hashtags/trending', {
        headers: { Authorization: 'Bearer valid' },
      })
    )

    expect(mockGetAuthUser).toHaveBeenCalledTimes(1)
    expect(mockGetTrendingHashtags).toHaveBeenCalledWith({ marker: 'admin-client' }, 20)
    expectPrivateNoStore(response)
  })

  it.each(['', 'Basic token', 'Bearer malformed'])(
    'rejects invalid supplied credentials before reading trending data: %p',
    async (authorization) => {
      const response = await getTrending(
        new NextRequest('http://localhost/api/hashtags/trending', {
          headers: { Authorization: authorization },
        })
      )

      expect(response.status).toBe(401)
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(mockGetTrendingHashtags).not.toHaveBeenCalled()
      expectPrivateNoStore(response)
    }
  )

  it('fails closed and marks a trending RPC error no-store', async () => {
    mockGetTrendingHashtags.mockRejectedValueOnce(new Error('trending authority unavailable'))
    const response = await getTrending(new NextRequest('http://localhost/api/hashtags/trending'))

    expect(response.status).toBe(500)
    expectPrivateNoStore(response)
  })

  it('marks trending rate limits no-store without overwriting Vary', async () => {
    mockCheckRateLimit.mockResolvedValueOnce(
      mockJsonResponse({ success: false, error: 'rate limited' }, 429, { Vary: 'Origin' })
    )

    const response = await getTrending(new NextRequest('http://localhost/api/hashtags/trending'))

    expect(response.status).toBe(429)
    expectPrivateNoStore(response)
    expect(response.headers.get('Vary')).toContain('Origin')
    expect(mockGetTrendingHashtags).not.toHaveBeenCalled()
  })
})
