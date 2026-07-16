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
  filterServiceReadablePostRows: (...args: unknown[]) => mockFilterServiceReadablePostRows(...args),
}))

jest.mock('@/lib/utils/csrf', () => ({
  CSRF_COOKIE_NAME: 'csrf-cookie',
  CSRF_HEADER_NAME: 'x-csrf-token',
  validateCsrfToken: () => true,
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: () => null,
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  apiLogger: { error: jest.fn() },
}))

import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const READABLE_ID = '22222222-2222-4222-8222-222222222222'
const UNREADABLE_ID = '33333333-3333-4333-8333-333333333333'

function request(postIds: unknown): Parameters<typeof POST>[0] {
  return {
    headers: { get: () => 'csrf' },
    cookies: { get: () => ({ value: 'csrf' }) },
    json: async () => ({ postIds }),
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
    expect(body.bookmarks).toEqual({
      [READABLE_ID]: true,
      [UNREADABLE_ID]: false,
    })
  })

  it('does not touch bookmark children when every audience decision fails closed', async () => {
    mockFilterServiceReadablePostRows.mockResolvedValue([])

    const response = await POST(request([READABLE_ID, UNREADABLE_ID]))
    const body = await response.json()

    expect(mockFrom).not.toHaveBeenCalled()
    expect(body.bookmarks).toEqual({
      [READABLE_ID]: false,
      [UNREADABLE_ID]: false,
    })
  })
})
