jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Map()
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockValidateCsrfToken = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockSignOut = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/utils/csrf', () => ({
  CSRF_COOKIE_NAME: 'csrf-cookie',
  CSRF_HEADER_NAME: 'x-csrf-token',
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrfToken(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { DELETE } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'

function request(body: unknown = { all: true }, authorization = 'Bearer exact-access-token') {
  return {
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'authorization') return authorization
        if (name.toLowerCase() === 'x-csrf-token') return 'csrf-value'
        return null
      },
    },
    cookies: { get: () => ({ value: 'csrf-value' }) },
    json: jest.fn().mockResolvedValue(body),
  } as never
}

describe('DELETE /api/settings/sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue({ id: USER_ID })
    mockValidateCsrfToken.mockReturnValue(true)
    mockSignOut.mockResolvedValue({ error: null })
    mockGetSupabaseAdmin.mockReturnValue({
      auth: { admin: { signOut: mockSignOut } },
      from: mockFrom,
    })
  })

  it('revokes real Supabase sessions other than the exact bearer session', async () => {
    const response = await DELETE(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true, revokedOthers: true })
    expect(mockSignOut).toHaveBeenCalledWith('exact-access-token', 'others')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('never reports success when GoTrue rejects session revocation', async () => {
    mockSignOut.mockResolvedValue({ error: { code: 'unexpected_failure' } })

    const response = await DELETE(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to revoke other sessions' })
  })

  it.each([
    [{ sessionId: 'legacy-row' }],
    [{ all: false }],
    [{ all: true, sessionId: 'legacy-row' }],
    [[]],
    [null],
  ])('rejects legacy or ambiguous mutation bodies without fake revocation', async (body) => {
    const response = await DELETE(request(body))

    expect(response.status).toBe(400)
    expect(mockSignOut).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when the active account admission is rejected', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await DELETE(request())

    expect(response.status).toBe(401)
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('requires a valid double-submit CSRF proof before revocation', async () => {
    mockValidateCsrfToken.mockReturnValue(false)

    const response = await DELETE(request())

    expect(response.status).toBe(403)
    expect(mockSignOut).not.toHaveBeenCalled()
  })

  it('requires the exact bearer credential used by active-account admission', async () => {
    const response = await DELETE(request({ all: true }, 'Bearer token with spaces'))

    expect(response.status).toBe(401)
    expect(mockSignOut).not.toHaveBeenCalled()
  })
})
