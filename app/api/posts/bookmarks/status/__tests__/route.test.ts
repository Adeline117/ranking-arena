/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockFilterServiceReadablePostRows = jest.fn()
const mockFrom = jest.fn()
const mockIn = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({ from: (...args: unknown[]) => mockFrom(...args) }),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  filterServiceReadablePostRowsStrict: (...args: unknown[]) =>
    mockFilterServiceReadablePostRows(...args),
}))

jest.mock('@/lib/utils/csrf', () => ({
  CSRF_COOKIE_NAME: 'csrf-cookie',
  CSRF_HEADER_NAME: 'x-csrf-token',
  validateCsrfToken: () => true,
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: () => null,
  RateLimitPresets: { authenticated: {} },
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  apiLogger: { error: jest.fn() },
}))

import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const READABLE_ID = '22222222-2222-4222-8222-222222222222'
const UNREADABLE_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_ID = 'a'.repeat(32)

function request(postIds: unknown): Parameters<typeof POST>[0] {
  return {
    headers: { get: () => 'csrf' },
    cookies: { get: () => ({ value: 'csrf' }) },
    json: async () => ({ postIds, request_id: REQUEST_ID }),
  } as unknown as Parameters<typeof POST>[0]
}

function bodyRequest(body: unknown): Parameters<typeof POST>[0] {
  return {
    headers: { get: () => 'csrf' },
    cookies: { get: () => ({ value: 'csrf' }) },
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0]
}

function invalidJsonRequest(): Parameters<typeof POST>[0] {
  return {
    headers: { get: () => 'csrf' },
    cookies: { get: () => ({ value: 'csrf' }) },
    json: async () => {
      throw new SyntaxError('invalid json')
    },
  } as unknown as Parameters<typeof POST>[0]
}

describe('POST /api/posts/bookmarks/status service audience boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockFilterServiceReadablePostRows.mockResolvedValue([{ id: READABLE_ID }])

    const builder: Record<string, jest.Mock> = {}
    builder.select = jest.fn(() => builder)
    builder.eq = jest.fn(() => builder)
    builder.in = mockIn.mockResolvedValue({ data: [{ post_id: READABLE_ID }], error: null })
    mockFrom.mockReturnValue(builder)
  })

  it('queries bookmark children only for canonically readable posts', async () => {
    const response = await POST(request([READABLE_ID, UNREADABLE_ID]))
    const body = await response.json()

    expect(mockFilterServiceReadablePostRows).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: READABLE_ID }, { id: UNREADABLE_ID }],
      USER_ID
    )
    expect(mockIn).toHaveBeenCalledWith('post_id', [READABLE_ID])
    expect(body).toEqual({
      actor_id: USER_ID,
      request_id: REQUEST_ID,
      operation: 'status',
      post_ids: [READABLE_ID, UNREADABLE_ID],
      bookmarks: {
        [READABLE_ID]: true,
        [UNREADABLE_ID]: false,
      },
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('cdn-cache-control')).toBe('no-store')
    expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store')
  })

  it('does not touch bookmark children when every audience decision fails closed', async () => {
    mockFilterServiceReadablePostRows.mockResolvedValue([])

    const response = await POST(request([READABLE_ID, UNREADABLE_ID]))
    const body = await response.json()

    expect(mockFrom).not.toHaveBeenCalled()
    expect(body).toEqual({
      actor_id: USER_ID,
      request_id: REQUEST_ID,
      operation: 'status',
      post_ids: [READABLE_ID, UNREADABLE_ID],
      bookmarks: {
        [READABLE_ID]: false,
        [UNREADABLE_ID]: false,
      },
    })
  })

  it('returns an error instead of clearing every bookmark on a database failure', async () => {
    mockIn.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'failed' } })

    const response = await POST(request([READABLE_ID]))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ error: 'Failed to load bookmark status' })
    expect(body).not.toHaveProperty('bookmarks')
  })

  it('rejects a null database result without publishing false states', async () => {
    mockIn.mockResolvedValue({ data: null, error: null })

    const response = await POST(request([READABLE_ID]))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).not.toHaveProperty('bookmarks')
  })

  it('returns an error when post audience filtering cannot complete', async () => {
    mockFilterServiceReadablePostRows.mockRejectedValue(new Error('authority failed'))

    const response = await POST(request([READABLE_ID]))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).not.toHaveProperty('bookmarks')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON as a client error', async () => {
    const response = await POST(invalidJsonRequest())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' })
    expect(mockFilterServiceReadablePostRows).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty list', { postIds: [], request_id: REQUEST_ID }],
    ['an invalid post ID', { postIds: ['post-1'], request_id: REQUEST_ID }],
    ['an invalid request nonce', { postIds: [READABLE_ID], request_id: 'bad' }],
    ['an extra request field', { postIds: [READABLE_ID], request_id: REQUEST_ID, extra: true }],
    [
      'more than 100 raw entries',
      { postIds: Array(101).fill(READABLE_ID), request_id: REQUEST_ID },
    ],
  ])('rejects %s without publishing a fake empty snapshot', async (_label, body) => {
    const response = await POST(bodyRequest(body))
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data).toEqual({ error: 'Invalid bookmark status request' })
    expect(data).not.toHaveProperty('bookmarks')
    expect(mockFilterServiceReadablePostRows).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0')
  })

  it('deduplicates canonical post IDs without truncating the acknowledged snapshot', async () => {
    const response = await POST(request([READABLE_ID, READABLE_ID, UNREADABLE_ID]))
    const body = await response.json()

    expect(mockFilterServiceReadablePostRows).toHaveBeenCalledWith(
      expect.anything(),
      [{ id: READABLE_ID }, { id: UNREADABLE_ID }],
      USER_ID
    )
    expect(body.post_ids).toEqual([READABLE_ID, UNREADABLE_ID])
    expect(Object.keys(body.bookmarks)).toEqual([READABLE_ID, UNREADABLE_ID])
  })

  it('fails closed when the database returns a bookmark outside the authorized request', async () => {
    mockIn.mockResolvedValue({ data: [{ post_id: UNREADABLE_ID }], error: null })

    const response = await POST(request([READABLE_ID, UNREADABLE_ID]))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).not.toHaveProperty('bookmarks')
  })
})
